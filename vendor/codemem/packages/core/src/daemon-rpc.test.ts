import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "./index.js";

const created: Array<{ stop: () => Promise<void> }> = [];
const dirs: string[] = [];

function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rpc-"));
	dirs.push(dir);
	return join(dir, "data");
}

function handshake(overrides: Partial<core.RpcRequest> = {}): core.RpcRequest {
	return {
		id: "req-1",
		method: "GET /v1/health",
		adapter_version: "1",
		native_cli_version: "1",
		normalized_schema_version: core.SCHEMA_VERSION,
		local_api_version: core.LOCAL_API_VERSION,
		capability_hash: core.RPC_CAPABILITY_HASH,
		...overrides,
	};
}

afterEach(async () => {
	for (const handle of created.splice(0)) {
		try {
			await handle.stop();
		} catch {
			// cleanup
		}
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Phase 1 daemon RPC", () => {
	it("P1-T035-01-handshake-version", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const response = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ local_api_version: core.LOCAL_API_VERSION + 1 }),
		);
		expect(response).toMatchObject({
			error: { code: "protocol_mismatch", retryable: false },
		});
		const schema = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ normalized_schema_version: 0 }),
		);
		expect(schema).toMatchObject({ error: { code: "protocol_mismatch" } });
	});

	it("P1-T035-02-schema-allowlist", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const unknownMethod = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/events" }),
		);
		expect(unknownMethod).toMatchObject({ error: { code: "unknown_method" } });
		const unknownField = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ extra: true } as unknown as core.RpcRequest),
		);
		expect(unknownField).toMatchObject({ error: { code: "unknown_field" } });
		const unknownBodyField = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/health", body: { surprise: 1 } }),
		);
		expect(unknownBodyField).toMatchObject({ error: { code: "unknown_field" } });
	});

	it("P1-T035-03-size-and-deadline", async () => {
		const oversized = await new Promise<string>((resolve, reject) => {
			void core.startDaemon({ dataDir: tempDataDir() }).then((handle) => {
				created.push(handle);
				const socket = createConnection(handle.socketPath);
				let buf = "";
				socket.once("error", reject);
				socket.once("connect", () => {
					socket.write(`${"x".repeat(core.RPC_MAX_BYTES + 1)}\n`);
				});
				socket.on("data", (chunk) => {
					buf += chunk.toString("utf8");
					if (buf.includes("\n")) {
						socket.destroy();
						resolve(buf);
					}
				});
				socket.setTimeout(2000, () => reject(new Error("size probe timed out")));
			});
		});
		expect(JSON.parse(oversized)).toMatchObject({ error: { code: "payload_too_large" } });

		let now = 0;
		const handle = await core.startDaemon({
			dataDir: tempDataDir(),
			rpcDeadlineMs: 50,
			now: () => {
				now += 100;
				return now;
			},
		});
		created.push(handle);
		const late = await core.callDaemonRpc(handle.socketPath, handshake());
		expect(late).toMatchObject({ error: { code: "deadline_exceeded", retryable: true } });
	});

	it("P1-T035-04-health-doctor", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const health = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/health" }),
		);
		expect(health).toMatchObject({
			id: "req-1",
			result: {
				status: "ok",
				instanceId: handle.identity.nonce,
				protocolVersion: {
					localApi: core.LOCAL_API_VERSION,
					normalizedSchema: core.SCHEMA_VERSION,
				},
			},
		});
		const doctor = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/doctor" }),
		);
		expect(doctor).toMatchObject({
			result: {
				status: "ok",
				instanceId: handle.identity.nonce,
				protocolVersion: {
					localApi: core.LOCAL_API_VERSION,
					normalizedSchema: core.SCHEMA_VERSION,
				},
				diagnostics: { lock: "held", socket: "listening" },
			},
		});
	});
});
