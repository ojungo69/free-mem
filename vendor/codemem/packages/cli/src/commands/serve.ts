import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import * as p from "@clack/prompts";
import {
	type DaemonHandle,
	readDaemonHealth,
	resolveDbPath,
	resolveStorageLayout,
	startDaemon,
} from "@codemem/core";
import type { ViewerRpcCall } from "@codemem/server";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addViewerHostOptions,
	emitDeprecationWarning,
	resolveDataDirOpt,
} from "../shared-options.js";
import {
	isLoopbackHost,
	parseViewerPidRecord,
	probeCodememViewerLiveness,
	type ViewerPidRecord,
	viewerUrl,
} from "../viewer-runtime.js";
import {
	type LegacyServeOptions,
	type ResolvedServeInvocation,
	resolveServeInvocation,
	type ServeAction,
} from "./serve-invocation.js";

export function extractViewerPid(payload: unknown): number | null {
	if (!payload || typeof payload !== "object") return null;
	const rawPid = (payload as { viewer_pid?: unknown }).viewer_pid;
	if (typeof rawPid !== "number" || !Number.isFinite(rawPid) || rawPid <= 0) return null;
	return Math.trunc(rawPid);
}

export function isLocalHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "0.0.0.0" ||
		normalized === "::"
	);
}

export function isLoopbackOnlyHost(host: string): boolean {
	return isLoopbackHost(host);
}

function warnIfViewerExposed(host: string, port: number): boolean {
	if (isLoopbackOnlyHost(host)) return false;
	p.log.error(`Refusing to bind the viewer to non-loopback address ${host}:${port}.`);
	process.exitCode = 1;
	return true;
}

export function isLikelyViewerCommand(command: string): boolean {
	const lowered = command.toLowerCase();
	if (!/\bserve\s+start\b/.test(lowered)) return false;
	return (
		lowered.includes("codemem") ||
		lowered.includes("packages/cli/dist/index.js") ||
		lowered.includes("/cli/dist/index.js") ||
		lowered.includes("packages/cli/src/index.ts")
	);
}

export function pickViewerPidCandidate(
	statsPid: number | null,
	listenerPid: number | null,
): number | null {
	if (statsPid && listenerPid && statsPid !== listenerPid) return null;
	return statsPid ?? listenerPid ?? null;
}

export function findTrustedSystemCommand(candidates: readonly string[]): string | null {
	return candidates.find((path) => isAbsolute(path) && existsSync(path)) ?? null;
}

function lookupListeningPid(host: string, port: number): number | null {
	if (!isLocalHost(host)) return null;
	const lsof = findTrustedSystemCommand(["/usr/bin/lsof", "/usr/sbin/lsof"]);
	if (!lsof) return null;
	const result = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
		encoding: "utf-8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	const first = (result.stdout || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!first) return null;
	const parsed = Number.parseInt(first, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readProcessCommand(pid: number): string | null {
	const ps = findTrustedSystemCommand(["/bin/ps", "/usr/bin/ps"]);
	if (!ps) return null;
	const result = spawnSync(ps, ["-p", String(pid), "-o", "command="], {
		encoding: "utf-8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	const cmd = (result.stdout || "").trim();
	return cmd.length > 0 ? cmd : null;
}

function isTrustedViewerPid(
	pid: number,
	target: { host: string; port: number },
	listenerPid: number | null,
): boolean {
	if (!isLocalHost(target.host)) return false;
	if (listenerPid && listenerPid !== pid) return false;
	const command = readProcessCommand(pid);
	if (!command) return false;
	return isLikelyViewerCommand(command);
}

function pidFilePath(dbPath: string): string {
	return join(dirname(dbPath), "viewer.pid");
}

function readViewerPidRecord(dbPath: string): ViewerPidRecord | null {
	const pidPath = pidFilePath(dbPath);
	if (!existsSync(pidPath)) return null;
	// Shared strict parser keeps `serve` and `codemem status` agreeing on
	// what counts as a valid viewer PID record.
	const parsed = parseViewerPidRecord(readFileSync(pidPath, "utf-8"));
	if (parsed.state === "valid") return parsed.record;
	if (parsed.state === "legacy") return { pid: parsed.pid, host: "127.0.0.1", port: 38888 };
	return null;
}
function normalizeViewerHost(host: string): string {
	const normalized = host.trim().toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]"
	) {
		return "loopback";
	}
	return normalized;
}

async function findRuntimeViewerConflict(
	dbPath: string,
	target: { host: string; port: number },
): Promise<ViewerPidRecord | null> {
	const record = readViewerPidRecord(dbPath);
	if (!record) return null;
	if (
		normalizeViewerHost(record.host) === normalizeViewerHost(target.host) &&
		record.port === target.port
	)
		return null;
	if (!isProcessRunning(record.pid)) return null;
	if (!(await respondsLikeCodememViewer(record))) return null;
	return record;
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function respondsLikeCodememViewer(
	record: ViewerPidRecord,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const result = await probeCodememViewerLiveness(record, {
		fetch: fetchImpl,
		timeoutMs: 1000,
	});
	return result.state === "live";
}

async function lookupViewerPidFromStats(host: string, port: number): Promise<number | null> {
	try {
		const res = await fetch(viewerUrl({ host, port }, "/api/stats"), {
			signal: AbortSignal.timeout(1000),
		});
		if (!res.ok) return null;
		const payload = await res.json();
		return extractViewerPid(payload);
	} catch {
		return null;
	}
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		const done = (open: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(300);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

async function waitForProcessExit(pid: number, timeoutMs = 30000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !isProcessRunning(pid);
}

async function terminateProcessPid(
	pid: number,
	timeouts: { gracefulMs?: number; forceMs?: number } = {},
): Promise<boolean> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return true;
	}
	if (await waitForProcessExit(pid, timeouts.gracefulMs ?? 30000)) return true;

	// A stuck better-sqlite3 maintenance query blocks the target process's JS
	// signal handler, so graceful shutdown can never run. Callers only reach
	// this helper after command-line/pidfile trust checks; escalate so lifecycle
	// commands do not require a manual kill -9.
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return true;
	}
	return waitForProcessExit(pid, timeouts.forceMs ?? 5000);
}

export async function terminateTrustedViewerPid(
	pid: number,
	timeouts: { gracefulMs?: number; forceMs?: number } = {},
): Promise<boolean> {
	return terminateProcessPid(pid, timeouts);
}

async function waitForPortRelease(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isPortOpen(host, port))) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

async function waitForPortOpen(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isPortOpen(host, port)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

async function stopExistingViewer(
	dbPath: string,
	target: { host: string; port: number },
): Promise<{ stopped: boolean; pid: number | null }> {
	const pidPath = pidFilePath(dbPath);
	const record = readViewerPidRecord(dbPath);
	const viewerPidFromStats = await lookupViewerPidFromStats(target.host, target.port);
	const listenerPid = lookupListeningPid(target.host, target.port);
	const viewerPid = pickViewerPidCandidate(viewerPidFromStats, listenerPid);
	if (viewerPid && isTrustedViewerPid(viewerPid, target, listenerPid)) {
		const stopped = await terminateTrustedViewerPid(viewerPid);
		if (!stopped) return { stopped: false, pid: viewerPid };
		try {
			rmSync(pidPath);
		} catch {
			// ignore
		}
		return { stopped: true, pid: viewerPid };
	}

	if (!record) return { stopped: false, pid: null };

	const recordListenerPid = lookupListeningPid(record.host, record.port);
	if (
		(await respondsLikeCodememViewer(record)) &&
		isTrustedViewerPid(record.pid, { host: record.host, port: record.port }, recordListenerPid)
	) {
		const stopped = await terminateTrustedViewerPid(record.pid);
		if (!stopped) return { stopped: false, pid: record.pid };
	} else {
		return { stopped: false, pid: null };
	}
	try {
		rmSync(pidPath);
	} catch {
		// ignore
	}
	return { stopped: true, pid: record.pid };
}

export function buildForegroundRunnerArgs(
	scriptPath: string,
	invocation: ResolvedServeInvocation,
	execArgv: string[] = process.execArgv,
): string[] {
	const args = [
		...execArgv,
		scriptPath,
		"serve",
		"start",
		"--foreground",
		"--host",
		invocation.host,
		"--port",
		String(invocation.port),
	];
	if (invocation.dbPath) {
		args.push("--db-path", invocation.dbPath);
	}
	return args;
}

export function isSqliteVecLoadFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const text = error.message.toLowerCase();
	return (
		text.includes("sqlite-vec") ||
		text.includes("vec_version") ||
		text.includes("vec0") ||
		(text.includes("sqlite") && text.includes("vec"))
	);
}

export function sqliteVecFailureDiagnostics(error: unknown, dbPath: string): string[] {
	const message = error instanceof Error ? error.message : String(error);
	return [
		`db=${dbPath}`,
		`node=${process.version}`,
		`exec=${process.execPath}`,
		`cwd=${process.cwd()}`,
		`embedding_disabled=${process.env.CODEMEM_EMBEDDING_DISABLED ?? ""}`,
		`error=${message}`,
	];
}

async function issueViewerNonce(dataDir: string, timeoutMs = 10_000): Promise<string | null> {
	const { createViewerRpcCall } = await import("@codemem/server");
	const rpc = createViewerRpcCall({ socketPath: resolveStorageLayout(dataDir).socketPath });
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const result = await rpc("POST /v1/viewer/auth/nonce");
			if (typeof result.nonce === "string") return result.nonce;
		} catch {
			// The detached child may still be opening the canonical database.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

async function existingViewerLoginUrl(
	invocation: ResolvedServeInvocation,
	rpc: ViewerRpcCall,
	request: typeof fetch = fetch,
): Promise<string> {
	const fail = () => new Error("Existing viewer is not bound to this database runtime.");
	const issueNonce = async () => {
		const result = await rpc("POST /v1/viewer/auth/nonce");
		if (typeof result.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.nonce)) {
			throw fail();
		}
		return result.nonce;
	};

	try {
		const probe = await probeCodememViewerLiveness(invocation, {
			fetch: request,
			timeoutMs: 1_000,
		});
		if (probe.state !== "live") throw fail();
		const challenge = await issueNonce();
		const origin = new URL(viewerUrl(invocation, "/")).origin;
		const exchange = await request(viewerUrl(invocation, "/api/auth/exchange"), {
			method: "POST",
			credentials: "omit",
			cache: "no-store",
			signal: AbortSignal.timeout(1_000),
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify({ nonce: challenge }),
		});
		if (!exchange.ok) throw fail();
		const payload = (await exchange.json()) as { session?: unknown };
		if (typeof payload.session !== "string" || !/^[A-Za-z0-9._-]{1,512}$/.test(payload.session)) {
			throw fail();
		}
		const logout = await rpc("POST /v1/viewer/auth/logout", { session: payload.session });
		if (logout.loggedOut !== true) throw fail();
		const nonce = await issueNonce();
		return `${viewerUrl(invocation, "/")}#auth=${encodeURIComponent(nonce)}`;
	} catch {
		throw fail();
	}
}

async function startBackgroundViewer(invocation: ResolvedServeInvocation): Promise<void> {
	if (warnIfViewerExposed(invocation.host, invocation.port)) return;
	const dataDir = resolveDataDirOpt({ dbPath: invocation.dbPath ?? undefined });
	if (await isPortOpen(invocation.host, invocation.port)) {
		const { createViewerRpcCall } = await import("@codemem/server");
		const rpc = createViewerRpcCall({ socketPath: resolveStorageLayout(dataDir).socketPath });
		p.log.warn(`Viewer already running at ${await existingViewerLoginUrl(invocation, rpc)}`);
		return;
	}
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		p.log.error("Unable to resolve CLI entrypoint for background launch");
		process.exitCode = 1;
		return;
	}
	const child = spawn(process.execPath, buildForegroundRunnerArgs(scriptPath, invocation), {
		cwd: process.cwd(),
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			CODEMEM_DATA_DIR: dataDir,
			...(invocation.dbPath ? { CODEMEM_DB: invocation.dbPath } : {}),
			...(invocation.configPath ? { CODEMEM_CONFIG: invocation.configPath } : {}),
		},
	});
	child.unref();
	if (invocation.dbPath) {
		writeFileSync(
			pidFilePath(invocation.dbPath),
			JSON.stringify({ pid: child.pid, host: invocation.host, port: invocation.port }),
			"utf-8",
		);
	}
	let browserUrl = viewerUrl(invocation, "/");
	const nonce = await issueViewerNonce(dataDir);
	const viewerReady = nonce ? await waitForPortOpen(invocation.host, invocation.port) : false;
	if (!nonce || !viewerReady) {
		try {
			if (typeof child.pid === "number") process.kill(child.pid, "SIGTERM");
		} catch {
			// Child already exited after startup failure.
		}
		if (invocation.dbPath) {
			try {
				rmSync(pidFilePath(invocation.dbPath));
			} catch {
				// No pidfile was published.
			}
		}
		p.log.error("Daemon did not become ready; viewer startup was aborted.");
		process.exitCode = 1;
		return;
	}
	browserUrl += `/#auth=${encodeURIComponent(nonce)}`;
	p.intro("codemem viewer");
	p.outro(`Viewer started in background (pid ${child.pid}). Open: ${browserUrl}`);
}

async function startForegroundViewer(invocation: ResolvedServeInvocation): Promise<void> {
	const { createApp, createViewerRpcCall } = await import("@codemem/server");
	const { serve } = await import("@hono/node-server");

	if (invocation.dbPath) process.env.CODEMEM_DB = invocation.dbPath;
	if (invocation.configPath) process.env.CODEMEM_CONFIG = invocation.configPath;
	if (warnIfViewerExposed(invocation.host, invocation.port)) return;
	if (await isPortOpen(invocation.host, invocation.port)) {
		p.log.warn(`Viewer already running at ${viewerUrl(invocation, "/")}`);
		process.exitCode = 1;
		return;
	}
	const dataDir = resolveDataDirOpt({ dbPath: invocation.dbPath ?? undefined });
	process.env.CODEMEM_DATA_DIR = dataDir;
	let daemon: DaemonHandle | null = null;
	if (readDaemonHealth(dataDir).status !== "ok") {
		try {
			daemon = await startDaemon({ dataDir });
		} catch (error) {
			if (readDaemonHealth(dataDir).status !== "ok") throw error;
		}
	}
	const rpc = createViewerRpcCall({ socketPath: resolveStorageLayout(dataDir).socketPath });
	let browserUrl = viewerUrl(invocation, "/");
	try {
		const result = await rpc("POST /v1/viewer/auth/nonce");
		if (typeof result.nonce === "string") {
			browserUrl += `/#auth=${encodeURIComponent(result.nonce)}`;
		}
	} catch (error) {
		await daemon?.stop();
		throw error;
	}

	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	const app = createApp({ rpc });
	const pidPath = pidFilePath(dbPath);

	const server = serve(
		{ fetch: app.fetch, hostname: invocation.host, port: invocation.port },
		(info) => {
			writeFileSync(
				pidPath,
				JSON.stringify({ pid: process.pid, host: invocation.host, port: invocation.port }),
				"utf-8",
			);
			p.intro("codemem viewer");
			p.log.success(`Listening on http://${info.address}:${info.port}`);
			p.log.info(`Open: ${browserUrl}`);
		},
	);

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			p.log.warn(`Viewer already running at ${viewerUrl(invocation, "/")}`);
		} else {
			p.log.error(err.message);
		}
		void (daemon?.stop() ?? Promise.resolve()).finally(() => process.exit(1));
	});

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		p.outro("shutting down");
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		}).catch(() => {
			// Best-effort drain — proceed to cleanup.
		});

		try {
			rmSync(pidPath);
		} catch {
			// ignore
		}
		await daemon?.stop();
		process.exit(0);
	};

	// Force-exit safety net if graceful shutdown stalls for an unusually long time.
	const forceShutdown = () => {
		setTimeout(() => {
			try {
				rmSync(pidPath);
			} catch {
				// ignore
			}
			process.exit(1);
		}, 30000).unref();
	};
	process.on("SIGINT", () => {
		forceShutdown();
		void shutdown();
	});
	process.on("SIGTERM", () => {
		forceShutdown();
		void shutdown();
	});
}

async function runServeInvocation(invocation: ResolvedServeInvocation): Promise<void> {
	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	const runtimeConflict = await findRuntimeViewerConflict(dbPath, {
		host: invocation.host,
		port: invocation.port,
	});
	if (runtimeConflict) {
		p.intro("codemem viewer");
		p.log.error(
			`Database runtime at ${dirname(dbPath)} is already managed by viewer ${runtimeConflict.host}:${runtimeConflict.port} (pid ${runtimeConflict.pid})`,
		);
		p.log.info(
			"Use the matching --host/--port, stop the existing viewer first, or use a separate db/runtime folder for another viewer.",
		);
		process.exitCode = 1;
		return;
	}
	if (invocation.mode === "stop" || invocation.mode === "restart") {
		const result = await stopExistingViewer(dbPath, {
			host: invocation.host,
			port: invocation.port,
		});
		if (result.stopped) {
			p.intro("codemem viewer");
			p.log.success(`Stopped viewer${result.pid ? ` (pid ${result.pid})` : ""}`);
			if (invocation.mode === "stop") {
				p.outro("done");
				return;
			}
			// Wait for port to be fully released before restarting.
			const released = await waitForPortRelease(invocation.host, invocation.port);
			if (!released) {
				p.log.warn(`Port ${invocation.port} still in use after stop — restart may fail`);
			}
		} else if (result.pid) {
			p.intro("codemem viewer");
			p.log.error(`Viewer is still shutting down (pid ${result.pid})`);
			process.exitCode = 1;
			return;
		} else if (invocation.mode === "stop") {
			p.intro("codemem viewer");
			p.outro("No background viewer found");
			return;
		}
	}

	if (invocation.mode === "start" || invocation.mode === "restart") {
		if (invocation.background) {
			await startBackgroundViewer({ ...invocation, dbPath });
			return;
		}
		await startForegroundViewer({ ...invocation, dbPath });
	}
}

const serveCmd = new Command("serve")
	.configureHelp(helpStyle)
	.description("Run or manage the viewer")
	.argument("[action]", "lifecycle action (start|stop|restart)");

addDbOption(serveCmd);
addConfigOption(serveCmd);
addViewerHostOptions(serveCmd);

// Legacy lifecycle flags — hidden from --help, emit deprecation warnings when used.
serveCmd.addOption(new Option("--background", "run viewer in background").hideHelp());
serveCmd.addOption(new Option("--foreground", "run viewer in foreground").hideHelp());
serveCmd.addOption(new Option("--stop", "stop background viewer").hideHelp());
serveCmd.addOption(new Option("--restart", "restart background viewer").hideHelp());

export const serveCommand = serveCmd.action(
	async (action: string | undefined, opts: LegacyServeOptions) => {
		try {
			// Emit deprecation warnings only when the legacy bare-flag form is
			// used (no lifecycle action). When an action is present (start,
			// stop, restart) the flags are being consumed by the modern
			// subcommand form — e.g. `codemem serve start --foreground` — and
			// should not be flagged as deprecated.
			if (action === undefined) {
				if (opts.stop) emitDeprecationWarning("--stop", "codemem serve stop");
				if (opts.restart) emitDeprecationWarning("--restart", "codemem serve restart");
				if (opts.background) emitDeprecationWarning("--background", "codemem serve start");
				if (opts.foreground)
					emitDeprecationWarning("--foreground", "codemem serve start --foreground");
			}

			const normalizedAction =
				action === undefined
					? undefined
					: action === "start" || action === "stop" || action === "restart"
						? (action as ServeAction)
						: null;
			if (normalizedAction === null) {
				p.log.error(`Unknown serve action: ${action}`);
				process.exitCode = 1;
				return;
			}
			await runServeInvocation(resolveServeInvocation(normalizedAction, opts));
		} catch (err) {
			p.log.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	},
);
