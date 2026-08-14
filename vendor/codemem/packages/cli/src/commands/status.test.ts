import type { McpRpcOutcome } from "@codemem/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	boundAttention,
	createStatusCommand,
	renderStatusReport,
	type StatusDependencies,
} from "./status.js";

const daemonUnavailable: McpRpcOutcome = {
	ok: false,
	error: {
		code: "daemon_unavailable",
		message: "The local memory daemon is unavailable.",
		retryable: true,
	},
};

function dependencies(
	overrides: Partial<StatusDependencies> = {},
): StatusDependencies & { stdout: string[]; stderr: string[]; exitCodes: number[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	return {
		now: () => new Date("2026-08-14T00:00:00.000Z"),
		exists: () => false,
		readText: () => null,
		readConfig: () => ({}),
		resolveDbPath: () => "/tmp/codemem/codemem.db",
		requestRpc: async () => daemonUnavailable,
		fetch: vi.fn(async () => {
			throw new Error("viewer unavailable");
		}) as typeof fetch,
		isProcessRunning: () => false,
		env: {},
		writeStdout: (text) => stdout.push(text),
		writeStderr: (text) => stderr.push(text),
		setExitCode: (code) => exitCodes.push(code),
		...overrides,
		stdout,
		stderr,
		exitCodes,
	};
}

afterEach(() => {
	process.exitCode = 0;
	vi.restoreAllMocks();
});

describe("status command", () => {
	it("emits one structured error and exits one on collection failure", async () => {
		const deps = dependencies({
			requestRpc: async () => {
				throw new Error("broken RPC");
			},
		});
		await createStatusCommand(deps).parseAsync(["--json"], { from: "user" });

		expect(deps.stdout).toEqual([
			JSON.stringify({ error: "status_failed", message: "Unable to collect operational status" }),
		]);
		expect(deps.exitCodes).toEqual([1]);
	});

	it("rejects positional arguments as usage errors", async () => {
		const deps = dependencies();
		const command = createStatusCommand(deps);
		await command.parseAsync(["unexpected", "--json"], { from: "user" });

		expect(deps.exitCodes).toEqual([2]);
		expect(command.options.map((option) => option.long)).toEqual(
			expect.arrayContaining(["--db-path", "--config", "--json"]),
		);
	});

	it("caps and bounds attention entries", () => {
		const attention = boundAttention(
			Array.from({ length: 25 }, (_, index) => ({
				code: `unsafe-${index}`,
				severity: "warning" as const,
				message: "x".repeat(600),
			})),
		);
		expect(attention).toHaveLength(20);
		expect(attention[0]?.message).toHaveLength(500);
		expect(
			renderStatusReport({
				checked_at: "2026-08-14T00:00:00.000Z",
				ok: false,
				version: "test",
				daemon: { state: "not_running" },
				database: { state: "missing" },
				runtime: { viewer: "unreachable" },
				maintenance: { state: "unknown" },
				semantic_index: { state: "unknown" },
				raw_events: { state: "unknown", pending: 0 },
				observer: { state: "unconfigured" },
				attention: [],
			}),
		).toContain("Database:       missing");
	});
});
