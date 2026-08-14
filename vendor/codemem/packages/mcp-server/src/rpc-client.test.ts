import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hashMutationPayload,
	NORMALIZED_SCHEMA_VERSION,
	ReadOnlyActor,
	resolveStorageLayout,
	startDaemon,
} from "@codemem/core";
import { describe, expect, it } from "vitest";
import { createMcpRpcClient, mcpRequestId } from "./rpc-client.js";

function projectFixture() {
	const root = mkdtempSync(join(tmpdir(), "codemem-mcp-rpc-"));
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".agent-memory.toml"), 'secret_regex = ["TOKEN_[A-Z]+"]\n');
	return { root, dataDir: join(root, "data") };
}

function rememberBody(requestId: string) {
	return {
		idempotencyKey: mcpRequestId("memory_remember", requestId),
		kind: "decision",
		title: "Credential rotation",
		body: "Rotate TOKEN_SUPERSECRET before release.",
		confidence: 0.9,
		project: "demo",
	};
}

describe("MCP daemon RPC client", () => {
	it("returns a typed error instead of opening a local database when the daemon is down", async () => {
		const fixture = projectFixture();
		try {
			const client = createMcpRpcClient({ dataDir: fixture.dataDir, cwd: () => fixture.root });
			expect(await client.request("GET /v1/health", {})).toEqual({
				ok: false,
				error: {
					code: "daemon_unavailable",
					message: "The local memory daemon is unavailable.",
					retryable: true,
				},
			});
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("redacts project policy matches before the daemon can persist them", async () => {
		const fixture = projectFixture();
		const daemon = await startDaemon({ dataDir: fixture.dataDir });
		try {
			const client = createMcpRpcClient({ dataDir: fixture.dataDir, cwd: () => fixture.root });
			const remembered = await client.remember(rememberBody("direct-1"));
			expect(remembered).toMatchObject({ ok: true, result: { memoryId: expect.any(Number) } });
			if (!remembered.ok) throw new Error("remember failed");
			const fetched = await client.request("GET /v1/memories/:id", {
				id: remembered.result.memoryId,
				requestId: mcpRequestId("memory_get", "direct-2"),
			});
			expect(JSON.stringify(fetched)).not.toContain("TOKEN_SUPERSECRET");

			const idempotencyKey = "mcp-event-redaction";
			const event = {
				schemaVersion: NORMALIZED_SCHEMA_VERSION,
				eventId: "mcp-event-redaction-1",
				idempotencyKey,
				agent: "opencode",
				nativeSessionId: "mcp-redaction-session",
				projectKey: "demo",
				workspaceKey: fixture.root,
				cwd: fixture.root,
				kind: "user_prompted",
				occurredAt: "2026-08-14T00:00:00.000Z",
				payload: {
					text: "TOKEN_SUPERSECRET <private>hidden</private> <local-only>device</local-only>",
				},
				sourceHash: hashMutationPayload({ secret: "TOKEN_SUPERSECRET" }),
				sensitivity: "normal",
			};
			expect(
				await client.requestWithSpool("POST /v1/events", { idempotencyKey, event }),
			).toMatchObject({ ok: true, result: { receiptId: expect.any(String) } });

			const reader = ReadOnlyActor.open(realpathSync(daemon.layout.currentPointerPath));
			try {
				const row = reader
					.prepare("SELECT payload_json FROM raw_events WHERE event_id = ?")
					.get("mcp-event-redaction-1") as { payload_json: string };
				expect(row.payload_json).not.toContain("TOKEN_SUPERSECRET");
				expect(row.payload_json).not.toContain("hidden");
				expect(row.payload_json).not.toContain("device");
				expect(JSON.parse(row.payload_json)).toMatchObject({
					_normalized: {
						sensitivity: "secret",
						private_content_omitted: true,
						local_only: true,
					},
				});
			} finally {
				reader.close();
			}
		} finally {
			await daemon.stop();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("P1-T042-03-mcp-remember-spool", async () => {
		const fixture = projectFixture();
		try {
			const client = createMcpRpcClient({ dataDir: fixture.dataDir, cwd: () => fixture.root });
			const body = rememberBody("spool-1");
			const queued = await client.remember(body);
			const duplicate = await client.remember(body);
			expect(queued).toMatchObject({ ok: true, result: { status: "queued", duplicate: false } });
			expect(duplicate).toMatchObject({ ok: true, result: { status: "queued", duplicate: true } });

			const readyDir = join(fixture.dataDir, "control", "spool", "ready");
			const files = readdirSync(readyDir);
			expect(files).toHaveLength(1);
			const serialized = readFileSync(join(readyDir, files[0]), "utf8");
			expect(serialized).not.toContain("TOKEN_SUPERSECRET");
			expect(JSON.parse(serialized)).toMatchObject({
				method: "POST /v1/memories/record",
				idempotencyKey: body.idempotencyKey,
				redaction: { sensitivity: "secret" },
			});
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("P1-T046-02-maintenance-spool", async () => {
		const fixture = projectFixture();
		const layout = resolveStorageLayout(fixture.dataDir);
		mkdirSync(layout.controlDir, { recursive: true, mode: 0o700 });
		const server = createServer((socket) => {
			socket.once("data", () => {
				socket.end(
					`${JSON.stringify({
						error: {
							code: "maintenance_mode",
							message: "The daemon is in maintenance mode.",
							retryable: true,
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(layout.socketPath, resolve);
		});
		try {
			const client = createMcpRpcClient({ dataDir: fixture.dataDir, cwd: () => fixture.root });
			const body = rememberBody("maintenance-spool");
			expect(await client.remember(body)).toMatchObject({
				ok: true,
				result: { status: "queued", duplicate: false },
			});
			const readyDir = join(layout.spoolDir, "ready");
			const files = readdirSync(readyDir);
			expect(files).toHaveLength(1);
			expect(readFileSync(join(readyDir, files[0]), "utf8")).not.toContain("TOKEN_SUPERSECRET");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
