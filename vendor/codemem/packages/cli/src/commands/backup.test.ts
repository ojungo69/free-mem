import { describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("@codemem/mcp", () => ({
	createMcpRpcClient: () => ({ request }),
}));

import { BACKUP_PRIVACY_NOTICE, backupCommand } from "./backup.js";

describe("backup command", () => {
	it("P1-T052-04-backup-privacy-copy", async () => {
		const output = backupCommand.configureOutput();
		const originalExitCode = process.exitCode;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		let help = "";
		try {
			backupCommand.configureOutput({ writeOut: (value) => (help += value) });
			backupCommand.outputHelp();
			backupCommand.configureOutput(output);

			request.mockResolvedValueOnce({ ok: true, result: { backupId: "backup-json" } });
			await backupCommand.parseAsync(["create", "--reason", "release", "--json"], {
				from: "user",
			});
			expect(request).toHaveBeenLastCalledWith("POST /v1/backup/create", {
				operationId: expect.any(String),
				reason: "release",
				payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
				backupId: "backup-json",
				privacy: BACKUP_PRIVACY_NOTICE,
			});

			request.mockResolvedValueOnce({ ok: true, result: { backupId: "backup-human" } });
			await backupCommand.parseAsync(["create"], { from: "user" });

			request.mockResolvedValueOnce({ ok: true, result: { backups: [] } });
			await backupCommand.parseAsync(["list", "--json"], { from: "user" });
			expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ backups: [] });
			request.mockResolvedValueOnce({ ok: true, result: {} });
			await backupCommand.parseAsync(["list"], { from: "user" });
			request.mockResolvedValueOnce({
				ok: true,
				result: {
					backups: [
						{ backupId: "valid", createdAt: "2026-08-15T00:00:00.000Z", valid: true },
						{ backupId: "invalid", valid: false },
					],
				},
			});
			await backupCommand.parseAsync(["list"], { from: "user" });

			request.mockResolvedValueOnce({
				ok: true,
				result: { backupId: "valid", valid: true },
			});
			await backupCommand.parseAsync(["verify", "valid", "--json"], { from: "user" });
			request.mockResolvedValueOnce({
				ok: true,
				result: { backupId: "valid", valid: true },
			});
			await backupCommand.parseAsync(["verify", "valid"], { from: "user" });
			request.mockResolvedValueOnce({
				ok: true,
				result: { backupId: "invalid-json", valid: false },
			});
			process.exitCode = 0;
			await backupCommand.parseAsync(["verify", "invalid-json", "--json"], { from: "user" });
			expect(process.exitCode).toBe(1);
			request.mockResolvedValueOnce({
				ok: true,
				result: { backupId: "invalid-human", valid: false },
			});
			process.exitCode = 0;
			await backupCommand.parseAsync(["verify", "invalid-human"], { from: "user" });
			expect(process.exitCode).toBe(1);

			request.mockResolvedValueOnce({
				ok: true,
				result: { backupId: "restore-json", state: "completed" },
			});
			await backupCommand.parseAsync(["restore", "restore-json", "--json"], { from: "user" });
			expect(request).toHaveBeenLastCalledWith("POST /v1/backup/restore", {
				operationId: expect.any(String),
				backupId: "restore-json",
				payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			request.mockResolvedValueOnce({
				ok: true,
				result: { backupId: "restore-human", state: "completed" },
			});
			await backupCommand.parseAsync(["restore", "restore-human"], { from: "user" });

			const failure = {
				ok: false,
				error: { code: "daemon_unavailable", message: "daemon down", retryable: true },
			};
			const failureCases: Array<[string[], boolean]> = [
				[["create", "--json"], true],
				[["list"], false],
				[["verify", "missing", "--json"], true],
				[["restore", "missing"], false],
			];
			for (const [args, json] of failureCases) {
				request.mockResolvedValueOnce(failure);
				process.exitCode = 0;
				await backupCommand.parseAsync(args, { from: "user" });
				expect(process.exitCode).toBe(1);
				if (json) {
					expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
						error: "daemon_unavailable",
						message: "daemon down",
					});
				}
			}
			expect(stdout.mock.calls.flat().join("")).toContain(BACKUP_PRIVACY_NOTICE);
			expect(stdout.mock.calls.flat().join("")).toContain("Backup created: backup-human");
			expect(stdout.mock.calls.flat().join("")).toContain("No backups found.");
			expect(stdout.mock.calls.flat().join("")).toContain(
				"valid · 2026-08-15T00:00:00.000Z · valid",
			);
			expect(stdout.mock.calls.flat().join("")).toContain("invalid · unknown · invalid");
			expect(stdout.mock.calls.flat().join("")).toContain("Backup verified: valid");
			expect(stdout.mock.calls.flat().join("")).toContain(
				"Backup verification failed: invalid-human",
			);
			expect(stdout.mock.calls.flat().join("")).toContain("Backup restored: restore-human");
			expect(stdout.mock.calls.flat().join("")).toContain("daemon down");
		} finally {
			backupCommand.configureOutput(output);
			process.exitCode = originalExitCode;
			vi.restoreAllMocks();
		}
		expect(help).toContain(BACKUP_PRIVACY_NOTICE);
		expect(BACKUP_PRIVACY_NOTICE).toMatch(/private.*local-only/i);
		expect(BACKUP_PRIVACY_NOTICE).toMatch(/Phase 1.*off-device.*export/i);
	});
});
