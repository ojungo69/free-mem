import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { SCHEMA_VERSION } from "./db.js";

type RpcIdentity = { pid: number; nonce: string };

export const LOCAL_API_VERSION = 1;
export const RPC_MAX_BYTES = 32 * 1024;
export const RPC_DEFAULT_DEADLINE_MS = 2_000;

export const RPC_METHODS = [
	"GET /v1/health",
	"GET /v1/doctor",
	"POST /v1/operations/backup/create",
	"POST /v1/operations/backup/verify",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export const RPC_CAPABILITY_HASH = createHash("sha256")
	.update(RPC_METHODS.join("\n"))
	.digest("hex");

const TOP_LEVEL_FIELDS = new Set([
	"id",
	"method",
	"adapter_version",
	"native_cli_version",
	"normalized_schema_version",
	"local_api_version",
	"capability_hash",
	"body",
]);

const METHOD_BODY_FIELDS: Record<RpcMethod, readonly string[]> = {
	"GET /v1/health": [],
	"GET /v1/doctor": [],
	"POST /v1/operations/backup/create": ["operationId", "payloadHash", "reason"],
	"POST /v1/operations/backup/verify": ["backupId"],
};

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

export type ProtocolVersions = {
	localApi: number;
	normalizedSchema: number;
};

export type DaemonRpcContext = {
	identity: RpcIdentity;
	dataDir: string;
	deadlineMs?: number;
	now?: () => number;
	onStop: () => void;
};

export function mapPeerConnectError(error: NodeJS.ErrnoException): TypedRpcError {
	if (error.code === "EACCES") {
		return typedError("peer_denied", "Peer is not allowed to connect to the daemon socket.");
	}
	if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
		return typedError("daemon_unavailable", "Daemon is not running.", true);
	}
	return typedError("peer_denied", error.message || "Peer connection failed.");
}

function typedError(code: string, message: string, retryable = false): TypedRpcError {
	return { error: { code, message, retryable } };
}

function unknownFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string> | readonly string[],
): string[] {
	const allow = allowed instanceof Set ? allowed : new Set(allowed);
	return Object.keys(value).filter((key) => !allow.has(key));
}

function parseRequest(raw: string): RpcRequest | TypedRpcError {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return typedError("invalid_json", "RPC request is not valid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return typedError("invalid_json", "RPC request must be a JSON object.");
	}
	const object = parsed as Record<string, unknown>;
	const extra = unknownFields(object, TOP_LEVEL_FIELDS);
	if (extra.length > 0) {
		return typedError("unknown_field", `Unknown RPC field: ${extra[0]}`);
	}
	if (typeof object.id !== "string" || object.id.length === 0) {
		return typedError("invalid_request", "RPC request id is required.");
	}
	if (typeof object.method !== "string") {
		return typedError("unknown_method", "RPC method is required.");
	}
	if (
		typeof object.adapter_version !== "string" ||
		typeof object.native_cli_version !== "string" ||
		typeof object.normalized_schema_version !== "number" ||
		typeof object.local_api_version !== "number" ||
		typeof object.capability_hash !== "string"
	) {
		return typedError("protocol_mismatch", "RPC handshake fields are missing or mistyped.");
	}
	if (
		object.body !== undefined &&
		(typeof object.body !== "object" || object.body === null || Array.isArray(object.body))
	) {
		return typedError("invalid_request", "RPC body must be an object.");
	}
	return object as RpcRequest;
}

function handshakeError(request: RpcRequest): TypedRpcError | null {
	if (request.local_api_version !== LOCAL_API_VERSION) {
		return typedError("protocol_mismatch", "local_api_version is incompatible.");
	}
	if (request.normalized_schema_version !== SCHEMA_VERSION) {
		return typedError("protocol_mismatch", "normalized_schema_version is incompatible.");
	}
	if (request.capability_hash !== RPC_CAPABILITY_HASH) {
		return typedError("protocol_mismatch", "capability_hash is incompatible.");
	}
	return null;
}

function isRpcMethod(method: string): method is RpcMethod {
	return (RPC_METHODS as readonly string[]).includes(method);
}

function protocolVersions(): ProtocolVersions {
	return { localApi: LOCAL_API_VERSION, normalizedSchema: SCHEMA_VERSION };
}

function handleMethod(
	method: RpcMethod,
	body: Record<string, unknown>,
	ctx: DaemonRpcContext,
): Record<string, unknown> {
	if (method === "GET /v1/health") {
		return {
			status: "ok",
			instanceId: ctx.identity.nonce,
			protocolVersion: protocolVersions(),
		};
	}
	if (method === "GET /v1/doctor") {
		return {
			status: "ok",
			instanceId: ctx.identity.nonce,
			protocolVersion: protocolVersions(),
			diagnostics: {
				pid: ctx.identity.pid,
				dataDir: ctx.dataDir,
				lock: "held",
				socket: "listening",
				platform: process.platform,
			},
		};
	}
	if (method === "POST /v1/operations/backup/create") {
		return {
			operationId: body.operationId,
			state: "not_implemented",
		};
	}
	return {
		backupId: body.backupId,
		valid: false,
		manifestHash: null,
		diagnostics: ["backup verify is implemented in T050"],
	};
}

export function dispatchDaemonRpc(raw: string, ctx: DaemonRpcContext): RpcSuccess | TypedRpcError {
	const started = (ctx.now ?? Date.now)();
	const deadlineMs = ctx.deadlineMs ?? RPC_DEFAULT_DEADLINE_MS;
	const request = parseRequest(raw);
	if ("error" in request) return request;
	const handshake = handshakeError(request);
	if (handshake) return handshake;
	if (!isRpcMethod(request.method)) {
		return typedError("unknown_method", `Unknown RPC method: ${request.method}`);
	}
	const body = request.body ?? {};
	const extra = unknownFields(body, METHOD_BODY_FIELDS[request.method]);
	if (extra.length > 0) {
		return typedError("unknown_field", `Unknown field for ${request.method}: ${extra[0]}`);
	}
	for (const field of METHOD_BODY_FIELDS[request.method]) {
		if (typeof body[field] !== "string" || body[field].length === 0) {
			return typedError("invalid_request", `${field} is required.`);
		}
	}
	const elapsed = (ctx.now ?? Date.now)() - started;
	if (elapsed >= deadlineMs) {
		return typedError("deadline_exceeded", "RPC hard deadline exceeded.", true);
	}
	return { id: request.id, result: handleMethod(request.method, body, ctx) };
}

export function attachDaemonRpc(connection: Socket, ctx: DaemonRpcContext): void {
	let buffer = Buffer.alloc(0);
	let done = false;
	const finish = (payload?: RpcSuccess | TypedRpcError) => {
		if (done) return;
		done = true;
		if (payload) {
			try {
				connection.end(`${JSON.stringify(payload)}\n`);
				return;
			} catch {
				// connection already closed
			}
		}
		connection.destroy();
	};
	connection.on("data", (chunk: Buffer) => {
		if (done) return;
		if (buffer.length + chunk.length > RPC_MAX_BYTES) {
			finish(typedError("payload_too_large", `RPC request exceeds ${RPC_MAX_BYTES} bytes.`));
			return;
		}
		buffer = Buffer.concat([buffer, chunk]);
		const newline = buffer.indexOf(0x0a);
		if (newline < 0) return;
		const line = buffer.subarray(0, newline).toString("utf8");
		if (line.startsWith("STOP")) {
			const nonce = line.slice(4).trim();
			if (nonce && nonce === ctx.identity.nonce) {
				connection.end(`${JSON.stringify({ status: "stopping" })}\n`);
				ctx.onStop();
			} else {
				connection.end(`${JSON.stringify({ status: "mismatch" })}\n`);
			}
			done = true;
			return;
		}
		finish(dispatchDaemonRpc(line, ctx));
	});
	connection.setTimeout(ctx.deadlineMs ?? RPC_DEFAULT_DEADLINE_MS, () => {
		finish(typedError("deadline_exceeded", "RPC hard deadline exceeded.", true));
	});
}

export function callDaemonRpc(
	socketPath: string,
	request: RpcRequest,
	options?: { timeoutMs?: number },
): Promise<RpcSuccess | TypedRpcError> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (error?: Error, value?: RpcSuccess | TypedRpcError) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(value as RpcSuccess | TypedRpcError);
		};
		let buf = Buffer.alloc(0);
		socket.setTimeout(options?.timeoutMs ?? RPC_DEFAULT_DEADLINE_MS);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const newline = buf.indexOf(0x0a);
			if (newline < 0) return;
			try {
				finish(
					undefined,
					JSON.parse(buf.subarray(0, newline).toString("utf8")) as RpcSuccess | TypedRpcError,
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
