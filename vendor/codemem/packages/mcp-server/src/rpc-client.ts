import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentMemoryConfig,
	callDaemonRpc,
	DEFAULT_DATA_DIR,
	LOCAL_API_VERSION,
	NORMALIZED_SCHEMA_VERSION,
	parseAgentMemoryToml,
	preprocessAdapterEvent,
	RPC_CAPABILITY_HASH,
	RPC_DEFAULT_DEADLINE_MS,
	type RpcMethod,
	resolveProjectRoot,
	resolveStorageLayout,
	type SpoolRedactionMetadata,
	spoolMutation,
	VERSION,
} from "@codemem/core";

const PROJECT_CONFIG_MAX_BYTES = 64 * 1024;

const RPC_FIELDS = {
	"GET /v1/health": [],
	"GET /v1/memories/:id": ["id", "requestId", "project", "kind"],
	"POST /v1/context/pack": ["requestId", "context", "limit", "tokenBudget", "filters", "trace"],
	"POST /v1/search": [
		"requestId",
		"mode",
		"query",
		"ids",
		"memoryId",
		"depthBefore",
		"depthAfter",
		"includePackContext",
		"filters",
		"limit",
	],
	"POST /v1/memories/record": ["idempotencyKey", "kind", "title", "body", "confidence", "project"],
} as const satisfies Partial<Record<RpcMethod, readonly string[]>>;

const METADATA_FIELDS = new Set([
	"id",
	"requestId",
	"idempotencyKey",
	"mode",
	"ids",
	"memoryId",
	"depthBefore",
	"depthAfter",
	"includePackContext",
	"limit",
	"tokenBudget",
	"trace",
	"kind",
	"confidence",
	"project",
]);

export type McpRpcError = { code: string; message: string; retryable: boolean };
export type McpRpcOutcome =
	| { ok: true; result: Record<string, unknown> }
	| { ok: false; error: McpRpcError };

export interface McpRpcClient {
	request(method: SupportedMcpRpcMethod, body: Record<string, unknown>): Promise<McpRpcOutcome>;
	remember(body: Record<string, unknown>): Promise<McpRpcOutcome>;
}

export type SupportedMcpRpcMethod = keyof typeof RPC_FIELDS;

export interface McpRpcClientOptions {
	dataDir?: string;
	cwd?: () => string;
}

type PreparedRequest = {
	body: Record<string, unknown>;
	config?: AgentMemoryConfig;
	redaction: SpoolRedactionMetadata;
};

export function mcpRequestId(toolName: string, requestId: string | number | undefined): string {
	const value = requestId === undefined ? randomUUID() : String(requestId);
	return createHash("sha256").update(`${toolName}\0${value}`, "utf8").digest("hex");
}

export function createMcpRpcClient(options: McpRpcClientOptions = {}): McpRpcClient {
	const dataDir = () =>
		options.dataDir ?? (process.env.CODEMEM_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
	const cwd = options.cwd ?? (() => process.cwd());

	const prepare = (
		method: SupportedMcpRpcMethod,
		body: Record<string, unknown>,
	): PreparedRequest => {
		const fields = RPC_FIELDS[method];
		const config = fields.length === 0 ? undefined : loadProjectConfig(cwd());
		const redacted = preprocessAdapterEvent(body, {
			allowlist: [...fields],
			metadataKeys: fields.filter((field) => METADATA_FIELDS.has(field)),
			config,
		});
		return {
			body: redacted.payload,
			config,
			redaction: {
				sensitivity: redacted.sensitivity,
				secret_rules_version: redacted.secret_rules_version,
				redaction_degraded: redacted.degraded,
				private_content_omitted: redacted.private_content_omitted,
				local_only: redacted.local_only,
			},
		};
	};

	const send = async (
		method: SupportedMcpRpcMethod,
		prepared: PreparedRequest,
	): Promise<McpRpcOutcome> => {
		try {
			const response = await callDaemonRpc(
				resolveStorageLayout(dataDir()).socketPath,
				{
					id: randomUUID(),
					method,
					adapter_version: VERSION,
					native_cli_version: "mcp-stdio",
					normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
					local_api_version: LOCAL_API_VERSION,
					capability_hash: RPC_CAPABILITY_HASH,
					body: prepared.body,
				},
				{
					timeoutMs: RPC_DEFAULT_DEADLINE_MS,
					signal: AbortSignal.timeout(RPC_DEFAULT_DEADLINE_MS),
				},
			);
			if ("error" in response) return { ok: false, error: response.error };
			return { ok: true, result: response.result };
		} catch {
			return {
				ok: false,
				error: {
					code: "daemon_unavailable",
					message: "The local memory daemon is unavailable.",
					retryable: true,
				},
			};
		}
	};

	return {
		async request(method, body) {
			try {
				return await send(method, prepare(method, body));
			} catch {
				return {
					ok: false,
					error: {
						code: "policy_unavailable",
						message: "Project memory policy could not be loaded safely.",
						retryable: false,
					},
				};
			}
		},

		async remember(body) {
			let prepared: PreparedRequest;
			try {
				prepared = prepare("POST /v1/memories/record", body);
			} catch {
				return {
					ok: false,
					error: {
						code: "policy_unavailable",
						message: "Project memory policy could not be loaded safely.",
						retryable: false,
					},
				};
			}
			const response = await send("POST /v1/memories/record", prepared);
			if (response.ok || !response.error.retryable) return response;

			const idempotencyKey = String(prepared.body.idempotencyKey ?? "");
			const queued = spoolMutation(
				{
					method: "POST /v1/memories/record",
					idempotencyKey,
					body: prepared.body,
				},
				{
					dataDir: dataDir(),
					config: prepared.config,
					previousRedaction: prepared.redaction,
				},
			);
			if (queued.status !== "dropped") {
				return { ok: true, result: { status: "queued", duplicate: queued.status === "duplicate" } };
			}
			return {
				ok: false,
				error: {
					code: "spool_write_failed",
					message: "The memory could not be queued safely.",
					retryable: true,
				},
			};
		},
	};
}

function loadProjectConfig(cwd: string): AgentMemoryConfig | undefined {
	const root = resolveProjectRoot(cwd);
	if (!root) return undefined;
	const path = join(root, ".agent-memory.toml");
	if (!existsSync(path)) return undefined;
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > PROJECT_CONFIG_MAX_BYTES) {
		throw new Error("Project memory policy is invalid.");
	}
	return parseAgentMemoryToml(readFileSync(path, "utf8"));
}
