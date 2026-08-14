import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import {
	type AgentMemoryConfig,
	buildNormalizedEventFromClaudeHook,
	buildNormalizedEventFromCodexHook,
	callDaemonRpc,
	DEFAULT_DATA_DIR,
	HOOK_DELIVERY_BUDGETS,
	LOCAL_API_VERSION,
	NORMALIZED_EVENT_FIELDS,
	NORMALIZED_SCHEMA_VERSION,
	parseAgentMemoryToml,
	preprocessAdapterEvent,
	RPC_CAPABILITY_HASH,
	RPC_MAX_BYTES,
	resolveStorageLayout,
	type SpoolRedactionMetadata,
	sealDegradedNormalizedEvent,
	spoolMutation,
	VERSION,
	validateNormalizedEvent,
} from "@codemem/core";
import { logHookEvent } from "./claude-hook-plugin-log.js";
import { extractModifiedPathsFromHook } from "./claude-hook-session-state.js";

export type HookAgent = "claude" | "codex";

type RpcOptions = { dataDir?: string; rpcTimeoutMs?: number; deadlineAtMs?: number };

export type HookPackResult = { packText: string; items: number; packTokens: number };

export type PreparedHookEvent =
	| {
			status: "skipped";
			deadlineAtMs: number;
			config?: AgentMemoryConfig;
	  }
	| {
			status: "ready";
			deadlineAtMs: number;
			event: Record<string, unknown>;
			redaction: SpoolRedactionMetadata;
			config?: AgentMemoryConfig;
			safePrompt: string;
	  };

type DeliveryOptions = RpcOptions & { prepared?: PreparedHookEvent };
type PackOptions = RpcOptions & { config?: AgentMemoryConfig };

const NATIVE_CLI_VERSION: Record<HookAgent, string> = {
	claude: "2.1.228 (Claude Code)",
	codex: "codex-cli 0.147.0",
};

const PROJECT_CONFIG_MAX_BYTES = 64 * 1024;
const HOOK_RPC_RESPONSE_MAX_BYTES = 256 * 1024;

const HOOK_RPC_TIMEOUT_MS: Record<HookAgent, number> = {
	claude: HOOK_DELIVERY_BUDGETS.claude.rpcCutoffMs,
	codex: HOOK_DELIVERY_BUDGETS.codex.rpcCutoffMs,
};

function hookDataDir(dataDir?: string): string {
	const configured = process.env.CODEMEM_DATA_DIR?.trim();
	return dataDir ?? (configured || DEFAULT_DATA_DIR);
}

function projectRoot(cwd: unknown): string | null {
	if (typeof cwd !== "string" || !isAbsolute(cwd.trim())) return null;
	let current = resolve(cwd.trim());
	try {
		if (!statSync(current).isDirectory()) current = dirname(current);
	} catch {
		return null;
	}
	for (let depth = 0; depth < 64; depth += 1) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

function configuredPathMatches(
	path: string,
	root: string,
	cwd: string,
	patterns: string[],
): boolean {
	const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	const repositoryPath = relative(root, absolute).replaceAll("\\", "/");
	if (
		!repositoryPath ||
		repositoryPath === ".." ||
		repositoryPath.startsWith("../") ||
		isAbsolute(repositoryPath)
	) {
		return false;
	}
	return patterns.some((rawPattern) => {
		const pattern = rawPattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
		if (!pattern) return false;
		const prefix = pattern.replace(/\/+$/, "");
		if (repositoryPath === prefix || repositoryPath.startsWith(`${prefix}/`)) return true;
		try {
			return matchesGlob(repositoryPath, pattern);
		} catch {
			return false;
		}
	});
}

function hookPaths(payload: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const toolInput = payload.tool_input;
	if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
		for (const field of ["filePath", "file_path", "path"]) {
			const value = (toolInput as Record<string, unknown>)[field];
			if (typeof value === "string" && value.trim()) paths.push(value.trim());
		}
	}
	if (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) {
		paths.push(payload.transcript_path.trim());
	}
	paths.push(...extractModifiedPathsFromHook(payload));
	return paths;
}

function loadHookPolicy(payload: Record<string, unknown>): {
	config?: AgentMemoryConfig;
	ignored: boolean;
	localOnly: boolean;
} {
	const root = projectRoot(payload.cwd);
	if (!root) return { ignored: false, localOnly: false };
	const configPath = join(root, ".agent-memory.toml");
	if (!existsSync(configPath)) return { ignored: false, localOnly: false };
	let config: AgentMemoryConfig;
	try {
		const stat = statSync(configPath);
		if (!stat.isFile() || stat.size > PROJECT_CONFIG_MAX_BYTES) {
			return { ignored: true, localOnly: false };
		}
		config = parseAgentMemoryToml(readFileSync(configPath, "utf8"));
	} catch {
		return { ignored: true, localOnly: false };
	}
	const paths = hookPaths(payload);
	const cwd = resolve(String(payload.cwd));
	return {
		config,
		ignored: paths.some((path) => configuredPathMatches(path, root, cwd, config.ignorePaths)),
		localOnly: paths.some((path) => configuredPathMatches(path, root, cwd, config.localOnlyPaths)),
	};
}

function promptFromEvent(event: Record<string, unknown>): string {
	const payload = event.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
	const adapter = (payload as Record<string, unknown>)._adapter;
	if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) return "";
	const adapterPayload = (adapter as Record<string, unknown>).payload;
	if (!adapterPayload || typeof adapterPayload !== "object" || Array.isArray(adapterPayload)) {
		return "";
	}
	const text = (adapterPayload as Record<string, unknown>).text;
	return typeof text === "string" ? text.trim().replace(/\n/g, " ") : "";
}

function reportSpoolWarning(message: string): void {
	try {
		writeSync(2, `[codemem] ${message}\n`);
	} catch {
		// The supervisor still returns the exact fail-open hook result.
	}
	logHookEvent(`hook.spool ${message}`);
}

export function prepareHookEvent(
	agent: HookAgent,
	payload: Record<string, unknown>,
	deadlineAtMs = performance.now() + HOOK_DELIVERY_BUDGETS[agent].clientHardCapMs,
): PreparedHookEvent {
	const policy = loadHookPolicy(payload);
	if (policy.ignored) {
		return { status: "skipped", deadlineAtMs, config: policy.config };
	}
	const event =
		agent === "claude"
			? buildNormalizedEventFromClaudeHook(payload)
			: buildNormalizedEventFromCodexHook(payload);
	if (!event) {
		return { status: "skipped", deadlineAtMs, config: policy.config };
	}
	const redacted = preprocessAdapterEvent(event, {
		allowlist: [...NORMALIZED_EVENT_FIELDS],
		metadataKeys: NORMALIZED_EVENT_FIELDS.filter((field) => field !== "payload"),
		config: policy.config,
	});
	const rpcEvent = redacted.degraded
		? sealDegradedNormalizedEvent(redacted.payload)
		: redacted.payload;
	if (!Object.hasOwn(rpcEvent, "payload")) rpcEvent.payload = {};
	const sensitivity = redacted.degraded ? "secret" : redacted.sensitivity;
	rpcEvent.sensitivity = sensitivity;
	if (sensitivity === "secret") rpcEvent.payload = {};
	validateNormalizedEvent(rpcEvent);
	const adapterRedaction: SpoolRedactionMetadata = {
		sensitivity,
		secret_rules_version: redacted.secret_rules_version,
		redaction_degraded: redacted.degraded,
		private_content_omitted: redacted.private_content_omitted,
		local_only: redacted.local_only || policy.localOnly,
	};
	return {
		status: "ready",
		deadlineAtMs,
		event: rpcEvent,
		redaction: adapterRedaction,
		config: policy.config,
		safePrompt: redacted.sensitivity === "secret" ? "" : promptFromEvent(rpcEvent),
	};
}

export async function requestHookRpc(
	agent: HookAgent,
	method: string,
	body: Record<string, unknown>,
	options: RpcOptions = {},
): Promise<Record<string, unknown>> {
	let timeoutMs = options.rpcTimeoutMs ?? HOOK_RPC_TIMEOUT_MS[agent];
	if (options.deadlineAtMs !== undefined) {
		const remaining = Math.floor(options.deadlineAtMs - performance.now());
		if (remaining < 1) throw new Error("hook RPC deadline exhausted");
		timeoutMs = Math.min(timeoutMs, remaining);
	}
	const result = await callDaemonRpc(
		resolveStorageLayout(hookDataDir(options.dataDir)).socketPath,
		{
			id: randomUUID(),
			method,
			adapter_version: VERSION,
			native_cli_version: NATIVE_CLI_VERSION[agent],
			normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
			local_api_version: LOCAL_API_VERSION,
			capability_hash: RPC_CAPABILITY_HASH,
			body,
		},
		{
			timeoutMs,
			signal: AbortSignal.timeout(timeoutMs),
			maxResponseBytes:
				method === "POST /v1/context/pack" ? HOOK_RPC_RESPONSE_MAX_BYTES : RPC_MAX_BYTES,
		},
	);
	if ("error" in result) throw new Error(`hook RPC failed: ${result.error.code}`);
	return result.result;
}

export async function deliverHookEvent(
	agent: HookAgent,
	payload: Record<string, unknown>,
	options: DeliveryOptions = {},
): Promise<{ via: "rpc" | "spool" | "skipped" | "dropped" }> {
	let prepared: PreparedHookEvent;
	try {
		prepared = options.prepared ?? prepareHookEvent(agent, payload);
	} catch {
		return { via: "dropped" };
	}
	if (prepared.status === "skipped") return { via: "skipped" };
	const idempotencyKey = String(prepared.event.idempotencyKey);
	const body = {
		idempotencyKey,
		event: prepared.event,
		adapterRedaction: prepared.redaction,
	};
	const budget = HOOK_DELIVERY_BUDGETS[agent];
	try {
		await requestHookRpc(agent, "POST /v1/events", body, {
			...options,
			rpcTimeoutMs: Math.min(options.rpcTimeoutMs ?? budget.rpcCutoffMs, budget.rpcCutoffMs),
			deadlineAtMs: prepared.deadlineAtMs - budget.spoolReserveMs,
		});
		return { via: "rpc" };
	} catch {
		const remaining = prepared.deadlineAtMs - performance.now();
		if (remaining <= budget.fsyncMarginMs) return { via: "dropped" };
		const lockBudget = Math.max(
			1,
			Math.min(budget.spoolLockWaitMs, remaining - budget.fsyncMarginMs),
		);
		const spooled = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey,
				body: { idempotencyKey, event: prepared.event },
			},
			{
				dataDir: hookDataDir(options.dataDir),
				config: prepared.config,
				previousRedaction: prepared.redaction,
				lockDeadlineMs: Math.floor(lockBudget),
				onWarning: reportSpoolWarning,
			},
		);
		return { via: spooled.status === "dropped" ? "dropped" : "spool" };
	}
}

export async function requestHookPack(
	agent: HookAgent,
	input: {
		context: string;
		project: string | null;
		workingSetPaths?: string[];
		limit: number;
		tokenBudget: number;
	},
	options: PackOptions = {},
): Promise<HookPackResult> {
	const redacted = preprocessAdapterEvent(
		{
			context: input.context,
			project: input.project,
			workingSetPaths: input.workingSetPaths,
		},
		{ allowlist: ["context", "project", "workingSetPaths"], config: options.config },
	);
	if (redacted.sensitivity === "secret" || redacted.local_only) {
		return { packText: "", items: 0, packTokens: 0 };
	}
	const context =
		typeof redacted.payload.context === "string" ? redacted.payload.context.trim() : "";
	if (!context) return { packText: "", items: 0, packTokens: 0 };
	const originalPaths = input.workingSetPaths ?? [];
	const workingSetPaths = Array.isArray(redacted.payload.workingSetPaths)
		? redacted.payload.workingSetPaths.filter(
				(value, index): value is string =>
					typeof value === "string" && value === originalPaths[index],
			)
		: [];
	const filters: Record<string, unknown> = {};
	if (redacted.payload.project === input.project && typeof input.project === "string") {
		filters.project = input.project;
	}
	if (workingSetPaths.length) filters.working_set_paths = workingSetPaths;
	const result = await requestHookRpc(
		agent,
		"POST /v1/context/pack",
		{
			requestId: randomUUID(),
			context,
			limit: input.limit,
			tokenBudget: input.tokenBudget,
			filters,
		},
		options,
	);
	const pack = result.pack;
	if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
		return { packText: "", items: 0, packTokens: 0 };
	}
	const value = pack as Record<string, unknown>;
	const metrics =
		value.metrics && typeof value.metrics === "object" && !Array.isArray(value.metrics)
			? (value.metrics as Record<string, unknown>)
			: {};
	return {
		packText: String(value.pack_text ?? "").trim(),
		items: Array.isArray(value.items) ? value.items.length : 0,
		packTokens: Number.isFinite(Number(metrics.pack_tokens)) ? Number(metrics.pack_tokens) : 0,
	};
}
