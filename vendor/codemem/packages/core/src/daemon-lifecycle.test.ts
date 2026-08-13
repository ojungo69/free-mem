import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "./index.js";

const createdDirs: string[] = [];
const running: Array<{ stop: () => Promise<void> | void }> = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

function spawnSleep(seconds = 30): { pid: number; kill: () => void } {
	const child = spawn("sleep", [String(seconds)], { stdio: "ignore" });
	if (child.pid === undefined) throw new Error("failed to spawn sleep");
	return {
		pid: child.pid,
		kill: () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		},
	};
}

function processAlive(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const state = stat.slice(closeParen + 2).split(" ")[0];
		return state !== "Z" && state !== "X";
	} catch {
		return false;
	}
}

afterEach(async () => {
	for (const handle of running.splice(0)) {
		try {
			await handle.stop();
		} catch {
			// best-effort cleanup
		}
	}
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Phase 1 daemon lifecycle", () => {
	it("P1-T034-01-single-instance-lock", async () => {
		const dataDir = join(tempDir("codemem-daemon-lock-"), "data");
		const first = await core.startDaemon({ dataDir });
		running.push(first);

		expect(first.identity.pid).toBe(process.pid);
		expect(statSync(first.layout.controlDir).mode & 0o777).toBe(0o700);
		expect(statSync(first.lockPath).mode & 0o777).toBe(0o600);
		expect(statSync(first.socketPath).mode & 0o777).toBe(0o600);
		expect(statSync(first.identityPath).mode & 0o777).toBe(0o600);
		expect(core.readDaemonHealth(dataDir).status).toBe("ok");

		await expect(core.startDaemon({ dataDir })).rejects.toThrow(
			/already running|SQLITE_BUSY|exclusive/i,
		);

		await first.stop();
		running.pop();
		expect(core.readDaemonHealth(dataDir).status).toBe("not_running");

		const second = await core.startDaemon({ dataDir });
		running.push(second);
		expect(core.readDaemonHealth(dataDir).status).toBe("ok");
		await second.stop();
		running.pop();
	});

	it("P1-T034-02-force-kill-identity", async () => {
		const dataDir = join(tempDir("codemem-daemon-kill-"), "data");
		const victim = spawnSleep();
		try {
			const layout = core.resolveStorageLayout(dataDir);
			core.ensureStorageLayout(layout);
			const live = core.readProcessIdentity(victim.pid);
			const identity = {
				version: 1 as const,
				pid: victim.pid,
				startTime: live.startTime,
				fingerprint: live.fingerprint,
				nonce: "correct-nonce",
			};
			writeFileSync(layout.identityPath, `${JSON.stringify(identity)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(layout.identityPath, 0o600);

			const mismatched = {
				...identity,
				nonce: "wrong-nonce",
				startTime: "0",
				fingerprint: "deadbeef",
			};
			writeFileSync(layout.identityPath, `${JSON.stringify(mismatched)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await expect(core.forceKillDaemon(dataDir)).rejects.toThrow(/identity|mismatch|refuse/i);
			expect(processAlive(victim.pid)).toBe(true);

			writeFileSync(layout.identityPath, `${JSON.stringify(identity)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			const successor = spawnSleep();
			try {
				const successorLive = core.readProcessIdentity(successor.pid);
				writeFileSync(
					layout.identityPath,
					`${JSON.stringify({
						version: 1,
						pid: successor.pid,
						startTime: successorLive.startTime,
						fingerprint: successorLive.fingerprint,
						nonce: "successor-nonce",
					})}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
				await expect(core.forceKillDaemon(dataDir, identity)).rejects.toThrow(
					/identity|mismatch|refuse/i,
				);
				expect(processAlive(victim.pid)).toBe(true);
				expect(processAlive(successor.pid)).toBe(true);
			} finally {
				successor.kill();
			}

			writeFileSync(layout.identityPath, `${JSON.stringify(identity)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await core.forceKillDaemon(dataDir, identity);
			expect(processAlive(victim.pid)).toBe(false);
		} finally {
			victim.kill();
		}
	});

	it("P1-T034-03-shutdown-fallback", async () => {
		const dataDir = join(tempDir("codemem-daemon-stop-"), "data");
		const victim = spawnSleep();
		try {
			const layout = core.resolveStorageLayout(dataDir);
			core.ensureStorageLayout(layout);
			const live = core.readProcessIdentity(victim.pid);
			writeFileSync(
				layout.identityPath,
				`${JSON.stringify({
					version: 1,
					pid: victim.pid,
					startTime: live.startTime,
					fingerprint: live.fingerprint,
					nonce: "stop-nonce",
				})}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
			chmodSync(layout.identityPath, 0o600);

			const started = Date.now();
			const result = await core.stopDaemon(dataDir, { timeoutMs: 80 });
			const elapsed = Date.now() - started;
			expect(result.action).toBe("force_killed");
			expect(elapsed).toBeLessThan(1500);
			expect(processAlive(victim.pid)).toBe(false);
		} finally {
			victim.kill();
		}
	});

	it("P1-T034-04-data-dir-preflight", () => {
		expect(core.isNetworkFilesystemType(0x6969)).toBe(true);
		expect(core.isNetworkFilesystemType(0xff534d42)).toBe(true);
		expect(core.isNetworkFilesystemType(0x65735546)).toBe(true);
		expect(core.isForbiddenMountFstype("fuse.sshfs")).toBe(true);
		expect(core.isForbiddenMountFstype("virtiofs")).toBe(true);
		expect(core.isForbiddenMountFstype("ext4")).toBe(false);
		expect(core.isWslWindowsSharePath("/mnt/c/Users/foo/.codemem")).toBe(true);
		expect(core.isWslWindowsSharePath("/mnt/d/data")).toBe(true);
		expect(core.isWslWindowsSharePath("/home/jura/.codemem")).toBe(false);

		expect(() => core.assertDataDirPreflight("/mnt/c/Users/foo/.codemem")).toThrow(
			/network|wsl|windows|share|preflight/i,
		);
		const local = join(tempDir("codemem-daemon-preflight-"), "data");
		expect(() => core.assertDataDirPreflight(local)).not.toThrow();
		expect(existsSync(local)).toBe(false);
	});
});
