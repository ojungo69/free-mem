import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "./daemon-lifecycle.js";
import {
	callDaemonRpc,
	LOCAL_API_VERSION,
	NORMALIZED_SCHEMA_VERSION,
	RPC_CAPABILITY_HASH,
} from "./daemon-rpc.js";
import {
	acquireSpoolLock,
	drainLegacySpool,
	quarantineSpoolEntry,
	readSpoolStatus,
	resolveSpoolLayout,
	SPOOL_FILE_MAX_BYTES,
	SPOOL_NORMAL_QUOTA_BYTES,
	SPOOL_QUARANTINE_QUOTA_BYTES,
	SPOOL_RESERVED_MIN_EVENTS,
	SPOOL_RESERVED_QUOTA_BYTES,
	spoolMutation,
} from "./spool.js";

const fsFault = vi.hoisted(() => ({ renameDiskFull: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync(source: string, destination: string): void {
			if (fsFault.renameDiskFull && destination.includes("/control/spool/ready/")) {
				const error = new Error("no space left on device") as NodeJS.ErrnoException;
				error.code = "ENOSPC";
				throw error;
			}
			actual.renameSync(source, destination);
		},
	};
});

const roots: string[] = [];

afterEach(async () => {
	fsFault.renameDiskFull = false;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "codemem-spool-"));
	roots.push(root);
	return join(root, "data");
}

function eventBody(
	idempotencyKey: string,
	kind = "tool_completed",
	payload: Record<string, unknown> = { text: "ok" },
): Record<string, unknown> {
	return {
		idempotencyKey,
		event: {
			schemaVersion: 1,
			eventId: `event-${idempotencyKey}`,
			idempotencyKey,
			agent: "codex",
			nativeSessionId: "session-1",
			projectKey: "project-1",
			workspaceKey: "workspace-1",
			cwd: "/tmp/project",
			kind,
			occurredAt: "2026-08-14T00:00:00.000Z",
			payload,
			sourceHash: "a".repeat(64),
			sensitivity: "normal",
		},
	};
}

function writeSparse(path: string, bytes: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "", { mode: 0o600 });
	truncateSync(path, bytes);
}

function runWriter(dataDir: string, key: string): Promise<{ status: string }> {
	const moduleUrl = pathToFileURL(fileURLToPath(new URL("./spool.ts", import.meta.url))).href;
	const script = `
		import { spoolMutation } from ${JSON.stringify(moduleUrl)};
		const key = ${JSON.stringify(key)};
		const body = ${JSON.stringify(eventBody(key))};
		const result = spoolMutation(
			{ method: "POST /v1/events", idempotencyKey: key, body },
			{ dataDir: ${JSON.stringify(dataDir)}, lockDeadlineMs: 250, onWarning: () => {} },
		);
		process.stdout.write(JSON.stringify({ status: result.status }));
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`));
			else resolve(JSON.parse(stdout) as { status: string });
		});
	});
}

describe("phase 1 spool contract", () => {
	it("P1-T039-01-quota-warning-reserve", async () => {
		const dataDir = await tempDataDir();
		const layout = resolveSpoolLayout(dataDir);
		const warnings: string[] = [];
		const secret = `ghp_${"A".repeat(36)}`;
		expect(SPOOL_RESERVED_QUOTA_BYTES / SPOOL_FILE_MAX_BYTES).toBeGreaterThanOrEqual(
			SPOOL_RESERVED_MIN_EVENTS,
		);

		writeSparse(
			join(layout.readyDir, "normal-existing.json"),
			Math.ceil(SPOOL_NORMAL_QUOTA_BYTES * 0.8),
		);
		const warningResult = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "warning",
				body: eventBody("warning", "tool_completed", {
					text: `keep ${secret} <private>hidden</private> <local-only>device</local-only>`,
				}),
			},
			{ dataDir, onWarning: (message) => warnings.push(message) },
		);
		expect(warningResult.status).toBe("queued");
		expect(warnings.some((message) => message.includes("80%"))).toBe(true);
		const persisted = readFileSync(warningResult.path as string, "utf8");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("hidden");
		expect(persisted).toContain("[REDACTED:");
		expect(JSON.parse(persisted)).toMatchObject({
			redaction: {
				sensitivity: "secret",
				redaction_degraded: false,
				private_content_omitted: true,
				local_only: true,
			},
		});
		const daemon = await startDaemon({ dataDir });
		try {
			const health = await callDaemonRpc(daemon.socketPath, {
				id: "spool-health",
				method: "GET /v1/health",
				adapter_version: "test",
				native_cli_version: "test",
				normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
				local_api_version: LOCAL_API_VERSION,
				capability_hash: RPC_CAPABILITY_HASH,
			});
			expect(health).toMatchObject({
				result: { spool: { status: "critical", warnings: ["normal spool usage reached 80%"] } },
			});
		} finally {
			await daemon.stop();
		}

		const memorySecret = `ghp_${"B".repeat(36)}`;
		const memoryResult = spoolMutation(
			{
				method: "POST /v1/memories/record",
				idempotencyKey: "memory-warning",
				body: {
					idempotencyKey: "memory-warning",
					kind: "decision",
					title: "visible <private>hidden title</private>",
					body: `keep ${memorySecret} <local-only>device only</local-only>`,
				},
			},
			{ dataDir, onWarning: () => {} },
		);
		expect(memoryResult.status).toBe("queued");
		const memoryPersisted = readFileSync(memoryResult.path as string, "utf8");
		expect(memoryPersisted).not.toContain(memorySecret);
		expect(memoryPersisted).not.toContain("hidden title");
		expect(JSON.parse(memoryPersisted)).toMatchObject({
			redaction: {
				sensitivity: "secret",
				private_content_omitted: true,
				local_only: true,
			},
		});

		writeSparse(join(layout.tmpDir, "normal-full.json.tmp"), SPOOL_NORMAL_QUOTA_BYTES);
		const normalDrop = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "normal-full",
				body: eventBody("normal-full"),
			},
			{ dataDir, onWarning: () => {} },
		);
		const reserved = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "reserved",
				body: eventBody("reserved", "pre_compact"),
			},
			{ dataDir, onWarning: () => {} },
		);
		expect(normalDrop).toMatchObject({ status: "dropped", reason: "quota_full" });
		expect(reserved).toMatchObject({ status: "queued", quotaClass: "reserved" });

		writeSparse(join(layout.tmpDir, "reserved-full.json.tmp"), SPOOL_RESERVED_QUOTA_BYTES);
		const reservedDrop = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "reserved-full",
				body: eventBody("reserved-full", "session_ended"),
			},
			{ dataDir, onWarning: () => {} },
		);
		const status = readSpoolStatus(dataDir);
		expect(reservedDrop).toMatchObject({ status: "dropped", reason: "quota_full" });
		expect(status.dropped.byKind).toMatchObject({ tool_completed: 1, session_ended: 1 });
		expect(statSync(layout.counterPath).size).toBe(4096);
		expect(existsSync(join(layout.tmpDir, "normal-full.json.tmp"))).toBe(true);
		const criticalDaemon = await startDaemon({ dataDir });
		try {
			const doctor = await callDaemonRpc(criticalDaemon.socketPath, {
				id: "spool-doctor",
				method: "GET /v1/doctor",
				adapter_version: "test",
				native_cli_version: "test",
				normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
				local_api_version: LOCAL_API_VERSION,
				capability_hash: RPC_CAPABILITY_HASH,
			});
			expect(doctor).toMatchObject({
				result: {
					diagnostics: {
						spool: {
							status: "critical",
							droppedTotal: 2,
							droppedByKind: { tool_completed: 1, session_ended: 1 },
						},
					},
				},
			});
		} finally {
			await criticalDaemon.stop();
		}

		const quarantineDataDir = await tempDataDir();
		const first = spoolMutation(
			{ method: "POST /v1/events", idempotencyKey: "q1", body: eventBody("q1") },
			{ dataDir: quarantineDataDir, onWarning: () => {} },
		);
		const second = spoolMutation(
			{ method: "POST /v1/events", idempotencyKey: "q2", body: eventBody("q2") },
			{ dataDir: quarantineDataDir, onWarning: () => {} },
		);
		expect(
			quarantineSpoolEntry(quarantineDataDir, basename(first.path as string), "broken_json"),
		).toMatchObject({ status: "moved" });
		const quarantineLayout = resolveSpoolLayout(quarantineDataDir);
		writeSparse(join(quarantineLayout.quarantineDir, "full.json"), SPOOL_QUARANTINE_QUOTA_BYTES);
		expect(
			quarantineSpoolEntry(
				quarantineDataDir,
				basename(second.path as string),
				"idempotency_conflict",
			),
		).toEqual({ status: "full" });
		expect(existsSync(second.path as string)).toBe(true);
		expect(readSpoolStatus(quarantineDataDir)).toMatchObject({
			critical: true,
			dropped: { quarantineRejected: 1 },
		});
		expect(() =>
			quarantineSpoolEntry(quarantineDataDir, "entry.json", "../escape" as "broken_json"),
		).toThrow("Invalid spool quarantine request");
	});

	it("P1-T039-02-concurrent-writers", async () => {
		const dataDir = await tempDataDir();
		const results = await Promise.all(Array.from({ length: 6 }, () => runWriter(dataDir, "same")));
		expect(results.every((result) => ["queued", "duplicate"].includes(result.status))).toBe(true);
		const layout = resolveSpoolLayout(dataDir);
		const ready = readdirSync(layout.readyDir).filter((name) => name.endsWith(".json"));
		expect(ready).toHaveLength(1);
		expect(() =>
			JSON.parse(readFileSync(join(layout.readyDir, ready[0] as string), "utf8")),
		).not.toThrow();

		const tagged = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "redaction-conflict",
				body: eventBody("redaction-conflict", "tool_completed", {
					text: "keep <local-only>device</local-only>",
				}),
			},
			{ dataDir, onWarning: () => {} },
		);
		const plain = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "redaction-conflict",
				body: eventBody("redaction-conflict", "tool_completed", { text: "keep device" }),
			},
			{ dataDir, onWarning: () => {} },
		);
		expect(tagged.status).toBe("queued");
		expect(plain.status).toBe("queued");
		expect(readdirSync(layout.readyDir).filter((name) => name.endsWith(".json"))).toHaveLength(3);

		const held = acquireSpoolLock(dataDir);
		const started = performance.now();
		const timedOut = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "deadline",
				body: eventBody("deadline"),
			},
			{ dataDir, lockDeadlineMs: 20, onWarning: () => {} },
		);
		const elapsed = performance.now() - started;
		held.close();
		expect(timedOut).toMatchObject({ status: "dropped", reason: "lock_timeout" });
		expect(elapsed).toBeLessThan(250);

		const replaced = acquireSpoolLock(dataDir);
		unlinkSync(layout.lockPath);
		const replacement = acquireSpoolLock(dataDir);
		replaced.close();
		expect(existsSync(layout.lockPath)).toBe(true);
		const replacementStillHeld = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "replacement-lock",
				body: eventBody("replacement-lock"),
			},
			{ dataDir, lockDeadlineMs: 20, onWarning: () => {} },
		);
		replacement.close();
		expect(replacementStillHeld).toMatchObject({
			status: "dropped",
			reason: "lock_timeout",
		});
	});

	it("P1-T039-03-disk-full-temp", async () => {
		const dataDir = await tempDataDir();
		const warnings: string[] = [];
		fsFault.renameDiskFull = true;
		const result = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "disk-full",
				body: eventBody("disk-full", "tool_failed"),
			},
			{ dataDir, onWarning: (message) => warnings.push(message) },
		);
		fsFault.renameDiskFull = false;
		const layout = resolveSpoolLayout(dataDir);
		expect(result).toMatchObject({ status: "dropped", reason: "disk_full" });
		expect(warnings.join("\n")).toContain("disk full");
		expect(readdirSync(layout.tmpDir).some((name) => name.endsWith(".json.tmp"))).toBe(true);
		expect(readSpoolStatus(dataDir).dropped.byKind).toMatchObject({ tool_failed: 1 });
		const invalid = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "invalid",
				body: eventBody("invalid", "not-a-kind"),
			},
			{ dataDir, onWarning: (message) => warnings.push(message) },
		);
		expect(invalid).toMatchObject({ status: "dropped", reason: "invalid" });
		const mismatched = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "outer-key",
				body: eventBody("inner-key"),
			},
			{ dataDir, onWarning: (message) => warnings.push(message) },
		);
		expect(mismatched).toMatchObject({ status: "dropped", reason: "invalid" });
		const paddedReservedKind = spoolMutation(
			{
				method: "POST /v1/events",
				idempotencyKey: "padded-kind",
				body: eventBody("padded-kind", " pre_compact "),
			},
			{ dataDir, onWarning: (message) => warnings.push(message) },
		);
		expect(paddedReservedKind).toMatchObject({
			status: "dropped",
			quotaClass: "normal",
			reason: "invalid",
		});
		expect(warnings.join("\n")).not.toContain("not-a-kind");
		expect(warnings.join("\n")).not.toContain("inner-key");
	});

	it("P1-T039-04-old-format-drain", async () => {
		const dataDir = await tempDataDir();
		const claudeDir = join(dataDir, "claude-hook-spool");
		const codexDir = join(dataDir, "codex-hook-spool");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(codexDir, { recursive: true });
		writeFileSync(join(claudeDir, "hook-1.json"), JSON.stringify({ session_id: "claude" }));
		writeFileSync(join(codexDir, "hook-2.json"), JSON.stringify({ session_id: "codex" }));
		writeFileSync(join(claudeDir, ".hook-tmp-partial.json"), "{");
		writeFileSync(join(codexDir, ".bad-json.json"), "{");
		const seen: string[] = [];

		const result = await drainLegacySpool(dataDir, async (source, payload) => {
			seen.push(`${source}:${String(payload.session_id)}`);
			return source === "claude";
		});

		expect(result).toEqual({ processed: 1, failed: 1 });
		expect(seen).toEqual(["claude:claude", "codex:codex"]);
		expect(existsSync(join(claudeDir, "hook-1.json"))).toBe(false);
		expect(existsSync(join(codexDir, "hook-2.json"))).toBe(true);
		expect(existsSync(join(claudeDir, ".hook-tmp-partial.json"))).toBe(true);
		expect(existsSync(join(codexDir, ".bad-json.json"))).toBe(true);
	});
});
