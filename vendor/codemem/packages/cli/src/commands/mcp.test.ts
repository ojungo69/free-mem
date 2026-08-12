import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpCommand } from "./mcp.js";

const stdioImportMock = vi.hoisted(() => vi.fn());

vi.mock("@codemem/mcp/stdio", () => {
	stdioImportMock();
	return {};
});

describe("mcp command", () => {
	afterEach(() => {
		stdioImportMock.mockClear();
		process.exitCode = undefined;
	});

	it("keeps stdio mode as the default command", () => {
		expect(mcpCommand.name()).toBe("mcp");
		expect(mcpCommand.summary()).toBe("Start the MCP stdio server");
	});

	it("does not expose HTTP mode after carve-out", () => {
		const httpCommand = mcpCommand.commands.find((command) => command.name() === "http");
		expect(httpCommand).toBeUndefined();
	});

	it("runs stdio mode by default", async () => {
		await mcpCommand.parseAsync([], { from: "user" });
		expect(stdioImportMock).toHaveBeenCalledTimes(1);
	});
});
