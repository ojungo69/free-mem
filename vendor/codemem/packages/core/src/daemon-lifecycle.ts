import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
	ensureStorageLayout,
	recoverStorageJournal,
	resolveStorageLayout,
	type StorageLayout,
} from "./storage.js";
import {
	assertDataDirPreflight,
	assertSupportedStoragePlatform,
	durableRemoveFile,
	durableReplaceFile,
	readProcessIdentity,
} from "./storage-platform.js";

export type DaemonIdentity = {
	version: 1;
	pid: number;
	startTime: string;
	fingerprint: string;
	nonce: string;
};

export type DaemonHealth =
	| { status: "ok"; pid: number; socketPath: string; dataDir: string }
	| { status: "not_running"; dataDir: string };

export type DaemonHandle = {
	dataDir: string;
	layout: StorageLayout;
	identity: DaemonIdentity;
	lockPath: string;
	socketPath: string;
	identityPath: string;
	stop(): Promise<void>;
};

type LiveDaemon = {
	lock: BetterSqlite3.Database;
	server: Server;
	identity: DaemonIdentity;
	layout: StorageLayout;
};

const liveDaemons = new Map<string, LiveDaemon>();

function recordLockOpen(dbPath: string): void {
	const tracePath = process.env.CODEMEM_DB_OPEN_TRACE?.trim();
	if (!tracePath) return;
	appendFileSync(
		tracePath,
		`${JSON.stringify({
			version: 1,
			event: "sqlite_open",
			mode: "lock",
			owner: "daemon_lifecycle",
			pid: process.pid,
			dbPath: resolve(dbPath),
			openedAt: new Date().toISOString(),
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

function readIdentityFile(path: string): DaemonIdentity | null {
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonIdentity>;
	if (
		parsed.version !== 1 ||
		typeof parsed.pid !== "number" ||
		typeof parsed.startTime !== "string" ||
		typeof parsed.fingerprint !== "string" ||
		typeof parsed.nonce !== "string"
	) {
		throw new Error("Daemon identity record is malformed.");
	}
	return parsed as DaemonIdentity;
}

function identitiesMatch(
	file: DaemonIdentity,
	live: { startTime: string; fingerprint: string },
): boolean {
	return file.startTime === live.startTime && file.fingerprint === live.fingerprint;
}

function sameIdentity(left: DaemonIdentity, right: DaemonIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startTime === right.startTime &&
		left.fingerprint === right.fingerprint &&
		left.nonce === right.nonce
	);
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

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(20, remaining)));
	}
	return predicate();
}

function isDaemonProcessAlive(layout: StorageLayout): boolean {
	const identity = readIdentityFile(layout.identityPath);
	if (!identity) return false;
	if (!processAlive(identity.pid)) return false;
	try {
		return identitiesMatch(identity, readProcessIdentity(identity.pid));
	} catch {
		return false;
	}
}

function acquireExclusiveLock(lockPath: string): BetterSqlite3.Database {
	const lock = new BetterSqlite3(lockPath, { timeout: 0, fileMustExist: false });
	try {
		chmodSync(lockPath, 0o600);
		lock.pragma("journal_mode = DELETE");
		lock.pragma("busy_timeout = 0");
		lock.exec("BEGIN EXCLUSIVE");
		recordLockOpen(lockPath);
		return lock;
	} catch (error) {
		lock.close();
		const message = error instanceof Error ? error.message : String(error);
		if (/busy|locked|SQLITE_BUSY/i.test(message)) {
			throw new Error("Daemon already running for this data_dir (exclusive lock busy).");
		}
		throw error;
	}
}

function bindPrivateSocket(socketPath: string, identity: DaemonIdentity): Promise<Server> {
	if (existsSync(socketPath)) unlinkSync(socketPath);
	const server = createServer((connection) => {
		connection.end(`${JSON.stringify({ status: "ok", pid: identity.pid })}\n`);
	});
	return new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			try {
				chmodSync(socketPath, 0o600);
				resolveListen(server);
			} catch (error) {
				server.close();
				reject(error);
			}
		});
	});
}

function releaseResources(layout: StorageLayout, live?: LiveDaemon): void {
	if (live) {
		try {
			live.server.close();
		} catch {
			// server may already be closed
		}
		try {
			if (live.lock.open) live.lock.close();
		} catch {
			// lock connection may already be closed
		}
	}
	if (existsSync(layout.socketPath)) {
		try {
			unlinkSync(layout.socketPath);
		} catch {
			// stale socket cleanup is best-effort
		}
	}
	durableRemoveFile(layout.identityPath);
}

function stopLive(dataDir: string): void {
	const live = liveDaemons.get(dataDir);
	if (!live) return;
	liveDaemons.delete(dataDir);
	releaseResources(live.layout, live);
}

export async function startDaemon(options: { dataDir: string }): Promise<DaemonHandle> {
	assertSupportedStoragePlatform();
	assertDataDirPreflight(options.dataDir);
	const layout = resolveStorageLayout(options.dataDir);
	ensureStorageLayout(layout);

	const lock = acquireExclusiveLock(layout.lockPath);

	let server: Server | undefined;
	try {
		recoverStorageJournal(layout);
		const liveIdentity = readProcessIdentity(process.pid);
		const identity: DaemonIdentity = {
			version: 1,
			pid: process.pid,
			startTime: liveIdentity.startTime,
			fingerprint: liveIdentity.fingerprint,
			nonce: randomUUID(),
		};
		server = await bindPrivateSocket(layout.socketPath, identity);
		durableReplaceFile(layout.identityPath, `${JSON.stringify(identity)}\n`);
		const live: LiveDaemon = { lock, server, identity, layout };
		liveDaemons.set(layout.dataDir, live);
		return {
			dataDir: layout.dataDir,
			layout,
			identity,
			lockPath: layout.lockPath,
			socketPath: layout.socketPath,
			identityPath: layout.identityPath,
			stop: async () => {
				stopLive(layout.dataDir);
			},
		};
	} catch (error) {
		if (server) {
			try {
				server.close();
			} catch {
				// bind succeeded but later startup failed
			}
		}
		if (existsSync(layout.socketPath)) {
			try {
				unlinkSync(layout.socketPath);
			} catch {
				// leftover socket must not outlive a failed start
			}
		}
		durableRemoveFile(layout.identityPath);
		try {
			lock.close();
		} catch {
			// lock must not leak if startup fails after acquire
		}
		throw error;
	}
}

function removeControlArtifacts(layout: StorageLayout): void {
	if (existsSync(layout.socketPath)) {
		try {
			unlinkSync(layout.socketPath);
		} catch {
			// stale socket cleanup is best-effort
		}
	}
	durableRemoveFile(layout.identityPath);
}

function cleanupIfStillOwner(layout: StorageLayout, snapshot: DaemonIdentity | null): void {
	let lock: BetterSqlite3.Database;
	try {
		lock = acquireExclusiveLock(layout.lockPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already running/i.test(message)) return;
		throw error;
	}
	try {
		const current = readIdentityFile(layout.identityPath);
		if (snapshot && current && !sameIdentity(snapshot, current)) return;
		removeControlArtifacts(layout);
	} finally {
		lock.close();
	}
}

export function readDaemonHealth(dataDir: string): DaemonHealth {
	const layout = resolveStorageLayout(dataDir);
	if (!existsSync(layout.socketPath) || !isDaemonProcessAlive(layout)) {
		return { status: "not_running", dataDir: layout.dataDir };
	}
	const identity = readIdentityFile(layout.identityPath);
	if (!identity) return { status: "not_running", dataDir: layout.dataDir };
	return {
		status: "ok",
		pid: identity.pid,
		socketPath: layout.socketPath,
		dataDir: layout.dataDir,
	};
}

export async function forceKillDaemon(dataDir: string, expected?: DaemonIdentity): Promise<void> {
	const layout = resolveStorageLayout(dataDir);
	const first = readIdentityFile(layout.identityPath);
	if (!first) throw new Error("Force-kill refused: no daemon identity record.");
	if (expected && !sameIdentity(expected, first)) {
		throw new Error("Force-kill refused: daemon identity mismatch.");
	}
	let liveFirst: { startTime: string; fingerprint: string };
	try {
		liveFirst = readProcessIdentity(first.pid);
	} catch {
		throw new Error("Force-kill refused: daemon identity mismatch.");
	}
	if (!identitiesMatch(first, liveFirst)) {
		throw new Error("Force-kill refused: daemon identity mismatch.");
	}
	const second = readIdentityFile(layout.identityPath);
	if (!second || !sameIdentity(first, second)) {
		throw new Error("Force-kill refused: daemon identity mismatch.");
	}
	let liveSecond: { startTime: string; fingerprint: string };
	try {
		liveSecond = readProcessIdentity(second.pid);
	} catch {
		throw new Error("Force-kill refused: daemon identity mismatch.");
	}
	if (!identitiesMatch(second, liveSecond)) {
		throw new Error("Force-kill refused: daemon identity mismatch.");
	}

	process.kill(second.pid, "SIGKILL");
	if (!(await waitUntil(() => !processAlive(second.pid), 1000))) {
		throw new Error("Force-kill did not terminate the identified process.");
	}
	const live = liveDaemons.get(layout.dataDir);
	if (live && sameIdentity(live.identity, second)) {
		liveDaemons.delete(layout.dataDir);
		try {
			if (live.lock.open) live.lock.close();
		} catch {
			// lock is released with the dead owner
		}
	}
	cleanupIfStillOwner(layout, second);
}

export async function stopDaemon(
	dataDir: string,
	options?: { timeoutMs?: number },
): Promise<{ action: "stopped" | "force_killed" }> {
	const layout = resolveStorageLayout(dataDir);
	const snapshot = readIdentityFile(layout.identityPath);
	if (liveDaemons.has(layout.dataDir)) {
		stopLive(layout.dataDir);
		return { action: "stopped" };
	}
	const timeoutMs = options?.timeoutMs ?? 2000;
	if (await waitUntil(() => !isDaemonProcessAlive(layout), timeoutMs)) {
		cleanupIfStillOwner(layout, snapshot);
		return { action: "stopped" };
	}
	await forceKillDaemon(layout.dataDir, snapshot ?? undefined);
	return { action: "force_killed" };
}

export {
	assertDataDirPreflight,
	isForbiddenMountFstype,
	isNetworkFilesystemType,
	isWslWindowsSharePath,
	readProcessIdentity,
} from "./storage-platform.js";
