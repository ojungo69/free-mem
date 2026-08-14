import { Command } from "commander";
import { helpStyle } from "../help-style.js";

const mcpCmd = new Command("mcp")
	.configureHelp(helpStyle)
	.description("Start an MCP server")
	.summary("Start the MCP stdio server");

export const mcpCommand = mcpCmd.action(async () => {
	try {
		await import("@codemem/mcp/stdio");
	} catch (err) {
		console.error(
			`Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exitCode = 1;
	}
});
