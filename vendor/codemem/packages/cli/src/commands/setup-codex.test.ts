import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireSpoolLock, resolveRuntimeDataDir } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCodememClaudeHookGroups,
	buildCodememCodexHookGroups,
	claudeConfigDir,
	codememCodexHookBase,
	codexConfigDir,
	installClaude,
	installCodex,
	installCodexHookRuntime,
	installMcp,
	installPlugin,
	isTransientNpxBinPath,
	resolveSetupRuntime,
	setupCommand,
	writeSetupInstallManifest,
} from "./setup.js";

const setupSnapshotRace = vi.hoisted(() => ({
	path: "",
	replacementPath: "",
	afterRename: "",
	afterTempWrite: "",
	beforeLink: "",
	mutationPath: "",
	mutationText: "",
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
			actual.writeFileSync(...args);
			if (String(args[0]).startsWith(`${setupSnapshotRace.afterTempWrite}.${process.pid}.`)) {
				actual.writeFileSync(setupSnapshotRace.mutationPath, setupSnapshotRace.mutationText);
				setupSnapshotRace.afterTempWrite = "";
				setupSnapshotRace.mutationPath = "";
				setupSnapshotRace.mutationText = "";
			}
		},
		openSync(...args: Parameters<typeof actual.openSync>) {
			const descriptor = actual.openSync(...args);
			if (String(args[0]) === setupSnapshotRace.path) {
				actual.renameSync(setupSnapshotRace.replacementPath, setupSnapshotRace.path);
				setupSnapshotRace.path = "";
				setupSnapshotRace.replacementPath = "";
			}
			return descriptor;
		},
		renameSync(...args: Parameters<typeof actual.renameSync>) {
			actual.renameSync(...args);
			if (String(args[1]) === setupSnapshotRace.afterRename) {
				actual.writeFileSync(setupSnapshotRace.mutationPath, setupSnapshotRace.mutationText);
				setupSnapshotRace.afterRename = "";
				setupSnapshotRace.mutationPath = "";
				setupSnapshotRace.mutationText = "";
			}
		},
		linkSync(...args: Parameters<typeof actual.linkSync>) {
			if (String(args[1]) === setupSnapshotRace.beforeLink) {
				actual.writeFileSync(setupSnapshotRace.mutationPath, setupSnapshotRace.mutationText);
				setupSnapshotRace.beforeLink = "";
				setupSnapshotRace.mutationPath = "";
				setupSnapshotRace.mutationText = "";
			}
			actual.linkSync(...args);
		},
	};
});

const HOOK_TIMEOUT = 5;

const savedCodexHome = process.env.CODEX_HOME;
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const savedDataDir = process.env.CODEMEM_DATA_DIR;
const savedDb = process.env.CODEMEM_DB;
const savedHome = process.env.HOME;
let codexHome: string;
let claudeHome: string;
let runtimeDirs: string[];
let INGEST_CMD: string;
let INJECT_CMD: string;

beforeEach(() => {
	codexHome = mkdtempSync(join(tmpdir(), "codemem-setup-codex-"));
	claudeHome = join(codexHome, "claude config's");
	process.env.CODEX_HOME = codexHome;
	process.env.CLAUDE_CONFIG_DIR = claudeHome;
	process.env.HOME = codexHome;
	runtimeDirs = [];
	delete process.env.CODEMEM_DATA_DIR;
	delete process.env.CODEMEM_DB;
	const hookBase = codememCodexHookBase(join(codexHome, "codemem-hook-runtime.mjs"));
	INGEST_CMD = `${hookBase} codex-hook-ingest`;
	INJECT_CMD = `${hookBase} codex-hook-inject`;
});

afterEach(() => {
	setupSnapshotRace.path = "";
	setupSnapshotRace.replacementPath = "";
	setupSnapshotRace.afterRename = "";
	setupSnapshotRace.afterTempWrite = "";
	setupSnapshotRace.beforeLink = "";
	setupSnapshotRace.mutationPath = "";
	setupSnapshotRace.mutationText = "";
	if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = savedCodexHome;
	if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
	if (savedDataDir === undefined) delete process.env.CODEMEM_DATA_DIR;
	else process.env.CODEMEM_DATA_DIR = savedDataDir;
	if (savedDb === undefined) delete process.env.CODEMEM_DB;
	else process.env.CODEMEM_DB = savedDb;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	for (const dataDir of runtimeDirs) rmSync(dataDir, { recursive: true, force: true });
	rmSync(codexHome, { recursive: true, force: true });
});

interface CodexHookCommand {
	type: string;
	command: string;
	timeout: number;
	statusMessage: string;
}

interface CodexHookGroup {
	hooks: CodexHookCommand[];
}

function readHooks(): Record<string, CodexHookGroup[]> {
	const raw = readFileSync(join(codexHome, "hooks.json"), "utf-8");
	return (JSON.parse(raw) as { hooks: Record<string, CodexHookGroup[]> }).hooks;
}

function groupsFor(hooks: Record<string, CodexHookGroup[]>, event: string): CodexHookGroup[] {
	const groups = hooks[event];
	if (!groups) throw new Error(`expected hook groups for ${event}`);
	return groups;
}

function readConfigToml(): string {
	return readFileSync(join(codexHome, "config.toml"), "utf-8");
}

describe("codexConfigDir", () => {
	it("honors CODEX_HOME", () => {
		expect(codexConfigDir()).toBe(codexHome);
		expect(claudeConfigDir()).toBe(claudeHome);
	});
});

describe("Codex hook runtime install", () => {
	it("copies the standalone runtime and quotes its setup command", () => {
		const runtime = resolveSetupRuntime();
		expect(runtime.cliPath).toBe(resolve(import.meta.dirname, "../../dist/index.js"));
		expect(runtime.opencodePluginPath).toBe(
			resolve(import.meta.dirname, "../../../opencode-plugin/.opencode/plugins/codemem.js"),
		);

		const source = join(codexHome, "source runtime.mjs");
		writeFileSync(source, "// runtime\n", "utf8");
		const target = installCodexHookRuntime(codexHome, source);
		expect(target).toBe(join(codexHome, "codemem-hook-runtime.mjs"));
		expect(readFileSync(target as string, "utf8")).toBe("// runtime\n");
		chmodSync(target as string, 0o666);
		expect(installCodexHookRuntime(codexHome, source)).toBe(target);
		expect(lstatSync(target as string).mode & 0o777).toBe(0o600);
		expect(codememCodexHookBase(target)).toBe(`'${process.execPath}' '${target}'`);
		expect(codememCodexHookBase("/tmp/runtime path's", "/tmp/node path's")).toBe(
			"'/tmp/node path'\\''s' '/tmp/runtime path'\\''s'",
		);
	});
});

describe("installCodex — fresh CODEX_HOME", () => {
	it("records the installed MCP and hook files in the cutover manifest", () => {
		expect(installCodex(false)).toBe(true);
		const dataDir = join(codexHome, "data");
		const runtimeTarget = join(codexHome, "runtime.mjs");
		writeFileSync(runtimeTarget, "v1\n", "utf8");
		writeSetupInstallManifest(
			[
				{ id: "codex-mcp", path: join(codexHome, "config.toml") },
				{ id: "cli-runtime", path: runtimeTarget },
			],
			dataDir,
		);
		writeSetupInstallManifest(
			[{ id: "codex-hooks", path: join(codexHome, "hooks.json") }],
			dataDir,
		);

		const manifest = JSON.parse(
			readFileSync(join(dataDir, "control", "install-manifest.json"), "utf8"),
		) as { blocks: unknown[]; targets: Array<{ id: string; fingerprint: string }> };
		expect(manifest.blocks).toEqual([]);
		expect(manifest.targets.map((target) => target.id).sort()).toEqual([
			"cli-runtime",
			"codex-hooks",
			"codex-mcp",
		]);
		expect(manifest.targets.every((target) => /^[a-f0-9]{64}$/.test(target.fingerprint))).toBe(
			true,
		);
		const manifestBeforeContention = readFileSync(
			join(dataDir, "control", "install-manifest.json"),
			"utf8",
		);
		const heldSetupLock = acquireSpoolLock(dataDir);
		try {
			expect(() =>
				writeSetupInstallManifest(
					[{ id: "codex-hooks", path: join(codexHome, "hooks.json") }],
					dataDir,
				),
			).toThrow("Spool lock deadline exceeded");
			expect(readFileSync(join(dataDir, "control", "install-manifest.json"), "utf8")).toBe(
				manifestBeforeContention,
			);
		} finally {
			heldSetupLock.close();
		}
		const firstRuntimeFingerprint = manifest.targets.find(
			(target) => target.id === "cli-runtime",
		)?.fingerprint;

		writeFileSync(runtimeTarget, "v2\n", "utf8");
		writeSetupInstallManifest(
			[
				{ id: "codex-hooks", path: join(codexHome, "hooks.json") },
				{ id: "cli-runtime", path: runtimeTarget },
			],
			dataDir,
			["cli-runtime", "codex-mcp", "codex-hooks"],
		);
		const reconciled = JSON.parse(
			readFileSync(join(dataDir, "control", "install-manifest.json"), "utf8"),
		) as { targets: Array<{ id: string; fingerprint: string }> };
		expect(reconciled.targets.map((target) => target.id).sort()).toEqual([
			"cli-runtime",
			"codex-hooks",
		]);
		expect(reconciled.targets.find((target) => target.id === "cli-runtime")?.fingerprint).not.toBe(
			firstRuntimeFingerprint,
		);

		const customDbPath = join(codexHome, "setup.sqlite");
		process.env.CODEMEM_DB = customDbPath;
		const customDataDir = resolveRuntimeDataDir({ dbPath: customDbPath });
		runtimeDirs.push(customDataDir);
		writeSetupInstallManifest([{ id: "codex-hooks", path: join(codexHome, "hooks.json") }]);
		expect(existsSync(join(customDataDir, "control", "install-manifest.json"))).toBe(true);
	});

	it("writes the MCP block and all hook events with correct schema", () => {
		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml).toContain("[mcp_servers.codemem]");
		expect(toml).toContain(`command = ${JSON.stringify(process.execPath)}`);
		expect(toml).toContain(`args = [${JSON.stringify(resolveSetupRuntime().cliPath)}, "mcp"]`);
		expect(toml).not.toContain("npx");
		expect(toml).toContain("startup_timeout_sec = 30");
		expect(toml).toContain("tool_timeout_sec = 60");

		const hooks = readHooks();
		expect(Object.keys(hooks).sort()).toEqual([
			"PostToolUse",
			"SessionEnd",
			"SessionStart",
			"Stop",
			"UserPromptSubmit",
		]);

		// Single-ingest events.
		for (const event of ["SessionStart", "PostToolUse", "Stop", "SessionEnd"]) {
			const groups = groupsFor(hooks, event);
			expect(groups).toHaveLength(1);
			const group = groups[0];
			if (!group) throw new Error(`missing group for ${event}`);
			expect(group.hooks).toHaveLength(1);
			expect(group.hooks[0]).toEqual({
				type: "command",
				command: INGEST_CMD,
				timeout: HOOK_TIMEOUT,
				statusMessage: "codemem",
			});
		}

		// Injection also captures the prompt event, so one hook owns both actions.
		const ups = groupsFor(hooks, "UserPromptSubmit");
		expect(ups).toHaveLength(1);
		const upsGroup = ups[0];
		if (!upsGroup) throw new Error("missing UserPromptSubmit group");
		expect(upsGroup.hooks).toHaveLength(1);
		expect(upsGroup.hooks[0]).toEqual({
			type: "command",
			command: INJECT_CMD,
			timeout: HOOK_TIMEOUT,
			statusMessage: "codemem recall",
		});
	});

	it("creates CODEX_HOME if it does not yet exist", () => {
		const nested = join(codexHome, "nested", "codex");
		process.env.CODEX_HOME = nested;
		expect(existsSync(nested)).toBe(false);

		expect(installCodex(false)).toBe(true);

		expect(existsSync(join(nested, "config.toml"))).toBe(true);
		expect(existsSync(join(nested, "hooks.json"))).toBe(true);
	});
});

describe("installCodex — idempotency", () => {
	it("replaces an installed standalone-runtime hook instead of duplicating it", () => {
		writeFileSync(
			join(codexHome, "hooks.json"),
			`${JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{
							hooks: [
								{
									type: "command",
									command: "node '/tmp/codex/codemem-hook-runtime.mjs' codex-hook-inject",
									timeout: HOOK_TIMEOUT,
									statusMessage: "codemem recall",
								},
							],
						},
					],
				},
			})}\n`,
			"utf8",
		);

		expect(installCodex(false)).toBe(true);
		const commands = groupsFor(readHooks(), "UserPromptSubmit").flatMap((group) =>
			group.hooks.map((hook) => hook.command),
		);
		expect(commands.filter((command) => command.includes("codex-hook-inject"))).toEqual([
			INJECT_CMD,
		]);
	});

	it("migrates the legacy prompt ingest plus inject pair without --force", () => {
		writeFileSync(
			join(codexHome, "hooks.json"),
			`${JSON.stringify(
				{
					hooks: {
						UserPromptSubmit: [
							{
								hooks: [
									{
										type: "command",
										command: INGEST_CMD,
										timeout: HOOK_TIMEOUT,
										statusMessage: "codemem",
									},
								],
							},
							{
								hooks: [
									{
										type: "command",
										command: INJECT_CMD,
										timeout: HOOK_TIMEOUT,
										statusMessage: "codemem recall",
									},
								],
							},
						],
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		expect(installCodex(false)).toBe(true);
		const hooks = readHooks();
		const commands = groupsFor(hooks, "UserPromptSubmit").flatMap((group) =>
			group.hooks.map((hook) => hook.command),
		);
		expect(commands).toEqual([INJECT_CMD]);
		expect(groupsFor(hooks, "UserPromptSubmit")[0]?.hooks[0]?.timeout).toBe(HOOK_TIMEOUT);
	});

	it("does not duplicate the MCP block or hook entries on re-run", () => {
		expect(installCodex(false)).toBe(true);
		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		const mcpOccurrences = toml.split("[mcp_servers.codemem]").length - 1;
		expect(mcpOccurrences).toBe(1);

		const hooks = readHooks();
		expect(groupsFor(hooks, "SessionStart")).toHaveLength(1);
		expect(groupsFor(hooks, "PostToolUse")).toHaveLength(1);
		expect(groupsFor(hooks, "Stop")).toHaveLength(1);
		const ups = groupsFor(hooks, "UserPromptSubmit");
		expect(ups).toHaveLength(1);
		expect(ups[0]?.hooks).toHaveLength(1);
	});

	it("does not duplicate codemem hooks when run again with --force", () => {
		expect(installCodex(false)).toBe(true);
		expect(installCodex(true)).toBe(true);

		const hooks = readHooks();
		expect(groupsFor(hooks, "SessionStart")).toHaveLength(1);
		const ups = groupsFor(hooks, "UserPromptSubmit");
		expect(ups).toHaveLength(1);
		expect(ups[0]?.hooks).toHaveLength(1);
	});
});

describe("installCodex — non-destructive merge", () => {
	it("preserves unrelated config.toml content (comments + other MCP servers)", () => {
		const original = [
			"# my codex config",
			'workspace = "C:\\\\Users\\\\jura"',
			"",
			"[mcp_servers.other]",
			'command = "other-cmd"',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), original, "utf-8");

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml).toContain("# my codex config");
		expect(toml).toContain('workspace = "C:\\\\Users\\\\jura"');
		expect(toml).toContain("[mcp_servers.other]");
		expect(toml).toContain('command = "other-cmd"');
		expect(toml).toContain("[mcp_servers.codemem]");

		for (const [command, args] of [
			["codemem", ["mcp"]],
			["/tmp/.npm/_npx/abc/node_modules/.bin/codemem", ["mcp"]],
			["/usr/bin/node", ["/tmp/codemem/packages/cli/dist/index.js", "mcp"]],
			["uvx", ["codemem==0.19.0", "mcp"]],
			["uv", ["run", "codemem==0.19.0", "mcp"]],
			["uv", ["tool", "run", "codemem==0.19.0", "mcp"]],
			["npx", ["-p", "codemem", "codemem", "mcp"]],
			["npx", ["--package=codemem", "codemem", "mcp"]],
		] satisfies Array<[string, string[]]>) {
			const legacy = `${original}[mcp_servers.codemem]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]\n`;
			writeFileSync(join(codexHome, "config.toml"), legacy, "utf-8");
			expect(installCodex(false)).toBe(true);
		}
		const runtime = resolveSetupRuntime();
		const disabledManaged = [
			"[mcp_servers.codemem]",
			`command = ${JSON.stringify(process.execPath)}`,
			`args = [${JSON.stringify(runtime.cliPath)}, "mcp"]`,
			"startup_timeout_sec = 30",
			"tool_timeout_sec = 60",
			"enabled = false",
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), disabledManaged, "utf-8");
		expect(installCodex(false)).toBe(true);
		expect(readConfigToml()).not.toContain("enabled = false");

		const documentedManaged = `${disabledManaged}\n# Documentation for the next server.\n[mcp_servers.other]\ncommand = "other"\n`;
		writeFileSync(join(codexHome, "config.toml"), documentedManaged, "utf-8");
		expect(installCodex(false)).toBe(true);
		expect(readConfigToml()).toContain(
			'tool_timeout_sec = 60\n\n# Documentation for the next server.\n[mcp_servers.other]\ncommand = "other"',
		);

		const commentedManaged = `${original}[mcp_servers.codemem]\n# command = ${JSON.stringify(process.execPath)}\n# args = [${JSON.stringify(runtime.cliPath)}, "mcp"]\ncommand = "custom"\nargs = ["mcp"]\n`;
		writeFileSync(join(codexHome, "config.toml"), commentedManaged, "utf-8");
		expect(installCodex(false)).toBe(false);
		expect(readConfigToml()).toBe(commentedManaged);

		const custom = `${original}[mcp_servers."codemem"]\n# stale args = ["/tmp/old/packages/cli/dist/index.js", "mcp"]\ncommand = "npx"\nargs = ["--package", "@acme/codemem", "codemem", "mcp"]\n`;
		writeFileSync(join(codexHome, "config.toml"), custom, "utf-8");
		expect(installCodex(false)).toBe(false);
		expect(readConfigToml()).toBe(custom);
		expect(installCodex(true)).toBe(true);
		expect(readConfigToml()).toContain('[mcp_servers.other]\ncommand = "other-cmd"');

		for (const key of ["mcp_servers.codemem", '"mcp_servers".codemem']) {
			const dotted = `${key} = { command = "custom", args = ["mcp"] }\n\n${original}`;
			writeFileSync(join(codexHome, "config.toml"), dotted, "utf-8");
			expect(installCodex(false)).toBe(false);
			expect(readConfigToml()).toBe(dotted);
			expect(installCodex(true)).toBe(true);
			expect(readConfigToml()).not.toContain(`${key} =`);
			expect(readConfigToml()).toContain('[mcp_servers.other]\ncommand = "other-cmd"');
		}

		const customWithEmbeddedManagedExample = [
			"[mcp_servers.codemem]",
			'description = """',
			`command = ${JSON.stringify(process.execPath)}`,
			`args = [${JSON.stringify(runtime.cliPath)}, "mcp"]`,
			'"""',
			'command = "custom"',
			'args = ["mcp"]',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), customWithEmbeddedManagedExample, "utf-8");
		expect(installCodex(false)).toBe(false);
		expect(readConfigToml()).toBe(customWithEmbeddedManagedExample);

		const managedWithNestedArray = [
			"[mcp_servers.codemem]",
			'command = "npx"',
			'args = ["-y", "codemem", "mcp"]',
			"metadata = [",
			'  ["not-a-table"]',
			"]",
			"[mcp_servers.other]",
			'command = "other"',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), managedWithNestedArray, "utf-8");
		expect(installCodex(true)).toBe(true);
		expect(readConfigToml()).not.toContain("not-a-table");
		expect(readConfigToml()).toContain('[mcp_servers.other]\ncommand = "other"');
	});

	it("preserves an unrelated user SessionStart hook and adds the codemem hook", () => {
		const existing = {
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: "echo user-hook",
								timeout: 10,
								statusMessage: "user",
							},
							{
								type: "command",
								command: "codemem codex-hook-ingest",
								timeout: 5,
								statusMessage: "legacy codemem",
							},
						],
					},
				],
			},
		};
		writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`, "utf-8");

		expect(installCodex(false)).toBe(true);

		const hooks = readHooks();
		const sessionStart = groupsFor(hooks, "SessionStart");
		expect(sessionStart).toHaveLength(2);
		const commands = sessionStart.flatMap((g) => g.hooks.map((h) => h.command));
		expect(commands).toContain("echo user-hook");
		expect(commands).toContain(INGEST_CMD);
	});

	it("--force preserves an unrelated user hook on the same event", () => {
		const existing = {
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{ type: "command", command: "echo user-ups", timeout: 10, statusMessage: "user" },
						],
					},
				],
			},
		};
		writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`, "utf-8");

		// Seed codemem hooks, then re-run with --force.
		expect(installCodex(false)).toBe(true);
		expect(installCodex(true)).toBe(true);

		const hooks = readHooks();
		const ups = groupsFor(hooks, "UserPromptSubmit");
		const commands = ups.flatMap((g) => g.hooks.map((h) => h.command));
		// Unrelated user hook survives; the combined capture/recall hook appears once.
		expect(commands).toContain("echo user-ups");
		expect(commands.filter((c) => c === INGEST_CMD)).toHaveLength(0);
		expect(commands.filter((c) => c === INJECT_CMD)).toHaveLength(1);
	});
});

describe("isTransientNpxBinPath", () => {
	it("flags npx/dlx cache bins so they are not baked into hooks", () => {
		expect(isTransientNpxBinPath("/Users/x/.npm/_npx/abc123/node_modules/.bin/codemem")).toBe(true);
		expect(isTransientNpxBinPath("/tmp/.pnpm/dlx/abc/node_modules/.bin/codemem")).toBe(true);
	});

	it("treats durable global/managed bins as on-PATH", () => {
		expect(isTransientNpxBinPath("/usr/local/bin/codemem")).toBe(false);
		expect(isTransientNpxBinPath("/Users/x/.local/share/mise/installs/node/lts/bin/codemem")).toBe(
			false,
		);
		expect(isTransientNpxBinPath("C\\\\Program Files\\\\nodejs\\\\codemem.cmd")).toBe(false);
	});
});

describe("setup command options", () => {
	it("declares --codex-only (consistent with --opencode-only/--claude-only) and no redundant --codex", async () => {
		const longs = setupCommand.options.map((o) => o.long);
		expect(longs).toContain("--codex-only");
		expect(longs).not.toContain("--codex");

		const runtime = resolveSetupRuntime();
		const opencodeDir = join(codexHome, ".config", "opencode");
		expect(
			installPlugin(false, {
				...runtime,
				opencodePluginPath: join(codexHome, "missing-opencode-plugin.js"),
			}),
		).toBe(false);
		expect(existsSync(join(opencodeDir, "plugins", "codemem.js"))).toBe(false);
		mkdirSync(opencodeDir, { recursive: true });
		writeFileSync(
			join(opencodeDir, "opencode.jsonc"),
			`${JSON.stringify({
				plugin: ["@codemem/opencode-plugin"],
				mcp: {
					codemem: {
						type: "local",
						command: [
							process.execPath,
							join(codexHome, "old", "packages", "cli", "dist", "index.js"),
							"mcp",
						],
					},
				},
			})}\n`,
			"utf8",
		);
		mkdirSync(claudeHome, { recursive: true });
		writeFileSync(
			join(claudeHome, "settings.json"),
			`${JSON.stringify({
				mcpServers: { codemem: { command: "npx", args: ["-y", "codemem", "mcp"] } },
				enabledPlugins: {
					"codemem@codemem-marketplace": true,
					"other@marketplace": true,
				},
				hooks: {
					SessionStart: [
						{
							hooks: [
								{ type: "command", command: "echo user-hook", timeout: 9 },
								{ type: "command", command: "codemem claude-hook-ingest", timeout: 3 },
							],
						},
					],
				},
			})}\n`,
			"utf8",
		);
		writeFileSync(
			join(claudeHome, ".claude.json"),
			`${JSON.stringify({
				unrelatedState: "preserved",
				mcpServers: { other: { command: "/bin/echo", args: ["other"] } },
			})}\n`,
			"utf8",
		);
		expect(installPlugin(false)).toBe(true);
		expect(installMcp(false)).toBe(true);
		expect(installClaude(false)).toBe(true);

		const opencode = JSON.parse(
			readFileSync(join(codexHome, ".config", "opencode", "opencode.jsonc"), "utf8"),
		) as { mcp: { codemem: { command: string[] } } };
		expect(opencode.mcp.codemem.command).toEqual([process.execPath, runtime.cliPath, "mcp"]);
		(opencode.mcp.codemem as { enabled?: boolean }).enabled = false;
		writeFileSync(join(opencodeDir, "opencode.jsonc"), `${JSON.stringify(opencode)}\n`, "utf8");
		expect(installMcp(false)).toBe(true);
		expect(
			(
				JSON.parse(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8")) as {
					mcp: { codemem: { enabled: boolean } };
				}
			).mcp.codemem.enabled,
		).toBe(true);
		const wrapper = readFileSync(
			join(codexHome, ".config", "opencode", "plugins", "codemem.js"),
			"utf8",
		);
		expect(wrapper).toContain(JSON.stringify(runtime.cliPath));
		expect(wrapper).toContain(JSON.stringify(pathToFileURL(runtime.opencodePluginPath).href));
		expect(wrapper).toContain(`process.env.CODEMEM_RUNNER = ${JSON.stringify(process.execPath)}`);
		expect(wrapper).not.toContain('process.env.CODEMEM_RUNNER = "node"');
		expect(wrapper).not.toContain("npx");
		const wrapperPath = join(opencodeDir, "plugins", "codemem.js");
		const userWrapper =
			"// codemem setup-managed wrapper\nexport default async function userPlugin() { return {}; }\n";
		writeFileSync(wrapperPath, userWrapper, "utf8");
		const configBeforeWrapperRefusal = readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8");
		expect(installPlugin(false)).toBe(false);
		expect(readFileSync(wrapperPath, "utf8")).toBe(userWrapper);
		expect(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8")).toBe(
			configBeforeWrapperRefusal,
		);
		expect(installPlugin(true)).toBe(true);
		const managedWrapper = readFileSync(wrapperPath, "utf8");
		writeFileSync(
			wrapperPath,
			managedWrapper
				.replace("// codemem setup-managed wrapper\n", "")
				.replace(JSON.stringify(process.execPath), '"node"'),
			"utf8",
		);
		expect(installPlugin(false)).toBe(true);
		expect(readFileSync(wrapperPath, "utf8")).toBe(managedWrapper);

		const claude = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")) as {
			enabledPlugins: Record<string, boolean>;
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		expect(claude).not.toHaveProperty("mcpServers");
		const claudeMcp = JSON.parse(readFileSync(join(claudeHome, ".claude.json"), "utf8")) as {
			unrelatedState: string;
			mcpServers: Record<string, { command: string; args: string[] }>;
		};
		expect(claudeMcp.mcpServers.codemem).toEqual({
			command: process.execPath,
			args: [runtime.cliPath, "mcp"],
		});
		expect(claudeMcp.mcpServers.other).toEqual({ command: "/bin/echo", args: ["other"] });
		expect(claudeMcp.unrelatedState).toBe("preserved");
		expect(claude.enabledPlugins).toEqual({
			"codemem@codemem-marketplace": false,
			"other@marketplace": true,
		});
		expect(Object.keys(claude.hooks).sort()).toEqual(
			Object.keys(buildCodememClaudeHookGroups("managed-runtime")).sort(),
		);
		expect(claude.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("echo user-hook");
		expect(claude.hooks.SessionStart?.[0]?.hooks).toHaveLength(1);
		expect(claude.hooks.SessionStart?.[1]?.hooks[0]?.command).toContain(process.execPath);
		expect(claude.hooks.SessionStart?.[1]?.hooks[0]?.command).toContain(
			codememCodexHookBase(join(claudeHome, "codemem-hook-runtime.mjs")),
		);
		expect(existsSync(join(claudeHome, "codemem-hook-runtime.mjs"))).toBe(true);
		const legacyCustom = `${JSON.stringify({
			...claude,
			mcpServers: {
				codemem: {
					command: "npx",
					args: ["--package", "@acme/codemem", "codemem", "mcp"],
				},
			},
		})}\n`;
		writeFileSync(join(claudeHome, "settings.json"), legacyCustom, "utf8");
		expect(installClaude(false)).toBe(false);
		expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(legacyCustom);
		expect(installClaude(true)).toBe(true);
		expect(JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"))).not.toHaveProperty(
			"mcpServers",
		);

		const customOpencode = {
			mcp: {
				codemem: {
					type: "local",
					command: ["npx", "--package", "@acme/codemem", "codemem", "mcp"],
				},
			},
		};
		writeFileSync(
			join(opencodeDir, "opencode.jsonc"),
			`${JSON.stringify(customOpencode)}\n`,
			"utf8",
		);
		expect(installMcp(false)).toBe(false);
		expect(JSON.parse(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8"))).toEqual(
			customOpencode,
		);
		expect(installMcp(true)).toBe(true);

		const repoRoot = resolve(import.meta.dirname, "../../../..");
		const tracked = [
			"plugins/claude/scripts/ingest-hook.sh",
			"plugins/claude/scripts/inject-context-hook.sh",
			"plugins/claude/scripts/pre-read-hook.sh",
			"plugins/codex/scripts/ingest-hook.mjs",
			"plugins/codex/scripts/user-prompt-hook.mjs",
		];
		for (const relativePath of tracked) {
			expect(readFileSync(join(repoRoot, relativePath), "utf8"), relativePath).not.toMatch(
				/npx(?:\s+-y)?\s+codemem|command -v codemem/,
			);
		}
		const claudePlugin = JSON.parse(
			readFileSync(join(repoRoot, "plugins/claude/.claude-plugin/plugin.json"), "utf8"),
		) as { mcpServers?: unknown };
		const codexPlugin = JSON.parse(
			readFileSync(join(repoRoot, "plugins/codex/.codex-plugin/plugin.json"), "utf8"),
		) as { mcpServers?: unknown };
		expect(claudePlugin.mcpServers).toBeUndefined();
		expect(codexPlugin.mcpServers).toBeUndefined();
		expect(existsSync(join(repoRoot, "plugins/codex/.mcp.json"))).toBe(false);

		for (const relativePath of ["README.md", "docs/plugin-reference.md"]) {
			const documentation = readFileSync(join(repoRoot, relativePath), "utf8");
			expect(documentation, relativePath).toContain("node packages/cli/dist/index.js setup");
			expect(documentation, relativePath).toContain(".claude.json");
			expect(documentation, relativePath).not.toMatch(
				/npx -y codemem|npm install -g codemem|\/plugin marketplace add kunickiaj\/codemem|codex plugin marketplace add https:\/\/github\.com\/kunickiaj\/codemem|fall back to `npx|from (?:your )?`PATH`/,
			);
		}

		const dataDir = join(codexHome, "setup-data");
		process.env.CODEMEM_DATA_DIR = dataDir;
		const opencodeBeforePreflight = readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8");
		writeFileSync(
			join(claudeHome, ".claude.json"),
			`${JSON.stringify({
				mcpServers: {
					codemem: {
						command: "npx",
						args: ["--package=codemem@npm:attacker", "codemem", "mcp"],
					},
				},
			})}\n`,
			"utf8",
		);
		await setupCommand.parseAsync(["node", "codemem"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8")).toBe(opencodeBeforePreflight);
		expect(existsSync(join(dataDir, "control", "install-manifest.json"))).toBe(false);
		expect(installClaude(true)).toBe(true);
		writeSetupInstallManifest(
			[
				{ id: "claude-hooks", path: join(claudeHome, "settings.json") },
				{ id: "opencode-plugin-mcp", path: join(opencodeDir, "opencode.jsonc") },
			],
			dataDir,
		);
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--claude-only"]);
		const claudeManifest = JSON.parse(
			readFileSync(join(dataDir, "control", "install-manifest.json"), "utf8"),
		) as { targets: Array<{ id: string; path: string; fingerprint: string }> };
		expect(claudeManifest.targets.map((target) => target.id).sort()).toEqual([
			"claude-hook-runtime",
			"claude-hooks",
			"claude-mcp",
			"cli-runtime",
			"opencode-plugin-mcp",
		]);
		expect(claudeManifest.targets.find((target) => target.id === "claude-mcp")?.path).toBe(
			join(claudeHome, ".claude.json"),
		);
		expect(claudeManifest.targets.find((target) => target.id === "claude-hook-runtime")?.path).toBe(
			join(claudeHome, "codemem-hook-runtime.mjs"),
		);
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		const manifest = JSON.parse(
			readFileSync(join(dataDir, "control", "install-manifest.json"), "utf8"),
		) as { targets: Array<{ id: string; path: string; fingerprint: string }> };
		expect(manifest.targets.map((target) => target.id).sort()).toEqual([
			"claude-hook-runtime",
			"claude-hooks",
			"claude-mcp",
			"cli-runtime",
			"opencode-mcp",
			"opencode-plugin",
			"opencode-plugin-compat",
			"opencode-plugin-source",
		]);
		expect(manifest.targets.find((target) => target.id === "cli-runtime")?.path).toBe(
			runtime.cliPath,
		);
		expect(manifest.targets.find((target) => target.id === "opencode-plugin-source")?.path).toBe(
			runtime.opencodePluginPath,
		);
		expect(manifest.targets.find((target) => target.id === "opencode-plugin-compat")?.path).toBe(
			resolve(dirname(runtime.opencodePluginPath), "../lib/compat.js"),
		);
		expect(manifest.targets.every((target) => /^[a-f0-9]{64}$/.test(target.fingerprint))).toBe(
			true,
		);
		const manifestBeforeContention = readFileSync(
			join(dataDir, "control", "install-manifest.json"),
			"utf8",
		);
		const configBeforeContention = readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8");
		const wrapperBeforeContention = readFileSync(
			join(opencodeDir, "plugins", "codemem.js"),
			"utf8",
		);
		const heldSetupLock = acquireSpoolLock(dataDir);
		try {
			process.exitCode = undefined;
			await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
			expect(process.exitCode).toBe(1);
			expect(readFileSync(join(dataDir, "control", "install-manifest.json"), "utf8")).toBe(
				manifestBeforeContention,
			);
			expect(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8")).toBe(
				configBeforeContention,
			);
			expect(readFileSync(join(opencodeDir, "plugins", "codemem.js"), "utf8")).toBe(
				wrapperBeforeContention,
			);
		} finally {
			heldSetupLock.close();
		}

		const blockedDataDir = join(codexHome, "blocked-setup-data");
		mkdirSync(blockedDataDir, { recursive: true });
		writeFileSync(join(blockedDataDir, "control"), "not-a-directory\n", "utf8");
		process.env.CODEMEM_DATA_DIR = blockedDataDir;
		const beforeFailedLane = JSON.parse(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8"));
		beforeFailedLane.mcp.codemem.enabled = false;
		writeFileSync(
			join(opencodeDir, "opencode.jsonc"),
			`${JSON.stringify(beforeFailedLane, null, 2)}\n`,
			"utf8",
		);
		const beforeFailedLaneText = readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8");
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(join(opencodeDir, "opencode.jsonc"), "utf8")).toBe(beforeFailedLaneText);
		expect(readFileSync(join(blockedDataDir, "control"), "utf8")).toBe("not-a-directory\n");

		process.env.CODEMEM_DATA_DIR = dataDir;
		const configPath = join(opencodeDir, "opencode.jsonc");
		const replacementPath = `${configPath}.race-replacement`;
		const replacementText = '{"mcp":{"codemem":{"type":"local","command":["replacement"]}}}\n';
		writeFileSync(replacementPath, replacementText, "utf8");
		setupSnapshotRace.path = configPath;
		setupSnapshotRace.replacementPath = replacementPath;
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(configPath, "utf8")).toBe(replacementText);
		writeFileSync(configPath, '{"plugin":["codemem"],"mcp":{}}\n', "utf8");
		const interleavedConfig = '{"mcp":{},"user":"concurrent"}\n';
		setupSnapshotRace.afterRename = configPath;
		setupSnapshotRace.mutationPath = configPath;
		setupSnapshotRace.mutationText = interleavedConfig;
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(configPath, "utf8")).toBe(interleavedConfig);
		writeFileSync(configPath, '{"plugin":["codemem"],"mcp":{}}\n', "utf8");
		const siblingConfigPath = join(opencodeDir, "opencode.json");
		const siblingConfig = '{"mcp":{},"user":"concurrent sibling"}\n';
		setupSnapshotRace.afterRename = configPath;
		setupSnapshotRace.mutationPath = siblingConfigPath;
		setupSnapshotRace.mutationText = siblingConfig;
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(siblingConfigPath, "utf8")).toBe(siblingConfig);
		rmSync(siblingConfigPath);

		const racedWrapperPath = join(opencodeDir, "plugins", "codemem.js");
		for (const afterRename of [`${racedWrapperPath}.codemem.bak`, racedWrapperPath]) {
			const mutationText = `// concurrent unmanaged wrapper after ${afterRename}\n`;
			expect(installMcp(true, runtime)).toBe(true);
			writeFileSync(racedWrapperPath, "// previously managed wrapper\n", "utf8");
			writeSetupInstallManifest([{ id: "opencode-plugin", path: racedWrapperPath }], dataDir);
			setupSnapshotRace.afterRename = afterRename;
			setupSnapshotRace.mutationPath = racedWrapperPath;
			setupSnapshotRace.mutationText = mutationText;
			process.exitCode = undefined;
			await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
			expect(process.exitCode).toBe(1);
			expect(readFileSync(racedWrapperPath, "utf8")).toBe(mutationText);
		}
		expect(installMcp(true, runtime)).toBe(true);
		writeFileSync(racedWrapperPath, "// previously managed wrapper\n", "utf8");
		writeSetupInstallManifest([{ id: "opencode-plugin", path: racedWrapperPath }], dataDir);
		setupSnapshotRace.afterTempWrite = racedWrapperPath;
		setupSnapshotRace.mutationPath = racedWrapperPath;
		setupSnapshotRace.mutationText = "// concurrent wrapper during temp write\n";
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(racedWrapperPath, "utf8")).toBe(
			"// concurrent wrapper during temp write\n",
		);
		rmSync(racedWrapperPath);
		setupSnapshotRace.beforeLink = racedWrapperPath;
		setupSnapshotRace.mutationPath = racedWrapperPath;
		setupSnapshotRace.mutationText = "// concurrent newly created wrapper\n";
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only"]);
		expect(process.exitCode).toBe(1);
		expect(readFileSync(racedWrapperPath, "utf8")).toBe("// concurrent newly created wrapper\n");

		process.env.CODEMEM_DATA_DIR = join(codexHome, "wrapper-preflight-data");
		const blockedWrapperPath = join(opencodeDir, "plugins", "codemem.js");
		rmSync(blockedWrapperPath);
		mkdirSync(blockedWrapperPath);
		process.exitCode = undefined;
		await setupCommand.parseAsync(["node", "codemem", "--opencode-only", "--force"]);
		expect(process.exitCode).toBe(1);
		expect(lstatSync(blockedWrapperPath).isDirectory()).toBe(true);
	});
});

describe("buildCodememCodexHookGroups — command base", () => {
	it("uses a direct `codemem` call with the outer watchdog", () => {
		const groups = buildCodememCodexHookGroups("codemem");
		const ups = groups.UserPromptSubmit?.[0]?.hooks ?? [];
		expect(ups[0]).toEqual({
			type: "command",
			command: "codemem codex-hook-inject",
			timeout: 5,
			statusMessage: "codemem recall",
		});
		expect(ups).toHaveLength(1);
		expect(groups.SessionStart?.[0]?.hooks?.[0]?.command).toBe("codemem codex-hook-ingest");
	});

	it("uses the same watchdog for the npx fallback", () => {
		const groups = buildCodememCodexHookGroups("npx -y codemem");
		const ups = groups.UserPromptSubmit?.[0]?.hooks ?? [];
		expect(ups[0]).toEqual({
			type: "command",
			command: "npx -y codemem codex-hook-inject",
			timeout: 5,
			statusMessage: "codemem recall",
		});
		expect(ups).toHaveLength(1);
		expect(groups.Stop?.[0]?.hooks?.[0]?.command).toBe("npx -y codemem codex-hook-ingest");
	});
});

describe("installCodex — config.toml MCP detection edge cases", () => {
	it("does not treat a sibling [mcp_servers.codemem-foo] table as ours (appends our block)", () => {
		writeFileSync(
			join(codexHome, "config.toml"),
			'[mcp_servers.codemem-foo]\ncommand = "x"\n',
			"utf-8",
		);

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml).toContain("[mcp_servers.codemem-foo]");
		// Our real block was appended (distinct from the sibling).
		expect(toml.split("[mcp_servers.codemem]").length - 1).toBe(1);

		for (const embeddedExample of [
			[
				'documentation = """',
				"[mcp_servers.codemem]",
				'command = "example"',
				'args = ["mcp"]',
				'"""',
			],
			["documentation = '''", "[mcp_servers.codemem.env]", 'TOKEN = "example"', "'''"],
		]) {
			const config = [...embeddedExample, "", "[mcp_servers.other]", 'command = "other"', ""].join(
				"\n",
			);
			writeFileSync(join(codexHome, "config.toml"), config, "utf-8");
			expect(installCodex(true)).toBe(true);
			const installed = readConfigToml();
			expect(installed).toContain(config);
			expect(installed.lastIndexOf("[mcp_servers.codemem]")).toBeGreaterThan(
				installed.indexOf("[mcp_servers.other]"),
			);
		}

		const dottedAfterNestedArray = [
			"documentation = [",
			'  ["not-a-table"]',
			"]",
			'mcp_servers.codemem.command = "custom"',
			'mcp_servers.codemem.args = ["mcp"]',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), dottedAfterNestedArray, "utf-8");
		expect(installCodex(false)).toBe(false);
		expect(readConfigToml()).toBe(dottedAfterNestedArray);
	});

	it('detects a quoted [mcp_servers."codemem"] table and does not append a duplicate', () => {
		for (const header of [
			'[mcp_servers."codemem"]',
			"[mcp_servers.'codemem']",
			'["mcp_servers".codemem]',
			"['mcp_servers'.'codemem']",
		]) {
			writeFileSync(
				join(codexHome, "config.toml"),
				`${header}\ncommand = "npx"\nargs = [\n  "-y",\n  "codemem",\n  "mcp",\n]\n`,
				"utf-8",
			);
			expect(installCodex(false)).toBe(true);
			const toml = readConfigToml();
			expect(toml).not.toContain(header);
			expect(toml.match(/\[mcp_servers\.codemem\]/g)).toHaveLength(1);
			expect(toml).toContain(`command = ${JSON.stringify(process.execPath)}`);
		}
		for (const custom of [
			'mcp_servers.codemem.command = "custom"\nmcp_servers.codemem.args = ["mcp"]\n',
			"mcp_servers.codemem = {} other = { important = 1 }\n",
			'mcp_servers = { codemem = { command = "custom", args = ["mcp"] }, other = { command = "other" } }\n',
			'mcp_servers={codemem={command="custom",args=["mcp"]}}\n',
			'mcp_servers = { codemem.command = "custom", codemem.args = ["mcp"] }\n',
			'mcp_servers = { other = { command = "other" } }\n',
			"mcp_servers = {}\n",
			"mcp_servers = []\n",
			'mcp_servers = "custom"\n',
			'[mcp_servers]\ncodemem = { command = "custom", args = ["mcp"] }\n',
			'[mcp_servers]\r\ncodemem = { command = "custom", args = ["mcp"] }\r\n',
			'[mcp_servers]\ncodemem.command = "custom"\ncodemem.args = ["mcp"]\n',
			'[mcp_servers.codemem.env]\nNODE_OPTIONS = "--require=/tmp/payload.cjs"\n',
			'[mcp_servers.codemem]\ncommand = "npx"\nargs = ["-y", "codemem", "mcp"]\n\n[mcp_servers.codemem.env]\nNODE_OPTIONS = "--require=/tmp/payload.cjs"\n',
			'["mcp\\u005fservers"."codemem"]\ncommand = "custom"\nargs = ["mcp"]\n',
			'[mcp_servers.codemem]\ncommand = "npx"\nargs = ["-y", "codemem", "mcp"]\n\n[mcp_servers."code\\u006dem".env]\nNODE_OPTIONS = "--require=/tmp/payload.cjs"\n',
			'[mcp_servers]\n"code\\u006dem" = { command = "custom", args = ["mcp"] }\n',
			'[mcp_servers.codemem] [unrelated]\ncommand = "npx"\nargs = ["-y", "codemem", "mcp"]\n',
			'[[mcp_servers]]\nname = "custom"\n',
			'mcp_servers.codemem = """\ncommand = "custom"\nargs = ["mcp"]\n"""\n',
			'[[mcp_servers.codemem]]\ncommand = "custom"\nargs = ["mcp"]\n',
			'[mcp_servers.codemem]\ncommand = "custom"\nargs = ["mcp"]\n\n[mcp_servers.codemem]\ncommand = "other"\nargs = ["mcp"]\n',
		]) {
			writeFileSync(join(codexHome, "config.toml"), custom, "utf8");
			expect(installCodex(false)).toBe(false);
			expect(installCodex(true)).toBe(false);
			expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(custom);
		}
	});

	it("tolerates whitespace inside the table header", () => {
		writeFileSync(
			join(codexHome, "config.toml"),
			'[ mcp_servers . codemem ]\ncommand = "npx"\nargs = ["-y", "codemem", "mcp"]\n',
			"utf-8",
		);

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml.match(/\[mcp_servers\.codemem\]/g)).toHaveLength(1);
		expect(toml).toContain(`command = ${JSON.stringify(process.execPath)}`);
	});
});

describe("installCodex — malformed hooks.json", () => {
	it("returns false and does not clobber an unparseable hooks.json", () => {
		const broken = "{ this is not valid json ";
		const hooksPath = join(codexHome, "hooks.json");
		writeFileSync(hooksPath, broken, "utf-8");

		expect(installCodex(false)).toBe(false);
		// File left untouched (no overwrite, no backup-then-replace).
		expect(readFileSync(hooksPath, "utf-8")).toBe(broken);

		for (const malformedRoot of ["null\n", "[]\n"]) {
			writeFileSync(hooksPath, malformedRoot, "utf-8");
			expect(installCodex(false)).toBe(false);
			expect(readFileSync(hooksPath, "utf-8")).toBe(malformedRoot);
		}

		mkdirSync(claudeHome, { recursive: true });
		const settingsPath = join(claudeHome, "settings.json");
		writeFileSync(settingsPath, broken, "utf8");
		expect(installClaude(false)).toBe(false);
		expect(readFileSync(settingsPath, "utf8")).toBe(broken);
		expect(existsSync(join(claudeHome, "codemem-hook-runtime.mjs"))).toBe(false);

		writeFileSync(settingsPath, "{}\n", "utf8");
		const mcpPath = join(claudeHome, ".claude.json");
		writeFileSync(mcpPath, broken, "utf8");
		expect(installClaude(false)).toBe(false);
		expect(readFileSync(mcpPath, "utf8")).toBe(broken);
		expect(existsSync(join(claudeHome, "codemem-hook-runtime.mjs"))).toBe(false);
	});
});

describe("installCodex — backups", () => {
	it("backs up an existing config.toml before appending", () => {
		const original = '[mcp_servers.other]\ncommand = "x"\n';
		writeFileSync(join(codexHome, "config.toml"), original, "utf-8");

		expect(installCodex(false)).toBe(true);

		const backup = join(codexHome, "config.toml.codemem.bak");
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(backup, "utf-8")).toBe(original);
	});

	it("backs up an existing hooks.json before overwriting", () => {
		const existing = {
			hooks: {
				SessionStart: [
					{ hooks: [{ type: "command", command: "echo x", timeout: 1, statusMessage: "x" }] },
				],
			},
		};
		const serialized = `${JSON.stringify(existing, null, 2)}\n`;
		writeFileSync(join(codexHome, "hooks.json"), serialized, "utf-8");

		expect(installCodex(false)).toBe(true);

		const backup = join(codexHome, "hooks.json.codemem.bak");
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(backup, "utf-8")).toBe(serialized);
	});
});
