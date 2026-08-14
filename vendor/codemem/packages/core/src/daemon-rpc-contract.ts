import { createHash } from "node:crypto";
import { createConnection } from "node:net";

export const LOCAL_API_VERSION = 1;
export const RPC_MAX_BYTES = 32 * 1024;
export const RPC_DEFAULT_DEADLINE_MS = 2_000;
export const HOOK_DELIVERY_BUDGETS = {
	claude: {
		clientHardCapMs: 2_000,
		rpcCutoffMs: 1_500,
		spoolReserveMs: 500,
		spoolLockWaitMs: 100,
		fsyncMarginMs: 400,
		outerWatchdogMs: 3_000,
	},
	codex: {
		clientHardCapMs: 1_500,
		rpcCutoffMs: 1_000,
		spoolReserveMs: 500,
		spoolLockWaitMs: 100,
		fsyncMarginMs: 400,
		outerWatchdogMs: 5_000,
	},
} as const;

export const RPC_METHODS = [
	"GET /v1/health",
	"GET /v1/doctor",
	"POST /v1/events",
	"POST /v1/events/batch",
	"POST /v1/context/pack",
	"POST /v1/search",
	"POST /v1/retrieval/file-context",
	"POST /v1/retrieval/file-context/delivery",
	"GET /v1/memories/:id",
	"POST /v1/memories/record",
	"DELETE /v1/memories/:id",
	"GET /v1/checkpoints",
	"GET /v1/view",
	"POST /v1/viewer/auth/nonce",
	"POST /v1/viewer/auth/exchange",
	"POST /v1/viewer/auth/verify",
	"POST /v1/viewer/auth/logout",
	"GET /v1/backup/list",
	"POST /v1/backup/create",
	"POST /v1/backup/verify",
	"POST /v1/backup/restore",
	"POST /v1/operations/export",
	"POST /v1/operations/import",
	"GET /v1/operations/:id",
	"POST /v1/jobs",
	"GET /v1/jobs",
	"GET /v1/jobs/:id",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export type FileContextRetrievalAttempt = {
	attemptId: string;
	startedAt: string;
	completedAt: string;
	retrievalStatus: "succeeded" | "no_results" | "skipped" | "failed";
	candidateIds?: number[];
	candidateCount?: number;
	selectedIds?: number[];
	failureCode?: string;
	failureStage?: string;
	project?: string | null;
	repositoryPath?: string;
	sourceSessionId?: string | null;
};

export const RPC_CAPABILITY_HASH = createHash("sha256")
	.update(RPC_METHODS.join("\n"))
	.digest("hex");

export type TypedRpcError = {
	error: { code: string; message: string; retryable: boolean };
};

export type RpcRequest = {
	id: string;
	method: string;
	adapter_version: string;
	native_cli_version: string;
	normalized_schema_version: number;
	local_api_version: number;
	capability_hash: string;
	body?: Record<string, unknown>;
};

export type RpcSuccess = {
	id: string;
	result: Record<string, unknown>;
};

export function callDaemonRpc(
	socketPath: string,
	request: RpcRequest,
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<RpcSuccess | TypedRpcError> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const signal = options?.signal;
		let abortListener: (() => void) | undefined;
		let settled = false;
		const finish = (error?: Error, value?: RpcSuccess | TypedRpcError) => {
			if (settled) return;
			settled = true;
			if (abortListener) signal?.removeEventListener("abort", abortListener);
			socket.destroy();
			if (error) reject(error);
			else resolve(value as RpcSuccess | TypedRpcError);
		};
		abortListener = () => finish(new Error("RPC client aborted"));
		if (signal?.aborted) abortListener();
		else signal?.addEventListener("abort", abortListener, { once: true });
		let buffer = Buffer.alloc(0);
		socket.setTimeout(options?.timeoutMs ?? RPC_DEFAULT_DEADLINE_MS);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) return;
			try {
				finish(
					undefined,
					JSON.parse(buffer.subarray(0, newline).toString("utf8")) as RpcSuccess | TypedRpcError,
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("error", (error) => finish(error));
		socket.once("timeout", () => finish(new Error("RPC client timed out")));
		socket.once("close", () => {
			if (!settled) finish(new Error("RPC connection closed without a response"));
		});
	});
}
