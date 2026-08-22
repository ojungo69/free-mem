import { join } from "node:path";
import { resolveRuntimeDataDir } from "@codemem/core";
import type { McpRpcOutcome } from "@codemem/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	boundAttention,
	createStatusCommand,
	type OperationalStatusReport,
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

	it("caps and bounds attention entries", async () => {
		const attention = boundAttention(
			Array.from({ length: 25 }, (_, index) => ({
				code: `unsafe-${index}`,
				severity: "warning" as const,
				message: "x".repeat(600),
			})),
		);
		expect(attention).toHaveLength(20);
		expect(attention[0]?.message).toHaveLength(500);
		const report: OperationalStatusReport = {
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
		};
		const rendered = renderStatusReport(report);
		expect(rendered).toContain("Database:       missing");
		expect(rendered).toContain("Viewer:         unreachable\nMaintenance:");
		expect(renderStatusReport({ ...report, runtime: { viewer: "running", pid: 42 } })).toContain(
			"Viewer:         running (pid 42)",
		);

		const previousDataDir = process.env.CODEMEM_DATA_DIR;
		delete process.env.CODEMEM_DATA_DIR;
		try {
			const dbPaths = ["/tmp/codemem/a.sqlite", "/tmp/codemem/b.sqlite"];
			const pidPaths: string[] = [];
			const fetchMock = vi.fn<typeof fetch>();
			const deps = dependencies({
				exists: (path) => {
					pidPaths.push(path);
					return false;
				},
				fetch: fetchMock,
			});
			for (const dbPath of dbPaths) {
				await createStatusCommand(deps).parseAsync(["--db-path", dbPath, "--json"], {
					from: "user",
				});
			}
			expect(pidPaths).toEqual(
				dbPaths.map((dbPath) => join(resolveRuntimeDataDir({ dbPath }), "viewer.pid")),
			);
			expect(new Set(pidPaths).size).toBe(2);
			expect(deps.stdout.map((text) => JSON.parse(text).runtime.viewer)).toEqual([
				"stopped",
				"stopped",
			]);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			if (previousDataDir === undefined) delete process.env.CODEMEM_DATA_DIR;
			else process.env.CODEMEM_DATA_DIR = previousDataDir;
		}
	});
});
