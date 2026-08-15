import { globSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createCodememMcpServer } from "./index.js";
import type { McpRpcClient } from "./rpc-client.js";

const ALLOWED_TOOLS = [
	"memory_expand",
	"memory_explain",
	"memory_get",
	"memory_get_observations",
	"memory_pack",
	"memory_recent",
	"memory_remember",
	"memory_schema",
	"memory_search",
	"memory_search_index",
	"memory_status",
	"memory_timeline",
];

async function connect(clientImpl?: McpRpcClient) {
	const server = createCodememMcpServer({
		client: clientImpl,
		defaultProject: "demo",
		envProject: null,
	});
	const client = new Client({ name: "codemem-test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe("Phase 1 MCP stdio RPC surface", () => {
	it("exports a side-effect-free factory from the package root", () => {
		expect(createCodememMcpServer).toBeTypeOf("function");
	});

	it("P1-T042-01-mcp-minimal-tools", async () => {
		const connection = await connect();
		try {
			const listed = await connection.client.listTools();
			expect(listed.tools.map((tool) => tool.name).toSorted()).toEqual(ALLOWED_TOOLS);
		} finally {
			await connection.close();
		}
	});

	it("P1-T042-02-mcp-user-mutation-denied", async () => {
		const connection = await connect();
		try {
			for (const name of [
				"memory_forget",
				"memory_confirm",
				"memory_pin",
				"memory_unpin",
				"memory_retract",
				"memory_mark_wrong",
				"memory_bulk_delete",
			]) {
				const result = await connection.client.callTool({ name, arguments: {} });
				expect(result).toMatchObject({ isError: true });
				expect(JSON.stringify(result)).toContain(`Tool ${name} not found`);
			}
		} finally {
			await connection.close();
		}
	});

	it("maps every read tool to its fixed daemon endpoint and mode", async () => {
		const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		const remembers: Record<string, unknown>[] = [];
		const fake: McpRpcClient = {
			async request(method, body) {
				calls.push({ method, body });
				if (method === "GET /v1/memories/:id") return { ok: true, result: { item: { id: 7 } } };
				if (method === "POST /v1/context/pack") return { ok: true, result: { pack: {} } };
				if (body.mode === "search") {
					return {
						ok: true,
						result: {
							items: [
								{
									id: 7,
									title: "Result",
									kind: "decision",
									body_text: "Public body",
									confidence: 0.9,
									score: 0.8,
									session_id: 3,
									metadata: { source: "test" },
									created_at: "internal-only",
								},
							],
						},
					};
				}
				if (body.mode === "explain") return { ok: true, result: { items: { items: [] } } };
				return { ok: true, result: { items: [], status: "ok" } };
			},
			async remember(body) {
				remembers.push(body);
				return { ok: true, result: { memoryId: 1 } };
			},
		};
		const connection = await connect(fake);
		try {
			await connection.client.callTool({
				name: "memory_remember",
				arguments: { kind: "decision", title: "title", body: "body" },
			});
			await connection.client.callTool({ name: "memory_status", arguments: {} });
			await connection.client.callTool({ name: "memory_get", arguments: { memory_id: 7 } });
			await connection.client.callTool({
				name: "memory_get_observations",
				arguments: { ids: [7] },
			});
			const search = await connection.client.callTool({
				name: "memory_search",
				arguments: { query: "query" },
			});
			await connection.client.callTool({
				name: "memory_search_index",
				arguments: { query: "query" },
			});
			await connection.client.callTool({ name: "memory_recent", arguments: {} });
			await connection.client.callTool({ name: "memory_explain", arguments: { ids: [7] } });
			await connection.client.callTool({
				name: "memory_timeline",
				arguments: { memory_id: 7 },
			});
			await connection.client.callTool({ name: "memory_expand", arguments: { ids: [7] } });
			await connection.client.callTool({ name: "memory_pack", arguments: { context: "query" } });
			expect(calls.map(({ method, body }) => [method, body.mode ?? null])).toEqual([
				["GET /v1/health", null],
				["GET /v1/memories/:id", null],
				["POST /v1/search", "get_many"],
				["POST /v1/search", "search"],
				["POST /v1/search", "search_index"],
				["POST /v1/search", "recent"],
				["POST /v1/search", "explain"],
				["POST /v1/search", "timeline"],
				["POST /v1/search", "expand"],
				["POST /v1/context/pack", null],
			]);
			expect(JSON.parse((search.content[0] as { text: string }).text)).toEqual({
				items: [
					{
						id: 7,
						title: "Result",
						kind: "decision",
						body: "Public body",
						confidence: 0.9,
						score: 0.8,
						session_id: 3,
						metadata: { source: "test" },
					},
				],
			});
			expect(remembers).toEqual([
				expect.objectContaining({
					idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
					kind: "decision",
					title: "title",
					body: "body",
					confidence: 0.5,
				}),
			]);
			expect(calls.every(({ body }) => !Object.hasOwn(body, "store"))).toBe(true);

			const secondSession = await connect(fake);
			try {
				await secondSession.client.callTool({
					name: "memory_remember",
					arguments: { kind: "decision", title: "title", body: "body" },
				});
			} finally {
				await secondSession.close();
			}
			expect(remembers).toHaveLength(2);
			expect(remembers[1]?.idempotencyKey).not.toBe(remembers[0]?.idempotencyKey);
		} finally {
			await connection.close();
		}
	});

	it("P1-T042-04-mcp-no-db-fallback", () => {
		const files = globSync("**/*.ts", { cwd: import.meta.dirname }).filter(
			(path) => !path.endsWith(".test.ts"),
		);
		const source = files
			.map((path) => readFileSync(`${import.meta.dirname}/${path}`, "utf8"))
			.join("\n");
		expect(source).not.toMatch(/\bMemoryStore\b|\bresolveDbPath\b|better-sqlite3|\bstore\.db\b/);
	});
});
