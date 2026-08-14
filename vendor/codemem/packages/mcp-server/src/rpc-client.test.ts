import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@codemem/core";
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
});
