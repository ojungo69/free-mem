/**
 * codemem setup — checkout-pinned editor MCP and hook installation.
 *
 * Replaces Python's install_plugin_cmd + install_mcp_cmd.
 *
 * What it does:
 * 1. Installs a local OpenCode plugin wrapper pinned to this checkout's built CLI
 * 2. Adds/updates the MCP entry in ~/.config/opencode/opencode.jsonc
 * 3. For Claude Code and Codex: installs MCP and hooks pinned to built artifacts
 *
 * Designed to be safe to run repeatedly (idempotent unless --force).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import {
	acquireSpoolLock,
	captureManagedTarget,
	readInstallManifest,
	resolveRuntimeDataDir,
	resolveStorageLayout,
	VERSION,
	writeInstallManifest,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	assertSetupFileMutationAllowed,
	atomicRemoveSetupFile,
	atomicReplaceSetupFile,
	captureSetupFileSnapshots,
	loadJsoncConfig,
	parseObjectJson,
	recordSetupFileMutation,
	resolveOpencodeConfigPath,
	type SetupFileMutation,
	type SetupFileSnapshot,
	setupFileMatchesMutation,
	setupFileSnapshotUnchanged,
	withSetupFileMutationTracking,
	writeJsonConfig,
} from "./setup-config.js";

function opencodeConfigDir(): string {
	return join(homedir(), ".config", "opencode");
}

export function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function claudeMcpConfigPath(): string {
	const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
	return configured ? join(configured, ".claude.json") : join(homedir(), ".claude.json");
}

/** Resolve the Codex home directory, honoring CODEX_HOME. */
export function codexConfigDir(): string {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

const MANAGED_OPENCODE_PLUGIN_SPECS = ["@codemem/opencode-plugin", "codemem", "@kunickiaj/codemem"];
const MANAGED_LEGACY_MCP_SPEC =
	/^(?:codemem(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?|@kunickiaj\/codemem(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?|codemem==[A-Za-z0-9][A-Za-z0-9._+-]*)$/;

export type SetupRuntime = {
	cliPath: string;
	hookRuntimePath: string;
	opencodePluginPath: string;
};

function regularFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Resolve only artifacts built in this checkout. There is deliberately no npm/PATH fallback. */
export function resolveSetupRuntime(): SetupRuntime {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const cliPath = [resolve(moduleDir, "index.js"), resolve(moduleDir, "../../dist/index.js")].find(
		regularFile,
	);
	if (!cliPath) {
		throw new Error("Built CLI runtime not found; run `pnpm run build` before `codemem setup`.");
	}
	const hookRuntimePath = resolve(dirname(cliPath), "hook-runtime.js");
	const opencodePluginPath = resolve(
		dirname(cliPath),
		"../../opencode-plugin/.opencode/plugins/codemem.js",
	);
	if (!regularFile(hookRuntimePath))
		throw new Error(
			`Bundled hook runtime not found at ${hookRuntimePath}; run \`pnpm run build\`.`,
		);
	return { cliPath, hookRuntimePath, opencodePluginPath };
}

function opencodePluginAvailable(runtime: SetupRuntime): boolean {
	const missing = [
		runtime.opencodePluginPath,
		resolve(dirname(runtime.opencodePluginPath), "../lib/compat.js"),
	].find((path) => !regularFile(path));
	if (!missing) return true;
	p.log.error(`OpenCode plugin artifact not found at ${missing}; run \`pnpm run build\`.`);
	return false;
}

function managedMcp(runtime: SetupRuntime): { command: string; args: string[] } {
	return { command: process.execPath, args: [runtime.cliPath, "mcp"] };
}

// ---------------------------------------------------------------------------
// Legacy migration helpers
// ---------------------------------------------------------------------------

/** Remove the obsolete companion file; codemem.js is now the managed local wrapper. */
function migrateLegacyOpencodePlugin(): void {
	const legacyCompat = join(opencodeConfigDir(), "lib", "compat.js");
	if (existsSync(legacyCompat)) {
		try {
			atomicRemoveSetupFile(legacyCompat);
			p.log.step("Removed legacy compat lib: ~/.config/opencode/lib/compat.js");
		} catch {
			// Non-fatal.
		}
	}
}

function managedLegacyPackageSpec(value: unknown): boolean {
	return typeof value === "string" && MANAGED_LEGACY_MCP_SPEC.test(value);
}

function managedLegacyCommand(command: unknown, args?: unknown): boolean {
	const words = Array.isArray(command)
		? command
		: typeof command === "string"
			? [command, ...(Array.isArray(args) ? args : [])]
			: [];
	if (!words.every((word): word is string => typeof word === "string") || words.at(-1) !== "mcp")
		return false;
	const launcher = words[0];
	if (!launcher) return false;
	if (words.length === 2)
		return (
			launcher === "codemem" ||
			(isTransientNpxBinPath(launcher) &&
				/\/codemem(?:\.cmd)?$/.test(launcher.replaceAll("\\", "/")))
		);
	if (
		words.length === 3 &&
		/(?:^|\/)node(?:\.exe)?$/.test(launcher.replaceAll("\\", "/")) &&
		words[1]?.replaceAll("\\", "/").endsWith("/packages/cli/dist/index.js")
	)
		return true;
	if (launcher === "uvx") return words.length === 3 && managedLegacyPackageSpec(words[1]);
	if (launcher === "uv") {
		return (
			(words.length === 4 && words[1] === "run" && managedLegacyPackageSpec(words[2])) ||
			(words.length === 5 &&
				words[1] === "tool" &&
				words[2] === "run" &&
				managedLegacyPackageSpec(words[3]))
		);
	}
	if (launcher !== "npx") return false;
	const npxArgs =
		words[1] === "-y" || words[1] === "--yes" ? words.slice(2, -1) : words.slice(1, -1);
	if (npxArgs.length === 1) return managedLegacyPackageSpec(npxArgs[0]);
	if (npxArgs.length === 3 && ["-p", "--package"].includes(npxArgs[0] ?? ""))
		return managedLegacyPackageSpec(npxArgs[1]) && npxArgs[2] === "codemem";
	if (npxArgs.length === 2 && /^(?:-p|--package)=/.test(npxArgs[0] ?? ""))
		return (
			managedLegacyPackageSpec(npxArgs[0]?.slice(npxArgs[0].indexOf("=") + 1)) &&
			npxArgs[1] === "codemem"
		);
	return false;
}

// Keep source offsets stable while hiding string/comment data and recording
// only depth-zero logical lines that can define TOML keys or tables.
interface TomlStructure {
	text: string;
	topLevelLines: number[];
	tableStarts: number[];
}

function isTomlTableHeader(header: string): boolean {
	const arrayTable = header.startsWith("[[");
	const bodyStart = arrayTable ? 2 : 1;
	let quote: '"' | "'" | null = null;
	for (let i = bodyStart; i < header.length; i += 1) {
		const char = header[i] ?? "";
		if (quote === '"' && char === "\\") {
			i += 1;
			continue;
		}
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char !== "]") continue;
		if (header.slice(bodyStart, i).trim() === "") return false;
		const end = arrayTable ? i + 2 : i + 1;
		if (arrayTable && header[i + 1] !== "]") return false;
		return header.slice(end).trim() === "";
	}
	return false;
}

function scanTomlStructure(source: string): TomlStructure | null {
	type State = "code" | "comment" | "basic" | "literal" | "multiline-basic" | "multiline-literal";
	let state: State = "code";
	let masked = "";
	let arrayDepth = 0;
	let inlineTableDepth = 0;
	let lineStart = 0;
	let lineHasCode = false;
	let tableLine = false;
	const topLevelLines: number[] = [];
	const tableStarts: number[] = [];
	const blank = (char: string): string => (char === "\n" || char === "\r" ? char : " ");

	for (let i = 0; i < source.length; ) {
		const char = source[i] ?? "";
		const startsLine = !lineHasCode;
		if (char === "\n") {
			lineStart = i + 1;
			lineHasCode = false;
			tableLine = false;
		} else if (char !== "\r" && char !== " " && char !== "\t") {
			lineHasCode = true;
		}
		if (state === "comment") {
			masked += blank(char);
			if (char === "\n") state = "code";
			i += 1;
			continue;
		}
		if (state === "multiline-basic" || state === "multiline-literal") {
			const quote = state === "multiline-basic" ? '"' : "'";
			let quoteCount = 0;
			while (source[i + quoteCount] === quote) quoteCount += 1;
			if (quoteCount >= 3) {
				if (quoteCount > 5) return null;
				masked += " ".repeat(quoteCount);
				i += quoteCount;
				state = "code";
				continue;
			}
			masked += blank(char);
			i += 1;
			if (state === "multiline-basic" && char === "\\" && i < source.length) {
				const escaped = source[i] ?? "";
				masked += blank(escaped);
				if (escaped === "\n") {
					lineStart = i + 1;
					lineHasCode = false;
					tableLine = false;
				}
				i += 1;
			}
			continue;
		}
		if (state === "basic" || state === "literal") {
			if (char === "\n" || char === "\r") return null;
			masked += char;
			i += 1;
			if (state === "basic" && char === "\\" && i < source.length) {
				const escaped = source[i] ?? "";
				if (escaped === "\n" || escaped === "\r") return null;
				masked += escaped;
				i += 1;
			} else if ((state === "basic" && char === '"') || (state === "literal" && char === "'")) {
				state = "code";
			}
			continue;
		}
		if (char === "#") {
			masked += " ";
			state = "comment";
			i += 1;
		} else if (source.startsWith('"""', i) || source.startsWith("'''", i)) {
			state = source.startsWith('"""', i) ? "multiline-basic" : "multiline-literal";
			masked += "   ";
			i += 3;
		} else {
			if (
				startsLine &&
				char !== "\n" &&
				char !== "\r" &&
				char !== " " &&
				char !== "\t" &&
				arrayDepth === 0 &&
				inlineTableDepth === 0
			) {
				topLevelLines.push(lineStart);
				if (char === "[") {
					tableStarts.push(lineStart);
					tableLine = true;
				}
			}
			masked += char;
			if (char === '"') state = "basic";
			else if (char === "'") state = "literal";
			else if (!tableLine && char === "[") arrayDepth += 1;
			else if (!tableLine && char === "]") {
				if (arrayDepth === 0) return null;
				arrayDepth -= 1;
			} else if (!tableLine && char === "{") inlineTableDepth += 1;
			else if (!tableLine && char === "}") {
				if (inlineTableDepth === 0) return null;
				inlineTableDepth -= 1;
			}
			i += 1;
		}
	}

	if ((state !== "code" && state !== "comment") || arrayDepth !== 0 || inlineTableDepth !== 0) {
		return null;
	}
	for (const start of tableStarts) {
		const newline = masked.indexOf("\n", start);
		const header = masked.slice(start, newline < 0 ? masked.length : newline).trim();
		if (!isTomlTableHeader(header)) return null;
	}
	return { text: masked, topLevelLines, tableStarts };
}

function matchingTomlLines(
	structure: TomlStructure,
	pattern: RegExp,
	starts: number[] = structure.topLevelLines,
	before = structure.text.length,
): number[] {
	return starts.filter((start) => {
		if (start >= before) return false;
		return pattern.test(tomlLineAt(structure, start));
	});
}

function tomlLineAt(structure: TomlStructure, start: number): string {
	const newline = structure.text.indexOf("\n", start);
	const end = newline < 0 ? structure.text.length : newline;
	const line = structure.text.slice(start, end);
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function tomlKeyHasBasicEscape(line: string): boolean {
	const table = line.trimStart().startsWith("[");
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i] ?? "";
		if (quote === '"' && char === "\\") return true;
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (!table && char === "=") return false;
	}
	return false;
}

function isSingleInlineTableAssignment(line: string): boolean {
	let quote: '"' | "'" | null = null;
	let valueStart = -1;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i] ?? "";
		if (quote === '"' && char === "\\") {
			i += 1;
			continue;
		}
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "=") {
			valueStart = i + 1;
			break;
		}
	}
	while (line[valueStart] === " " || line[valueStart] === "\t") valueStart += 1;
	if (valueStart < 0 || line[valueStart] !== "{") return false;
	let depth = 0;
	quote = null;
	for (let i = valueStart; i < line.length; i += 1) {
		const char = line[i] ?? "";
		if (quote === '"' && char === "\\") {
			i += 1;
			continue;
		}
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "{") depth += 1;
		else if (char === "}" && --depth === 0) return line.slice(i + 1).trim() === "";
	}
	return false;
}

function parseCodexMcpCommand(block: string): { command: string; args: string[] } | null {
	const structure = scanTomlStructure(block);
	if (structure === null) return null;
	const commandSource = /^\s*command\s*=\s*("(?:\\.|[^"\\])*")\s*$/m.exec(structure.text)?.[1];
	const argsSource = /^\s*args\s*=\s*\[([\s\S]*?)\]\s*$/m.exec(structure.text)?.[1];
	if (!commandSource || argsSource === undefined) return null;
	const stringSources = argsSource.match(/"(?:\\.|[^"\\])*"/g) ?? [];
	if (argsSource.replace(/"(?:\\.|[^"\\])*"/g, "").replace(/[\s,]/g, "") !== "") return null;
	try {
		return {
			command: JSON.parse(commandSource),
			args: stringSources.map((source) => JSON.parse(source)),
		};
	} catch {
		return null;
	}
}

function managedLegacyCodexBlock(block: string): boolean {
	const parsed = parseCodexMcpCommand(block);
	return parsed !== null && managedLegacyCommand(parsed.command, parsed.args);
}

function sameCodexMcpBlock(block: string, runtime: SetupRuntime): boolean {
	return block === codexMcpBlock(runtime);
}

function sameManagedMcpCommand(entry: unknown, runtime: SetupRuntime): boolean {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	const value = entry as { command?: unknown; args?: unknown };
	const expected = managedMcp(runtime);
	return (
		(value.command === expected.command &&
			JSON.stringify(value.args) === JSON.stringify(expected.args)) ||
		JSON.stringify(value.command) === JSON.stringify([expected.command, ...expected.args])
	);
}

function sameOpencodeMcp(entry: unknown, runtime: SetupRuntime): boolean {
	if (!sameManagedMcpCommand(entry, runtime)) return false;
	const value = entry as { type?: unknown; enabled?: unknown };
	return value.type === "local" && value.enabled === true;
}

function managedMcpReplacementAllowed(
	entry: unknown,
	force: boolean,
	runtime: SetupRuntime,
	exact: (entry: unknown, runtime: SetupRuntime) => boolean,
): boolean {
	if (entry === undefined || force || exact(entry, runtime)) return true;
	return (
		entry !== null &&
		typeof entry === "object" &&
		!Array.isArray(entry) &&
		managedLegacyCommand(
			(entry as { command?: unknown }).command,
			(entry as { args?: unknown }).args,
		)
	);
}

function renderOpencodeWrapper(
	pluginUrl: string,
	runner: string,
	cliPath: string,
	marked: boolean,
): string {
	return `${marked ? "// codemem setup-managed wrapper\n" : ""}import plugin from ${JSON.stringify(pluginUrl)};

async function codememManagedPlugin(context) {
	const previousRunner = process.env.CODEMEM_RUNNER;
	const previousRunnerFrom = process.env.CODEMEM_RUNNER_FROM;
	process.env.CODEMEM_RUNNER = ${JSON.stringify(runner)};
	process.env.CODEMEM_RUNNER_FROM = ${JSON.stringify(cliPath)};
	try {
		return await plugin(context);
	} finally {
		if (previousRunner === undefined) delete process.env.CODEMEM_RUNNER;
		else process.env.CODEMEM_RUNNER = previousRunner;
		if (previousRunnerFrom === undefined) delete process.env.CODEMEM_RUNNER_FROM;
		else process.env.CODEMEM_RUNNER_FROM = previousRunnerFrom;
	}
}

export { codememManagedPlugin as default, codememManagedPlugin as OpencodeMemPlugin };
`;
}

function opencodeWrapper(runtime: SetupRuntime): string {
	return renderOpencodeWrapper(
		pathToFileURL(runtime.opencodePluginPath).href,
		process.execPath,
		runtime.cliPath,
		true,
	);
}

function knownLegacyOpencodeWrapper(content: string): boolean {
	const plugin = /^import plugin from (.+);$/m.exec(content)?.[1];
	const cli = /^\s*process\.env\.CODEMEM_RUNNER_FROM = (.+);$/m.exec(content)?.[1];
	if (!plugin || !cli) return false;
	try {
		const pluginUrl = JSON.parse(plugin) as unknown;
		const cliPath = JSON.parse(cli) as unknown;
		return (
			typeof pluginUrl === "string" &&
			typeof cliPath === "string" &&
			content === renderOpencodeWrapper(pluginUrl, "node", cliPath, false)
		);
	} catch {
		return false;
	}
}

function manifestOwnsTarget(id: string, path: string, fingerprint: string): boolean {
	const manifestPath = resolveStorageLayout(setupDataDir()).installManifestPath;
	if (!existsSync(manifestPath)) return false;
	try {
		const expected = readInstallManifest(manifestPath).targets?.find(
			(target) => target.id === id && resolve(target.path) === resolve(path),
		);
		return expected?.fingerprint === fingerprint;
	} catch {
		return false;
	}
}

function approvedOpencodeWrapperSnapshot(
	force: boolean,
	runtime: SetupRuntime,
): SetupFileSnapshot | null {
	const target = join(opencodeConfigDir(), "plugins", "codemem.js");
	const content = opencodeWrapper(runtime);
	let snapshot: SetupFileSnapshot;
	try {
		const captured = captureSetupFileSnapshots([target])[0];
		if (!captured) return null;
		snapshot = captured;
	} catch (error) {
		p.log.error(
			`Failed to inspect the OpenCode plugin wrapper at ${target}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
	if (snapshot.contents === null) return snapshot;
	const current = Buffer.from(snapshot.contents);
	if (
		current.toString("utf8") === content ||
		force ||
		knownLegacyOpencodeWrapper(current.toString("utf8")) ||
		manifestOwnsTarget(
			"opencode-plugin",
			target,
			createHash("sha256").update(current).digest("hex"),
		)
	) {
		return snapshot;
	}
	p.log.error(
		`Refusing to replace an unmanaged OpenCode plugin wrapper at ${target}; use --force.`,
	);
	return null;
}

function opencodeWrapperReplacementAllowed(force: boolean, runtime: SetupRuntime): boolean {
	return approvedOpencodeWrapperSnapshot(force, runtime) !== null;
}

function installOpencodeWrapper(force: boolean, runtime: SetupRuntime): boolean {
	const target = join(opencodeConfigDir(), "plugins", "codemem.js");
	const content = opencodeWrapper(runtime);
	const snapshot = approvedOpencodeWrapperSnapshot(force, runtime);
	if (snapshot === null) return false;
	try {
		if (!setupFileSnapshotUnchanged(snapshot)) {
			throw new Error(`OpenCode plugin wrapper changed before replacement: ${target}`);
		}
		if (snapshot.contents !== null) {
			if (Buffer.from(snapshot.contents).toString("utf8") === content) return true;
			atomicReplaceSetupFile(`${target}.codemem.bak`, snapshot.contents);
		}
		if (!setupFileSnapshotUnchanged(snapshot)) {
			throw new Error(`OpenCode plugin wrapper changed before replacement: ${target}`);
		}
		atomicReplaceSetupFile(target, content, snapshot.mode, snapshot.contents === null, snapshot);
		p.log.success(`Local OpenCode plugin installed: ${target}`);
		return true;
	} catch (error) {
		p.log.error(
			`Failed to install the local OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Install functions
// ---------------------------------------------------------------------------

export function installPlugin(
	force: boolean,
	runtime: SetupRuntime = resolveSetupRuntime(),
	configPath: string = resolveOpencodeConfigPath(opencodeConfigDir()),
): boolean {
	if (!opencodePluginAvailable(runtime)) return false;
	if (!opencodeWrapperReplacementAllowed(force, runtime)) return false;
	// Clean up legacy copied plugin files first.
	migrateLegacyOpencodePlugin();

	let config: Record<string, unknown>;
	try {
		config = loadJsoncConfig(configPath);
	} catch (err) {
		p.log.error(
			`Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	let plugins = config.plugin as unknown;
	if (!Array.isArray(plugins)) {
		plugins = [];
	}

	const isManagedPluginSpec = (entry: unknown): entry is string =>
		typeof entry === "string" &&
		MANAGED_OPENCODE_PLUGIN_SPECS.some((spec) => entry === spec || entry.startsWith(`${spec}@`));
	const filtered = (plugins as string[]).filter((entry) => !isManagedPluginSpec(entry));
	const changed = force || filtered.length !== (plugins as string[]).length;
	if (filtered.length > 0) config.plugin = filtered;
	else delete config.plugin;

	if (changed) {
		try {
			writeJsonConfig(configPath, config);
		} catch (err) {
			p.log.error(
				`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}
	return installOpencodeWrapper(force, runtime);
}

export function installMcp(
	force: boolean,
	runtime: SetupRuntime = resolveSetupRuntime(),
	configPath: string = resolveOpencodeConfigPath(opencodeConfigDir()),
): boolean {
	let config: Record<string, unknown>;
	try {
		config = loadJsoncConfig(configPath);
	} catch (err) {
		p.log.error(
			`Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	let mcpConfig = config.mcp as Record<string, unknown> | undefined;
	if (mcpConfig == null || typeof mcpConfig !== "object" || Array.isArray(mcpConfig)) {
		mcpConfig = {};
	}

	const current = mcpConfig.codemem;
	if (sameOpencodeMcp(current, runtime) && !force) {
		p.log.info(`MCP entry already uses the managed runtime in ${configPath}`);
		return true;
	}
	if (!managedMcpReplacementAllowed(current, force, runtime, sameOpencodeMcp)) {
		p.log.error(`Refusing to replace a custom codemem MCP entry in ${configPath}; use --force.`);
		return false;
	}
	mcpConfig.codemem = {
		type: "local",
		command: [process.execPath, runtime.cliPath, "mcp"],
		enabled: true,
	};
	config.mcp = mcpConfig;

	try {
		writeJsonConfig(configPath, config);
		p.log.success(`MCP entry installed: ${configPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	return true;
}

// ---------------------------------------------------------------------------
// Codex install (direct config files — no marketplace plugin required)
// ---------------------------------------------------------------------------

/** The MCP server table appended to Codex config.toml. */
function codexMcpBlock(runtime: SetupRuntime): string {
	return [
		"[mcp_servers.codemem]",
		`command = ${JSON.stringify(process.execPath)}`,
		`args = [${JSON.stringify(runtime.cliPath)}, "mcp"]`,
		"startup_timeout_sec = 30",
		"tool_timeout_sec = 60",
	].join("\n");
}

// Detect an existing codemem MCP table in config.toml text. Tolerates TOML
// whitespace around brackets/dots and a quoted key, and avoids false-matching
// sibling tables like `[mcp_servers.codemem-foo]` (optional quotes are matched
// symmetrically via backreferences, so `codemem` must be followed by `]`).
const CODEX_MCP_TABLE_RE =
	/^[ \t]*\[[ \t]*(["']?)mcp_servers\1[ \t]*\.[ \t]*(["']?)codemem\2[ \t]*\]/m;
const CODEX_MCP_DESCENDANT_TABLE_RE =
	/^[ \t]*\[[ \t]*(["']?)mcp_servers\1[ \t]*\.[ \t]*(["']?)codemem\2[ \t]*\./m;
const CODEX_MCP_ARRAY_TABLE_RE =
	/^[ \t]*\[\[[ \t]*(["']?)mcp_servers\1[ \t]*\.[ \t]*(["']?)codemem\2(?:[ \t]*\.|[ \t]*\]\])/m;
const CODEX_MCP_DOTTED_KEY_RE = /^[ \t]*(["']?)mcp_servers\1[ \t]*\.[ \t]*(["']?)codemem\2[ \t]*=/m;
const CODEX_MCP_DESCENDANT_RE =
	/^[ \t]*(["']?)mcp_servers\1[ \t]*\.[ \t]*(["']?)codemem\2[ \t]*\./m;
const CODEX_MCP_ROOT_ASSIGNMENT_RE = /^[ \t]*(["']?)mcp_servers\1[ \t]*=/m;
const CODEX_MCP_PARENT_ARRAY_TABLE_RE = /^[ \t]*\[\[[ \t]*(["']?)mcp_servers\1[ \t]*\]\][ \t]*$/m;
const CODEX_MCP_PARENT_TABLE_RE = /^[ \t]*\[[ \t]*(["']?)mcp_servers\1[ \t]*\][ \t]*(?:#.*)?$/m;
const CODEX_MCP_PARENT_CHILD_RE = /^[ \t]*(["']?)codemem\1[ \t]*(?:=|\.)/m;

function hasUnsupportedCodexMcpLayout(existing: string): boolean {
	const structure = scanTomlStructure(existing);
	if (structure === null) return true;
	if (
		structure.topLevelLines.some((start) => tomlKeyHasBasicEscape(tomlLineAt(structure, start)))
	) {
		return true;
	}
	const tables = matchingTomlLines(structure, CODEX_MCP_TABLE_RE, structure.tableStarts);
	const firstTable = structure.tableStarts[0] ?? structure.text.length;
	const dottedKeys = matchingTomlLines(
		structure,
		CODEX_MCP_DOTTED_KEY_RE,
		structure.topLevelLines,
		firstTable,
	);
	if (
		tables.length > 1 ||
		dottedKeys.length > 1 ||
		tables.length + dottedKeys.length > 1 ||
		matchingTomlLines(structure, CODEX_MCP_DESCENDANT_TABLE_RE, structure.tableStarts).length > 0 ||
		matchingTomlLines(structure, CODEX_MCP_ARRAY_TABLE_RE, structure.tableStarts).length > 0 ||
		matchingTomlLines(structure, CODEX_MCP_DESCENDANT_RE, structure.topLevelLines, firstTable)
			.length > 0 ||
		matchingTomlLines(structure, CODEX_MCP_ROOT_ASSIGNMENT_RE, structure.topLevelLines, firstTable)
			.length > 0 ||
		matchingTomlLines(structure, CODEX_MCP_PARENT_ARRAY_TABLE_RE, structure.tableStarts).length > 0
	) {
		return true;
	}
	if (dottedKeys.length === 1) {
		const start = dottedKeys[0] ?? 0;
		if (!isSingleInlineTableAssignment(tomlLineAt(structure, start))) {
			return true;
		}
	}
	const parents = matchingTomlLines(structure, CODEX_MCP_PARENT_TABLE_RE, structure.tableStarts);
	if (parents.length > 1) return true;
	const parent = parents[0];
	if (parent === undefined) return false;
	const nextTable = structure.tableStarts.find((start) => start > parent) ?? structure.text.length;
	if (
		matchingTomlLines(
			structure,
			CODEX_MCP_PARENT_CHILD_RE,
			structure.topLevelLines,
			nextTable,
		).some((start) => start > parent)
	) {
		return true;
	}
	return false;
}

function codexMcpTable(existing: string): { start: number; end: number; block: string } | null {
	const structure = scanTomlStructure(existing);
	if (structure === null) return null;
	const table = matchingTomlLines(structure, CODEX_MCP_TABLE_RE, structure.tableStarts)[0];
	if (table !== undefined) {
		const nextTable = structure.tableStarts.find((start) => start > table) ?? structure.text.length;
		let end = table;
		for (const match of existing.slice(table, nextTable).matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
			const line = match[0];
			if (line.length === 0 || /^[ \t]*(?:#.*)?(?:\r\n|\r|\n)?$/.test(line)) continue;
			end = table + match.index + line.length;
		}
		return { start: table, end, block: existing.slice(table, end).trim() };
	}
	const firstTable = structure.tableStarts[0] ?? structure.text.length;
	const dotted = matchingTomlLines(
		structure,
		CODEX_MCP_DOTTED_KEY_RE,
		structure.topLevelLines,
		firstTable,
	)[0];
	if (dotted === undefined || !isSingleInlineTableAssignment(tomlLineAt(structure, dotted))) {
		return null;
	}
	const newline = structure.text.indexOf("\n", dotted);
	const end = newline < 0 ? structure.text.length : newline;
	return {
		start: dotted,
		end,
		block: existing.slice(dotted, end).trim(),
	};
}

/** A single Codex command-hook entry. */
interface HookCommand {
	type: "command";
	command: string;
	timeout: number;
	statusMessage?: string;
}

/** A matcher group containing an ordered list of command hooks. */
interface HookGroup {
	matcher?: string;
	hooks: HookCommand[];
}

/** Marker substring identifying codemem-owned hook commands. */
const CODEMEM_HOOK_MARKERS = ["codemem codex-hook-", "codemem claude-hook-"];
const CODEMEM_RUNTIME_HOOK_MARKER = "codemem-hook-runtime.mjs";

/**
 * Quote the installed standalone runtime for Codex's shell command field.
 */
export function codememCodexHookBase(
	runtimePath?: string | null,
	nodePath: string = process.execPath,
): string {
	if (!runtimePath) throw new Error("The managed Codex hook runtime is required.");
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	return `${quote(nodePath)} ${quote(runtimePath)}`;
}

function installHookRuntime(configDir: string, source: string, label: string): string | null {
	if (!existsSync(source)) return null;
	const target = join(configDir, "codemem-hook-runtime.mjs");
	try {
		atomicReplaceSetupFile(target, readFileSync(source), 0o600);
		return target;
	} catch {
		p.log.error(`Failed to install the bundled ${label} hook runtime at ${target}`);
		return null;
	}
}

export function installCodexHookRuntime(
	codexHome: string,
	source = resolveSetupRuntime().hookRuntimePath,
): string | null {
	return installHookRuntime(codexHome, source, "Codex");
}

/**
 * Build the codemem-owned hook groups keyed by Codex event name, given the
 * resolved standalone command base. Every hook is bounded by the same outer
 * watchdog; the thin client owns the shorter RPC cutoff.
 */
export function buildCodememCodexHookGroups(base: string): Record<string, HookGroup[]> {
	const timeout = 5;
	const ingest: HookCommand = {
		type: "command",
		command: `${base} codex-hook-ingest`,
		timeout,
		statusMessage: "codemem",
	};
	return {
		SessionStart: [{ hooks: [{ ...ingest }] }],
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: `${base} codex-hook-inject`,
						timeout,
						statusMessage: "codemem recall",
					},
				],
			},
		],
		PostToolUse: [{ hooks: [{ ...ingest }] }],
		Stop: [{ hooks: [{ ...ingest }] }],
		SessionEnd: [{ hooks: [{ ...ingest }] }],
	};
}

export function buildCodememClaudeHookGroups(base: string): Record<string, HookGroup[]> {
	const timeout = 3;
	const ingest: HookCommand = {
		type: "command",
		command: `${base} claude-hook-ingest`,
		timeout,
	};
	return {
		SessionStart: [{ hooks: [{ ...ingest }] }],
		UserPromptSubmit: [
			{
				hooks: [{ type: "command", command: `${base} claude-hook-inject`, timeout }],
			},
		],
		PreToolUse: [
			{
				matcher: "Read",
				hooks: [{ type: "command", command: `${base} claude-hook-file-context`, timeout }],
			},
		],
		PostToolUse: [{ hooks: [{ ...ingest }] }],
		PostToolUseFailure: [{ hooks: [{ ...ingest }] }],
		Stop: [{ hooks: [{ ...ingest }] }],
		SessionEnd: [{ hooks: [{ ...ingest }] }],
	};
}

function isCodememHook(hook: unknown): boolean {
	if (hook == null || typeof hook !== "object") return false;
	const command = (hook as { command?: unknown }).command;
	return (
		typeof command === "string" &&
		(CODEMEM_HOOK_MARKERS.some((marker) => command.includes(marker)) ||
			command.includes(CODEMEM_RUNTIME_HOOK_MARKER))
	);
}

/** Remove only managed hook entries, preserving the matcher and unrelated siblings. */
function withoutCodememHooks(group: unknown): unknown | null {
	if (group == null || typeof group !== "object") return group;
	const hooks = (group as { hooks?: unknown }).hooks;
	if (!Array.isArray(hooks)) return group;
	const preserved = hooks.filter((hook) => !isCodememHook(hook));
	if (preserved.length === hooks.length) return group;
	if (preserved.length === 0) return null;
	return { ...group, hooks: preserved };
}

/**
 * True if a legacy command points into a transient npx/dlx cache bin.
 */
export function isTransientNpxBinPath(resolved: string): boolean {
	return /[/\\]_npx[/\\]/.test(resolved) || /[/\\]\.pnpm[/\\]dlx[/\\]/.test(resolved);
}

/**
 * Append the codemem MCP server table to Codex config.toml without rewriting
 * unrelated content. Returns true on success.
 */
function installCodexMcp(codexHome: string, force: boolean, runtime: SetupRuntime): boolean {
	const configPath = join(codexHome, "config.toml");
	const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
	const block = codexMcpBlock(runtime);
	const currentTable = codexMcpTable(existing);
	if (hasUnsupportedCodexMcpLayout(existing)) {
		p.log.error(
			`Refusing to replace an unsupported codemem MCP layout in ${configPath}; normalize or remove it first.`,
		);
		return false;
	}
	let next = existing;
	if (currentTable) {
		const current = currentTable.block;
		if (sameCodexMcpBlock(current, runtime)) {
			p.log.info(`Codex MCP entry already uses the managed runtime in ${configPath}`);
			return true;
		}
		if (!force && !managedLegacyCodexBlock(current)) {
			p.log.error(`Refusing to replace a custom codemem MCP entry in ${configPath}; use --force.`);
			return false;
		}
		next = `${existing.slice(0, currentTable.start)}${block}\n${existing.slice(currentTable.end)}`;
	} else {
		if (next.length > 0 && !next.endsWith("\n\n")) {
			next += next.endsWith("\n") ? "\n" : "\n\n";
		}
		next += `${block}\n`;
	}

	// Back up an existing file before changing the managed table.
	if (existsSync(configPath)) {
		try {
			atomicReplaceSetupFile(`${configPath}.codemem.bak`, readFileSync(configPath));
		} catch {
			// Non-fatal: continue without a backup rather than blocking install.
		}
	}

	try {
		atomicReplaceSetupFile(configPath, next);
		p.log.success(`Codex MCP entry installed: ${configPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

/**
 * Merge codemem hook registrations while preserving unrelated user groups.
 */
function mergeCodememHookGroups(
	config: Record<string, unknown>,
	ours: Record<string, HookGroup[]>,
): boolean {
	let hooks = config.hooks as Record<string, unknown> | undefined;
	if (hooks == null || typeof hooks !== "object" || Array.isArray(hooks)) {
		hooks = {};
	}
	let changed = false;
	for (const [event, ourGroups] of Object.entries(ours)) {
		const current = hooks[event];
		const existingGroups: unknown[] = Array.isArray(current) ? [...current] : [];
		// Drop only codemem-owned groups; preserve unrelated user hooks.
		const preserved = existingGroups
			.map(withoutCodememHooks)
			.filter((group): group is unknown => group !== null);
		const desired = [...preserved, ...ourGroups];
		if (JSON.stringify(existingGroups) === JSON.stringify(desired)) continue;
		hooks[event] = desired;
		changed = true;
	}
	config.hooks = hooks;
	return changed;
}

/**
 * Write/merge codemem hook registrations into Codex hooks.json, preserving any
 * unrelated user hooks. Returns true on success.
 */
function installCodexHooks(
	codexHome: string,
	_force: boolean,
	runtimePath: string | null = null,
): boolean {
	const hooksPath = join(codexHome, "hooks.json");

	let config: Record<string, unknown> = {};
	if (existsSync(hooksPath)) {
		try {
			config = parseObjectJson(readFileSync(hooksPath, "utf-8"));
		} catch (err) {
			p.log.error(
				`Failed to parse ${hooksPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			p.log.info(
				`Leaving ${hooksPath} untouched. Fix or remove the file, then re-run \`codemem setup --codex-only\`.`,
			);
			return false;
		}
	}

	const changed = mergeCodememHookGroups(
		config,
		buildCodememCodexHookGroups(codememCodexHookBase(runtimePath)),
	);

	if (!changed) {
		p.log.info(`Codex hooks already configured in ${hooksPath}`);
		return true;
	}

	// Back up an existing hooks.json before overwriting.
	if (existsSync(hooksPath)) {
		try {
			atomicReplaceSetupFile(`${hooksPath}.codemem.bak`, readFileSync(hooksPath));
		} catch {
			// Non-fatal.
		}
	}

	try {
		atomicReplaceSetupFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
		p.log.success(`Codex hooks installed: ${hooksPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${hooksPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

const CLAUDE_PLUGIN_ID = "codemem@codemem-marketplace";

function loadClaudeConfiguration(
	force: boolean,
	runtime: SetupRuntime,
): {
	settingsPath: string;
	settings: Record<string, unknown>;
	mcpPath: string;
	mcpConfig: Record<string, unknown>;
} | null {
	const settingsPath = join(claudeConfigDir(), "settings.json");
	let settings: Record<string, unknown>;
	try {
		settings = loadJsoncConfig(settingsPath);
	} catch (error) {
		p.log.error(
			`Failed to parse ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		p.log.info(
			`Leaving ${settingsPath} untouched. Fix or remove the file, then re-run \`codemem setup --claude-only\`.`,
		);
		return null;
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		p.log.error(`Refusing to replace malformed settings in ${settingsPath}.`);
		return null;
	}
	const legacyMcpServers = settings.mcpServers;
	if (
		legacyMcpServers !== undefined &&
		(legacyMcpServers === null ||
			typeof legacyMcpServers !== "object" ||
			Array.isArray(legacyMcpServers))
	) {
		p.log.error(`Refusing to replace malformed mcpServers in ${settingsPath}.`);
		return null;
	}
	if (
		!managedMcpReplacementAllowed(
			(legacyMcpServers as Record<string, unknown> | undefined)?.codemem,
			force,
			runtime,
			sameManagedMcpCommand,
		)
	) {
		p.log.error(`Refusing to migrate a custom codemem MCP entry in ${settingsPath}; use --force.`);
		return null;
	}

	const mcpPath = claudeMcpConfigPath();
	let mcpConfig: Record<string, unknown>;
	try {
		mcpConfig = loadJsoncConfig(mcpPath);
	} catch {
		p.log.error(`Failed to parse ${mcpPath}; configuration contents were not logged.`);
		p.log.info(
			`Leaving ${mcpPath} untouched. Fix or remove the file, then re-run \`codemem setup --claude-only\`.`,
		);
		return null;
	}
	if (!mcpConfig || typeof mcpConfig !== "object" || Array.isArray(mcpConfig)) {
		p.log.error(`Refusing to replace malformed state in ${mcpPath}.`);
		return null;
	}

	const existingMcpServers = mcpConfig.mcpServers;
	if (
		existingMcpServers !== undefined &&
		(existingMcpServers === null ||
			typeof existingMcpServers !== "object" ||
			Array.isArray(existingMcpServers))
	) {
		p.log.error(`Refusing to replace malformed mcpServers in ${mcpPath}.`);
		return null;
	}
	const mcpServers = (existingMcpServers ?? {}) as Record<string, unknown>;
	if (!managedMcpReplacementAllowed(mcpServers.codemem, force, runtime, sameManagedMcpCommand)) {
		p.log.error(`Refusing to replace a custom codemem MCP entry in ${mcpPath}; use --force.`);
		return null;
	}

	const hooks = settings.hooks;
	if (
		hooks !== undefined &&
		(hooks === null || typeof hooks !== "object" || Array.isArray(hooks))
	) {
		p.log.error(`Refusing to replace malformed hooks in ${settingsPath}.`);
		return null;
	}
	if (hooks && typeof hooks === "object") {
		for (const event of Object.keys(buildCodememClaudeHookGroups("managed-runtime"))) {
			const groups = (hooks as Record<string, unknown>)[event];
			if (groups !== undefined && !Array.isArray(groups)) {
				p.log.error(`Refusing to replace malformed ${event} hooks in ${settingsPath}.`);
				return null;
			}
		}
	}

	return { settingsPath, settings, mcpPath, mcpConfig };
}

/** Configure Claude MCP and hooks directly from this checkout. */
export function installClaude(
	force: boolean,
	runtime: SetupRuntime = resolveSetupRuntime(),
): boolean {
	const prepared = loadClaudeConfiguration(force, runtime);
	if (!prepared) return false;

	const runtimePath = installHookRuntime(claudeConfigDir(), runtime.hookRuntimePath, "Claude");
	if (!runtimePath) return false;

	const { settingsPath, settings, mcpPath, mcpConfig } = prepared;
	const beforeSettings = JSON.stringify(settings);
	const beforeMcp = JSON.stringify(mcpConfig);
	const staleSettingsMcp = settings.mcpServers;
	if (
		staleSettingsMcp &&
		typeof staleSettingsMcp === "object" &&
		!Array.isArray(staleSettingsMcp)
	) {
		const staleServers = staleSettingsMcp as Record<string, unknown>;
		if (staleServers.codemem !== undefined) {
			delete staleServers.codemem;
			if (Object.keys(staleServers).length === 0) delete settings.mcpServers;
		}
	}
	const mcpServers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
	mcpServers.codemem = managedMcp(runtime);
	mcpConfig.mcpServers = mcpServers;
	mergeCodememHookGroups(settings, buildCodememClaudeHookGroups(codememCodexHookBase(runtimePath)));

	const enabledPlugins = settings.enabledPlugins;
	if (
		enabledPlugins !== null &&
		typeof enabledPlugins === "object" &&
		!Array.isArray(enabledPlugins) &&
		(enabledPlugins as Record<string, unknown>)[CLAUDE_PLUGIN_ID] === true
	) {
		(enabledPlugins as Record<string, unknown>)[CLAUDE_PLUGIN_ID] = false;
	}

	const settingsChanged = beforeSettings !== JSON.stringify(settings) || !existsSync(settingsPath);
	const mcpChanged = beforeMcp !== JSON.stringify(mcpConfig) || !existsSync(mcpPath);
	if (!settingsChanged && !mcpChanged) {
		p.log.info("Claude MCP and hooks already use the managed runtime");
		return true;
	}
	for (const [path, changed] of [
		[settingsPath, settingsChanged],
		[mcpPath, mcpChanged],
	] as const) {
		if (changed && existsSync(path)) {
			try {
				atomicReplaceSetupFile(`${path}.codemem.bak`, readFileSync(path));
			} catch {
				// Non-fatal: the original remains in place until the write below.
			}
		}
	}
	try {
		if (settingsChanged) writeJsonConfig(settingsPath, settings);
		if (mcpChanged) writeJsonConfig(mcpPath, mcpConfig);
		p.log.success(`Claude MCP and hooks installed: ${settingsPath}, ${mcpPath}`);
		return true;
	} catch (error) {
		p.log.error(
			`Failed to write Claude configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function preflightOpencode(force: boolean, runtime: SetupRuntime, configPath: string): boolean {
	if (!opencodePluginAvailable(runtime)) return false;
	if (!opencodeWrapperReplacementAllowed(force, runtime)) return false;
	let config: Record<string, unknown>;
	try {
		config = loadJsoncConfig(configPath);
	} catch (error) {
		p.log.error(
			`Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	const configuredMcp = config.mcp;
	if (
		configuredMcp !== undefined &&
		(configuredMcp === null || typeof configuredMcp !== "object" || Array.isArray(configuredMcp))
	) {
		p.log.error(`Refusing to replace malformed MCP configuration in ${configPath}.`);
		return false;
	}
	const current = (configuredMcp as Record<string, unknown> | undefined)?.codemem;
	if (managedMcpReplacementAllowed(current, force, runtime, sameOpencodeMcp)) return true;
	p.log.error(`Refusing to replace a custom codemem MCP entry in ${configPath}; use --force.`);
	return false;
}

function preflightCodex(force: boolean, runtime: SetupRuntime): boolean {
	const codexHome = codexConfigDir();
	const configPath = join(codexHome, "config.toml");
	let existing = "";
	try {
		existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
	} catch (error) {
		p.log.error(
			`Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	const current = codexMcpTable(existing)?.block;
	if (hasUnsupportedCodexMcpLayout(existing)) {
		p.log.error(
			`Refusing to replace an unsupported codemem MCP layout in ${configPath}; normalize or remove it first.`,
		);
		return false;
	}
	if (
		current &&
		!force &&
		!sameCodexMcpBlock(current, runtime) &&
		!managedLegacyCodexBlock(current)
	) {
		p.log.error(`Refusing to replace a custom codemem MCP entry in ${configPath}; use --force.`);
		return false;
	}

	const hooksPath = join(codexHome, "hooks.json");
	if (!existsSync(hooksPath)) return true;
	let config: Record<string, unknown>;
	try {
		config = parseObjectJson(readFileSync(hooksPath, "utf8"));
	} catch (error) {
		p.log.error(
			`Failed to parse ${hooksPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	const hooks = config.hooks;
	if (
		hooks !== undefined &&
		(hooks === null || typeof hooks !== "object" || Array.isArray(hooks))
	) {
		p.log.error(`Refusing to replace malformed hooks in ${hooksPath}.`);
		return false;
	}
	if (hooks && typeof hooks === "object") {
		for (const event of Object.keys(buildCodememCodexHookGroups("managed-runtime"))) {
			const groups = (hooks as Record<string, unknown>)[event];
			if (groups !== undefined && !Array.isArray(groups)) {
				p.log.error(`Refusing to replace malformed ${event} hooks in ${hooksPath}.`);
				return false;
			}
		}
	}
	return true;
}

/**
 * Configure Codex via direct config files (MCP in config.toml + hooks in
 * hooks.json) without relying on the Codex plugin marketplace. Idempotent;
 * honors CODEX_HOME. Returns true on success.
 */
export function installCodex(
	force: boolean,
	runtime: SetupRuntime = resolveSetupRuntime(),
): boolean {
	if (!preflightCodex(force, runtime)) return false;
	const codexHome = codexConfigDir();
	try {
		mkdirSync(codexHome, { recursive: true });
	} catch (err) {
		p.log.error(
			`Failed to create Codex home ${codexHome}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	const runtimeSource = runtime.hookRuntimePath;
	const runtimePath = installCodexHookRuntime(codexHome, runtimeSource);
	if (!runtimePath) return false;
	p.log.info("Codex hooks will use the bundled standalone runtime.");

	let ok = installCodexMcp(codexHome, force, runtime);
	ok = installCodexHooks(codexHome, force, runtimePath) && ok;
	return ok;
}

function setupDataDir(): string {
	return resolveRuntimeDataDir();
}

function preflightInstallManifest(dataDir: string): boolean {
	const path = resolveStorageLayout(dataDir).installManifestPath;
	if (!existsSync(path)) return true;
	try {
		readInstallManifest(path);
		return true;
	} catch (error) {
		p.log.error(
			`Failed to read the install ownership manifest: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return false;
	}
}

function setupTransactionStateUnchanged(
	snapshots: readonly SetupFileSnapshot[],
	mutations: ReadonlyMap<string, SetupFileMutation>,
): boolean {
	return snapshots.every((snapshot) => {
		const mutation = mutations.get(snapshot.path);
		return mutation
			? setupFileMatchesMutation(snapshot.path, mutation)
			: setupFileSnapshotUnchanged(snapshot);
	});
}

function restoreSetupFileSnapshots(
	snapshots: readonly SetupFileSnapshot[],
	mutations: ReadonlyMap<string, SetupFileMutation>,
): boolean {
	let restored = true;
	for (const snapshot of [...snapshots].reverse()) {
		const mutation = mutations.get(snapshot.path);
		if (!mutation || !setupFileMatchesMutation(snapshot.path, mutation)) continue;
		try {
			if (snapshot.contents === null) atomicRemoveSetupFile(snapshot.path);
			else atomicReplaceSetupFile(snapshot.path, snapshot.contents, snapshot.mode);
		} catch (error) {
			restored = false;
			p.log.error(
				`Failed to roll back ${snapshot.path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return restored;
}

/** Mutate one editor lane and publish its ownership manifest as one fail-closed unit. */
function runSetupLaneTransaction(
	dataDir: string,
	paths: readonly string[],
	mutate: () => boolean,
	commitManifest: () => void,
): boolean {
	let snapshots: SetupFileSnapshot[];
	try {
		snapshots = captureSetupFileSnapshots(paths);
	} catch (error) {
		p.log.error(
			`Failed to capture setup pre-state: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	const mutations = new Map<string, SetupFileMutation>();
	const baselines = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
	let manifestLock: ReturnType<typeof acquireSpoolLock> | null = null;
	try {
		if (!withSetupFileMutationTracking(mutations, baselines, mutate)) {
			if (!restoreSetupFileSnapshots(snapshots, mutations)) {
				p.log.error("Setup rollback was incomplete; inspect the paths reported above.");
			}
			return false;
		}
		if (!setupTransactionStateUnchanged(snapshots, mutations)) {
			throw new Error("Setup target changed before ownership manifest commit.");
		}
		manifestLock = acquireSpoolLock(dataDir);
		withSetupFileMutationTracking(mutations, baselines, commitManifest);
		if (!setupTransactionStateUnchanged(snapshots, mutations)) {
			throw new Error("Setup target changed during ownership manifest commit.");
		}
		return true;
	} catch (error) {
		p.log.error(
			`Failed to install or commit setup ownership: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		if (!restoreSetupFileSnapshots(snapshots, mutations)) {
			p.log.error("Setup rollback was incomplete; inspect the paths reported above.");
		}
		return false;
	} finally {
		manifestLock?.close();
	}
}

function writeSetupInstallManifestUnlocked(
	files: Array<{ id: string; path: string }>,
	dataDir: string = setupDataDir(),
	replaceIds: readonly string[] = files.map((file) => file.id),
): void {
	const manifestPath = resolveStorageLayout(dataDir).installManifestPath;
	const unique = new Map(files.map((file) => [resolve(file.path), file]));
	const captured = [...unique.values()].map((file) =>
		captureManagedTarget(file.id, resolve(file.path)),
	);
	if (captured.length === 0) throw new Error("No managed thin-client targets were installed.");
	const previous = existsSync(manifestPath)
		? readInstallManifest(manifestPath)
		: { version: 1 as const, blocks: [] };
	const replaced = new Set(replaceIds);
	const targets = new Map(
		(previous.targets ?? [])
			.filter((target) => !replaced.has(target.id))
			.map((target) => [target.id, target]),
	);
	for (const target of captured) targets.set(target.id, target);
	const nextManifest = {
		version: 1 as const,
		blocks: previous.blocks,
		targets: [...targets.values()],
	};
	assertSetupFileMutationAllowed(manifestPath);
	recordSetupFileMutation(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 0o600);
	writeInstallManifest(manifestPath, nextManifest);
}

export function writeSetupInstallManifest(
	files: Array<{ id: string; path: string }>,
	dataDir: string = setupDataDir(),
	replaceIds: readonly string[] = files.map((file) => file.id),
): void {
	const lock = acquireSpoolLock(dataDir);
	try {
		writeSetupInstallManifestUnlocked(files, dataDir, replaceIds);
	} finally {
		lock.close();
	}
}

export const setupCommand = new Command("setup")
	.configureHelp(helpStyle)
	.description("Install checkout-pinned editor MCP and hook integrations")
	.option("--force", "overwrite existing installations")
	.option("--opencode-only", "only install for OpenCode")
	.option("--claude-only", "only install for Claude Code")
	.option("--codex-only", "only install for Codex")
	.action(
		(opts: {
			force?: boolean;
			opencodeOnly?: boolean;
			claudeOnly?: boolean;
			codexOnly?: boolean;
		}) => {
			p.intro(`codemem setup v${VERSION}`);
			const force = opts.force ?? false;
			let runtime: SetupRuntime;
			try {
				runtime = resolveSetupRuntime();
			} catch (error) {
				p.log.error(error instanceof Error ? error.message : String(error));
				p.outro("Setup stopped before changing editor configuration");
				process.exitCode = 1;
				return;
			}
			const onlyFlag = Boolean(opts.opencodeOnly || opts.claudeOnly || opts.codexOnly);

			const doOpencode = opts.opencodeOnly || !onlyFlag;
			const doClaude = opts.claudeOnly || !onlyFlag;
			// With no only-flag, Codex runs only when a Codex home is detected.
			const doCodex = opts.codexOnly || (!onlyFlag && existsSync(codexConfigDir()));
			const opencodeConfigPath = doOpencode
				? resolveOpencodeConfigPath(opencodeConfigDir())
				: undefined;
			const dataDir = setupDataDir();
			if (
				!preflightInstallManifest(dataDir) ||
				(opencodeConfigPath !== undefined &&
					!preflightOpencode(force, runtime, opencodeConfigPath)) ||
				(doClaude && !loadClaudeConfiguration(force, runtime)) ||
				(doCodex && !preflightCodex(force, runtime))
			) {
				p.outro("Setup stopped before changing editor configuration");
				process.exitCode = 1;
				return;
			}

			const manifestPath = resolveStorageLayout(dataDir).installManifestPath;
			const recordTargets = (
				targets: Array<{ id: string; path: string }>,
				replaceIds: readonly string[],
			): void => {
				writeSetupInstallManifestUnlocked(
					[{ id: "cli-runtime", path: runtime.cliPath }, ...targets],
					dataDir,
					["cli-runtime", ...replaceIds],
				);
			};
			const stopAfterLaneFailure = (): void => {
				p.outro("Setup stopped after an editor lane failure");
				process.exitCode = 1;
			};

			if (opencodeConfigPath !== undefined) {
				const configPath = opencodeConfigPath;
				const configDir = opencodeConfigDir();
				const wrapperPath = join(configDir, "plugins", "codemem.js");
				const targets = [
					{ id: "opencode-plugin", path: wrapperPath },
					{ id: "opencode-plugin-source", path: runtime.opencodePluginPath },
					{
						id: "opencode-plugin-compat",
						path: resolve(dirname(runtime.opencodePluginPath), "../lib/compat.js"),
					},
					{ id: "opencode-mcp", path: configPath },
				];
				const installed = runSetupLaneTransaction(
					dataDir,
					[
						manifestPath,
						join(configDir, "opencode.json"),
						join(configDir, "opencode.jsonc"),
						wrapperPath,
						`${wrapperPath}.codemem.bak`,
						join(configDir, "lib", "compat.js"),
					],
					() => {
						if (resolveOpencodeConfigPath(configDir) !== configPath) {
							p.log.error("OpenCode configuration path changed during setup.");
							return false;
						}
						p.log.step("Installing OpenCode plugin...");
						if (!installPlugin(force, runtime, configPath)) return false;
						p.log.step("Installing OpenCode MCP config...");
						return installMcp(force, runtime, configPath);
					},
					() =>
						recordTargets(targets, [
							"opencode-plugin-mcp",
							"opencode-plugin",
							"opencode-plugin-compat",
							"opencode-plugin-source",
							"opencode-mcp",
						]),
				);
				if (!installed) {
					stopAfterLaneFailure();
					return;
				}
			}

			if (doClaude) {
				const settingsPath = join(claudeConfigDir(), "settings.json");
				const mcpPath = claudeMcpConfigPath();
				const runtimePath = join(claudeConfigDir(), "codemem-hook-runtime.mjs");
				const targets = [
					{ id: "claude-mcp", path: mcpPath },
					{ id: "claude-hooks", path: settingsPath },
					{ id: "claude-hook-runtime", path: runtimePath },
				];
				const installed = runSetupLaneTransaction(
					dataDir,
					[
						manifestPath,
						settingsPath,
						`${settingsPath}.codemem.bak`,
						mcpPath,
						`${mcpPath}.codemem.bak`,
						runtimePath,
					],
					() => {
						p.log.step("Installing Claude Code MCP and hooks...");
						return installClaude(force, runtime);
					},
					() => recordTargets(targets, ["claude-mcp", "claude-hooks", "claude-hook-runtime"]),
				);
				if (!installed) {
					stopAfterLaneFailure();
					return;
				}
			}

			if (doCodex) {
				const configPath = join(codexConfigDir(), "config.toml");
				const hooksPath = join(codexConfigDir(), "hooks.json");
				const runtimePath = join(codexConfigDir(), "codemem-hook-runtime.mjs");
				const targets = [
					{ id: "codex-mcp", path: configPath },
					{ id: "codex-hooks", path: hooksPath },
					{ id: "codex-hook-runtime", path: runtimePath },
				];
				const installed = runSetupLaneTransaction(
					dataDir,
					[
						manifestPath,
						configPath,
						`${configPath}.codemem.bak`,
						hooksPath,
						`${hooksPath}.codemem.bak`,
						runtimePath,
					],
					() => {
						p.log.step("Configuring Codex (MCP + hooks)...");
						return installCodex(force, runtime);
					},
					() => recordTargets(targets, ["codex-mcp", "codex-hooks", "codex-hook-runtime"]),
				);
				if (!installed) {
					stopAfterLaneFailure();
					return;
				}
				p.log.info("Codex next steps:");
				p.log.info("  - Restart Codex to load the new configuration");
				p.log.info("  - On first run, approve the one-time prompt to trust the codemem hooks");
				p.log.info("  - MCP recall works immediately (no trust prompt required)");
			}

			p.outro("Setup complete — restart your editor to load the codemem integration");
		},
	);
