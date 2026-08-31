import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonJobService } from "./daemon-jobs.js";
import { probeDaemonWriterAvailable } from "./daemon-lifecycle.js";
import * as core from "./index.js";
import {
	acquireCapabilityLifecycleLock,
	activateCapabilityManifest,
	writeCapabilityManifestGeneration,
} from "./storage.js";

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

function localManifest(modelId = "t008-local-model") {
	return core.compileDefaultCapabilityManifest({
		version: 1,
		role: "summary",
		state: "enabled",
		wireProtocol: "openai_chat_completions_v1",
		modelId,
		modelRevision: "1",
		endpointUrl: "http://127.0.0.1:1234/v1/chat/completions",
		credentialRef: { kind: "none" },
	});
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
		await first.stop();
		expect(core.readDaemonHealth(dataDir).status).toBe("ok");
		expect(statSync(second.socketPath).isSocket()).toBe(true);
		await second.stop();
		running.pop();
	});

	it("rejects a competing start before mutating live restore or control state", async () => {
		const dataDir = join(tempDir("codemem-daemon-competing-start-"), "data");
		const first = await core.startDaemon({ dataDir });
		running.push(first);
		const oldPointer = core.readCurrentDatabasePointer(first.layout);
		expect(oldPointer).not.toBeNull();
		const newPointer = "versions/pending-restore.sqlite";
		core.writeStorageJournal(first.layout, {
			version: 1,
			operationId: "competing-start-restore",
			state: "switched",
			oldPointer,
			newPointer,
			artifactSha256: "0".repeat(64),
		});
		unlinkSync(first.layout.currentPointerPath);
		symlinkSync(newPointer, first.layout.currentPointerPath);
		const journalBefore = readFileSync(first.layout.journalPath, "utf8");
		const identityBefore = readFileSync(first.identityPath, "utf8");

		await expect(core.startDaemon({ dataDir })).rejects.toThrow(
			/already running|SQLITE_BUSY|exclusive/i,
		);

		expect(readlinkSync(first.layout.currentPointerPath)).toBe(newPointer);
		expect(readFileSync(first.layout.journalPath, "utf8")).toBe(journalBefore);
		expect(readFileSync(first.identityPath, "utf8")).toBe(identityBefore);
		expect(statSync(first.socketPath).isSocket()).toBe(true);
		expect(core.readDaemonHealth(dataDir).status).toBe("ok");
	});

	it("releases startup state when background initialization fails", async () => {
		const dataDir = join(tempDir("codemem-daemon-background-start-"), "data");
		const layout = core.resolveStorageLayout(dataDir);
		const failure = new Error("injected internal backfill startup failure");
		const startInternalBackfills = vi
			.spyOn(DaemonJobService.prototype, "startInternalBackfills")
			.mockImplementationOnce(() => {
				throw failure;
			});

		try {
			await expect(core.startDaemon({ dataDir })).rejects.toBe(failure);
			startInternalBackfills.mockRestore();

			expect(core.readDaemonHealth(dataDir).status).toBe("not_running");
			expect(existsSync(layout.identityPath)).toBe(false);
			expect(existsSync(layout.socketPath)).toBe(false);
			expect(probeDaemonWriterAvailable(dataDir)).toBe(true);

			const restarted = await core.startDaemon({ dataDir });
			expect(core.readDaemonHealth(dataDir).status).toBe("ok");
			await restarted.stop();
		} finally {
			startInternalBackfills.mockRestore();
			await core.stopDaemon(dataDir);
		}
	});

	it("does not start internal backfills when socket binding fails before identity publication", async () => {
		const dataDir = join(tempDir("codemem-daemon-bind-failure-"), "data");
		const layout = core.resolveStorageLayout(dataDir);
		core.ensureStorageLayout(layout);
		mkdirSync(layout.socketPath);
		const startInternalBackfills = vi.spyOn(DaemonJobService.prototype, "startInternalBackfills");

		try {
			await expect(core.startDaemon({ dataDir })).rejects.toThrow(/EISDIR|directory/i);

			expect(startInternalBackfills).not.toHaveBeenCalled();
			expect(core.readDaemonHealth(dataDir).status).toBe("not_running");
			expect(existsSync(layout.identityPath)).toBe(false);
			expect(probeDaemonWriterAvailable(dataDir)).toBe(true);
		} finally {
			startInternalBackfills.mockRestore();
			await core.stopDaemon(dataDir);
		}
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

	it("P1-T034-04-data-dir-preflight", async () => {
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

		const linked = tempDir("codemem-daemon-symlink-");
		const dataDir = join(linked, "data");
		mkdirSync(dataDir, { mode: 0o700 });
		symlinkSync(join(linked, "elsewhere"), join(dataDir, "control"));
		await expect(core.startDaemon({ dataDir })).rejects.toThrow(/symbolic link|preflight/i);
	});
});

describe("T007 setup recovery boundary", () => {
	it("refuses an unrecoverable setup journal without deleting it or exposing prestate", async () => {
		const dataDir = join(tempDir("codemem-daemon-setup-journal-"), "data");
		const layout = core.resolveStorageLayout(dataDir);
		core.ensureStorageLayout(layout);
		const capabilitiesDir = join(layout.controlDir, "capabilities");
		const journalPath = join(capabilitiesDir, "setup-transaction.json");
		const currentPath = join(capabilitiesDir, "current");
		const secretPrestate = "t007-secret-prestate";
		mkdirSync(capabilitiesDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			currentPath,
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
			{
				mode: 0o600,
			},
		);
		writeFileSync(journalPath, `{"version":1,"prestate":"${secretPrestate}"`, { mode: 0o600 });

		let handle: Awaited<ReturnType<typeof core.startDaemon>> | undefined;
		let startError: unknown;
		try {
			handle = await core.startDaemon({ dataDir });
			running.push(handle);
		} catch (error) {
			startError = error;
		}

		expect(startError).toBeInstanceOf(Error);
		expect(String(startError)).toMatch(/setup.*journal|journal.*recovery|recovery.*conflict/i);
		expect(String(startError)).not.toContain(secretPrestate);
		expect(readFileSync(journalPath, "utf8")).toContain(secretPrestate);
		expect(readFileSync(currentPath, "utf8")).toBe(
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
		);
		expect(existsSync(layout.identityPath)).toBe(false);
		expect(existsSync(layout.socketPath)).toBe(false);
	});
});

describe("T008 capability startup boundary", () => {
	it("releases the spool lock before daemon TLS preflight finishes", async () => {
		const dataDir = join(tempDir("codemem-daemon-tls-lock-"), "data");
		let acceptConnection: (socket: Socket) => void = () => {};
		const accepted = new Promise<Socket>((resolve) => {
			acceptConnection = resolve;
		});
		const server = createServer((socket) => acceptConnection(socket));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP test address");
		const manifest = core.compileDefaultCapabilityManifest({
			version: 1,
			role: "summary",
			state: "enabled",
			wireProtocol: "openai_chat_completions_v1",
			modelId: "t008-tls-lock-model",
			modelRevision: "1",
			endpointUrl: `https://127.0.0.1:${address.port}/v1/chat/completions`,
			credentialRef: { kind: "none" },
		});
		const layout = core.resolveStorageLayout(dataDir);
		core.ensureStorageLayout(layout);
		writeCapabilityManifestGeneration(layout, manifest);
		const lifecycle = acquireCapabilityLifecycleLock(layout, 0);
		try {
			activateCapabilityManifest(layout, manifest.configurationFingerprint, lifecycle);
		} finally {
			lifecycle.close();
		}

		const pending = core.startDaemon({ dataDir });
		let socket: Socket | undefined;
		let handle: Awaited<typeof pending> | undefined;
		try {
			socket = await accepted;
			const spoolLock = core.acquireSpoolLock(dataDir, 1);
			expect(spoolLock).toBeDefined();
			spoolLock.close();
			socket.destroy();
			handle = await pending;
			running.push(handle);
		} finally {
			socket?.destroy();
			if (!handle) {
				try {
					const lateHandle = await pending;
					await lateHandle.stop();
				} catch {
					// The assertion should report the original startup failure.
				}
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it.each([
		{
			name: "malformed current pointer",
			prepare: (layout: ReturnType<typeof core.resolveStorageLayout>) => {
				writeFileSync(layout.capabilityCurrentPointerPath, "not-a-fingerprint\n", { mode: 0o600 });
			},
			reason: /pointer|fingerprint|malformed/i,
		},
		{
			name: "missing referenced generation",
			prepare: (layout: ReturnType<typeof core.resolveStorageLayout>) => {
				writeFileSync(
					layout.capabilityCurrentPointerPath,
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
					{ mode: 0o600 },
				);
			},
			reason: /generation.*missing|missing.*generation/i,
		},
		{
			name: "generation fingerprint mismatch",
			prepare: (layout: ReturnType<typeof core.resolveStorageLayout>) => {
				const manifest = localManifest();
				const mismatched =
					"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
				writeFileSync(
					join(layout.capabilityManifestsDir, `${mismatched}.json`),
					`${JSON.stringify(manifest)}\n`,
					{
						mode: 0o600,
					},
				);
				writeFileSync(layout.capabilityCurrentPointerPath, `${mismatched}\n`, { mode: 0o600 });
			},
			reason: /generation.*fingerprint|fingerprint.*generation|mismatch/i,
		},
	])("rejects $name before publishing daemon control state", async ({ prepare, reason }) => {
		const dataDir = join(tempDir("codemem-daemon-capability-invalid-"), "data");
		const layout = core.resolveStorageLayout(dataDir);
		core.ensureStorageLayout(layout);
		prepare(layout);
		let handle: Awaited<ReturnType<typeof core.startDaemon>> | undefined;
		let startError: unknown;
		try {
			handle = await core.startDaemon({ dataDir });
			running.push(handle);
		} catch (error) {
			startError = error;
		}

		expect(startError).toBeInstanceOf(Error);
		expect(String(startError)).toMatch(reason);
		expect(core.readDaemonHealth(dataDir).status).toBe("not_running");
		expect(existsSync(layout.identityPath)).toBe(false);
		expect(existsSync(layout.socketPath)).toBe(false);
	});
});
