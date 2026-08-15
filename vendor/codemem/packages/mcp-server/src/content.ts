import type { McpRpcOutcome } from "./rpc-client.js";

export function jsonContent(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function rpcContent(
	outcome: McpRpcOutcome,
	select: (result: Record<string, unknown>) => unknown = (result) => result,
) {
	return jsonContent(outcome.ok ? select(outcome.result) : { error: outcome.error });
}
