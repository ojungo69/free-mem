import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpcContent } from "../content.js";
import { buildFilters, resolveWriteProject } from "../project-scope.js";
import { mcpRequestId } from "../rpc-client.js";
import { filterSchema, memoryKindSchema } from "../schemas.js";
import type { ToolRegistrationContext } from "../tool-context.js";

export function registerItemTools(server: McpServer, context: ToolRegistrationContext): void {
	const { client, envProject } = context;

	server.tool(
		"memory_get",
		"Fetch a single memory item by ID.",
		{
			memory_id: z.number().int().positive().describe("Memory ID"),
			...filterSchema,
		},
		async (args, extra) => {
			const filters = buildFilters(args, null);
			return rpcContent(
				await client.request("GET /v1/memories/:id", {
					id: args.memory_id,
					requestId: mcpRequestId("memory_get", extra?.requestId),
					...(filters ?? {}),
				}),
				(result) => result.item ?? { error: { code: "not_found", message: "Memory not found." } },
			);
		},
	);

	server.tool(
		"memory_get_observations",
		"Fetch multiple memory items by their IDs.",
		{
			ids: z.array(z.number().int().positive()).min(1).max(200).describe("Memory IDs to fetch"),
			...filterSchema,
		},
		async (args, extra) => {
			const filters = buildFilters(args, null);
			return rpcContent(
				await client.request("POST /v1/search", {
					requestId: mcpRequestId("memory_get_observations", extra?.requestId),
					mode: "get_many",
					ids: args.ids,
					...(filters ? { filters } : {}),
				}),
				(result) => ({ items: result.items ?? [] }),
			);
		},
	);

	server.tool(
		"memory_remember",
		"Create a new memory. Use for milestones, decisions, and notable facts.",
		{
			kind: memoryKindSchema.describe("Memory kind"),
			title: z.string().min(1).max(1_024).describe("Short title"),
			body: z.string().min(1).max(16_384).describe("Body text (high-signal content)"),
			confidence: z.number().min(0).max(1).default(0.5).describe("Confidence 0-1"),
			project: z.string().max(512).optional().describe("Project identifier"),
		},
		async (args, extra) => {
			const project = resolveWriteProject({ project: args.project, envProject: envProject() });
			return rpcContent(
				await client.remember({
					idempotencyKey: mcpRequestId("memory_remember", extra?.requestId),
					kind: args.kind,
					title: args.title,
					body: args.body,
					confidence: args.confidence,
					...(project ? { project } : {}),
				}),
				(result) =>
					result.status === "queued" ? result : { id: result.memoryId, status: "committed" },
			);
		},
	);

	server.tool("memory_status", "Show local memory daemon status.", {}, async () =>
		rpcContent(await client.request("GET /v1/health", {})),
	);
}
