import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type OperationalStatusSnapshot,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	resolveDbPath,
	VERSION,
} from "@codemem/core";
import { createMcpRpcClient, type McpRpcOutcome } from "@codemem/mcp";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	type ConfigOpts,
	type DbOpts,
	type JsonOpts,
	resolveDataDirOpt,
	resolveDbOpt,
} from "../shared-options.js";
import {
	observeViewerRuntime,
	parseViewerPidRecord,
	type ViewerRuntimeObservation,
} from "../viewer-runtime.js";

export type DatabaseState = "ready" | "missing" | "unavailable" | "unknown";
export type DaemonState = "running" | "not_running" | "unavailable";
export type MaintenanceState = "idle" | "running" | "failed" | "unknown";
export type SemanticIndexState = "healthy" | "pending" | "degraded" | "failed" | "unknown";
export type RawEventsState = "healthy" | "backlogged" | "failing" | "unknown";
export type ObserverState = "healthy" | "idle" | "backoff" | "failed" | "unconfigured" | "unknown";
export type AttentionSeverity = "warning" | "error";

export interface StatusAttention {
	code: string;
	severity: AttentionSeverity;
	message: string;
}

export interface OperationalStatusReport {
	checked_at: string;
	ok: boolean;
	version: string;
	daemon: { state: DaemonState };
	database: { state: DatabaseState };
	runtime: { viewer: ViewerRuntimeObservation["state"]; pid?: number };
	maintenance: { state: MaintenanceState };
	semantic_index: { state: SemanticIndexState };
	raw_events: { state: RawEventsState; pending: number };
	observer: { state: ObserverState };
	attention: StatusAttention[];
}

interface StatusOptions extends DbOpts, ConfigOpts, JsonOpts {}

export interface StatusDependencies {
	now: () => Date;
	exists: (path: string) => boolean;
	readText: (path: string) => string | null;
	readConfig: (path?: string) => Record<string, unknown>;
	resolveDbPath: (path?: string) => string;
	requestRpc: (
		dataDir: string,
		method: "GET /v1/health" | "GET /v1/doctor",
	) => Promise<McpRpcOutcome>;
	fetch: typeof fetch;
	isProcessRunning: (pid: number) => boolean | null;
	env: NodeJS.ProcessEnv;
	writeStdout: (text: string) => void;
	writeStderr: (text: string) => void;
	setExitCode: (code: number) => void;
}

const MAX_ATTENTION = 20;
const DEFAULT_VIEWER_PORT = 38_888;
const OBSERVER_IDENTITY_KEYS = [
	"observer_provider",
	"observer_model",
	"observer_runtime",
	"observer_base_url",
	"observer_simple_provider",
	"observer_simple_model",
	"observer_rich_provider",
	"observer_rich_model",
] as const;

const defaultDependencies: StatusDependencies = {
	now: () => new Date(),
	exists: existsSync,
	readText: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	readConfig: (path) => (path ? readCodememConfigFileAtPath(path) : readCodememConfigFile()),
	resolveDbPath,
	requestRpc: (dataDir, method) => createMcpRpcClient({ dataDir }).request(method, {}),
	fetch,
	isProcessRunning: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "EPERM"
			) {
				return null;
			}
			return false;
		}
	},
	env: process.env,
	writeStdout: (text) => console.log(text),
	writeStderr: (text) => console.error(text),
	setExitCode: (code) => {
		process.exitCode = code;
	},
};

function observerConfigured(config: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
	const fileConfigured = OBSERVER_IDENTITY_KEYS.some((key) => {
		const value = config[key];
		return typeof value === "string" && value.trim() !== "";
	});
	const envConfigured = OBSERVER_IDENTITY_KEYS.some((key) => {
		const value = env[`CODEMEM_${key.toUpperCase()}`];
		return typeof value === "string" && value.trim() !== "";
	});
	return fileConfigured || envConfigured;
}

function viewerDefaultTarget(env: NodeJS.ProcessEnv): { host: string; port: number } {
	const host = env.CODEMEM_VIEWER_HOST?.trim() || "127.0.0.1";
	const parsedPort = Number.parseInt(env.CODEMEM_VIEWER_PORT ?? "", 10);
	return {
		host,
		port:
			Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65_535
				? parsedPort
				: DEFAULT_VIEWER_PORT,
	};
}

export function boundAttention(items: StatusAttention[]): StatusAttention[] {
	return items.slice(0, MAX_ATTENTION).map((item) => ({
		code: item.code.replace(/[^a-z0-9_]/gi, "_").slice(0, 64),
		severity: item.severity,
		message: item.message.slice(0, 500),
	}));
}

function addDatabaseAttention(state: DatabaseState, attention: StatusAttention[]): void {
	if (state === "missing") {
		attention.push({
			code: "database_missing",
			severity: "error",
			message: "Database does not exist",
		});
	} else if (state === "unavailable") {
		attention.push({
			code: "database_unavailable",
			severity: "error",
			message: "Database could not be read",
		});
	}
}

function addDaemonAttention(state: DaemonState, attention: StatusAttention[]): void {
	if (state === "not_running") {
		attention.push({
			code: "daemon_not_running",
			severity: "warning",
			message: "Daemon is not running; run `codemem serve start` if needed",
		});
	} else if (state === "unavailable") {
		attention.push({
			code: "daemon_unavailable",
			severity: "error",
			message: "Daemon health could not be determined",
		});
	}
}

function doctorOperationalStatus(
	result: Record<string, unknown>,
): OperationalStatusSnapshot | null {
	const diagnostics = result.diagnostics;
	if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
	const snapshot = (diagnostics as Record<string, unknown>).operationalStatus;
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
	return snapshot as OperationalStatusSnapshot;
}

function addRuntimeAttention(
	runtime: ViewerRuntimeObservation,
	attention: StatusAttention[],
): void {
	if (runtime.state === "stopped") {
		attention.push({
			code: "viewer_stopped",
			severity: "warning",
			message: "Viewer is stopped; run `codemem serve start` if needed",
		});
		return;
	}
	if (runtime.state === "unreachable") {
		attention.push({
			code: "viewer_unreachable",
			severity: "warning",
			message: "Viewer did not answer its local health check",
		});
		return;
	}
	if (runtime.attention_code) {
		const messages: Record<NonNullable<ViewerRuntimeObservation["attention_code"]>, string> = {
			viewer_pid_malformed: "Viewer PID record is malformed",
			viewer_non_loopback: "Viewer PID record is not loopback; no request was made",
			viewer_not_ready: "Viewer is running but its database is not ready",
			viewer_unexpected_response: "Viewer returned an unexpected local health response",
			viewer_wrong_service: "Local health endpoint did not identify codemem viewer",
		};
		attention.push({
			code: runtime.attention_code,
			severity: "warning",
			message: messages[runtime.attention_code],
		});
	}
}

function projectDatabaseSubsystems(
	snapshot: OperationalStatusSnapshot | null,
	configuredObserver: boolean,
	attention: StatusAttention[],
): Pick<OperationalStatusReport, "maintenance" | "semantic_index" | "raw_events" | "observer"> {
	if (!snapshot) {
		return {
			maintenance: { state: "unknown" },
			semantic_index: { state: "unknown" },
			raw_events: { state: "unknown", pending: 0 },
			observer: { state: configuredObserver ? "unknown" : "unconfigured" },
		};
	}
	if (snapshot.maintenance.state === "failed") {
		attention.push({
			code: "maintenance_failed",
			severity: "error",
			message: "Maintenance has failed jobs; run `codemem maintenance status`",
		});
	} else if (snapshot.maintenance.state === "running") {
		attention.push({
			code: "maintenance_running",
			severity: "warning",
			message: "Maintenance work is in progress",
		});
	}
	if (snapshot.semantic_index.state === "failed") {
		attention.push({
			code: "semantic_index_failed",
			severity: "error",
			message: "Semantic index maintenance failed; run `codemem maintenance status`",
		});
	} else if (snapshot.semantic_index.state === "pending") {
		attention.push({
			code: "semantic_index_pending",
			severity: "warning",
			message: "Semantic index maintenance is pending",
		});
	} else if (snapshot.semantic_index.state === "degraded") {
		attention.push({
			code: "semantic_index_degraded",
			severity: "warning",
			message: "Semantic search is unavailable; keyword search remains available",
		});
	}

	const pending = Math.max(0, Math.trunc(snapshot.raw_events.pending));
	let rawState: RawEventsState = snapshot.raw_events.available ? "healthy" : "unknown";
	if (snapshot.raw_events.failed_batches > 0) {
		rawState = "failing";
		attention.push({
			code: "raw_events_failing",
			severity: "error",
			message: "Raw-event ingestion exhausted retries recently; run `codemem db raw-events-gate`",
		});
	} else if (pending > 0) {
		rawState = "backlogged";
		attention.push({
			code: "raw_events_backlogged",
			severity: "warning",
			message: `${pending} raw events pending; run \`codemem db raw-events-status\``,
		});
	}

	let observerState: ObserverState = "unconfigured";
	if (configuredObserver) observerState = snapshot.observer.available ? "idle" : "unknown";
	if (configuredObserver && snapshot.observer.failed_batches > 0) {
		observerState = "failed";
		attention.push({
			code: "observer_failed",
			severity: "error",
			message: "Observer exhausted retries recently; run `codemem db raw-events-gate`",
		});
	} else if (configuredObserver && snapshot.observer.backoff_batches > 0) {
		observerState = "backoff";
		attention.push({
			code: "observer_backoff",
			severity: "warning",
			message: "Observer has retryable failures; run `codemem db raw-events-status`",
		});
	}
	return {
		maintenance: { state: snapshot.maintenance.state },
		semantic_index: { state: snapshot.semantic_index.state },
		raw_events: { state: rawState, pending },
		observer: { state: observerState },
	};
}

export async function collectStatusReport(
	opts: StatusOptions,
	deps: StatusDependencies = defaultDependencies,
): Promise<OperationalStatusReport> {
	const checkedAt = deps.now();
	const config = deps.readConfig(opts.config);
	const dbPath = deps.resolveDbPath(resolveDbOpt(opts));
	const dataDir = resolveDataDirOpt(opts);
	const health = await deps.requestRpc(dataDir, "GET /v1/health");
	let daemonState: DaemonState = "not_running";
	let databaseState: DatabaseState = "unknown";
	let snapshot: OperationalStatusSnapshot | null = null;
	if (health.ok) {
		daemonState = "running";
		const doctor = await deps.requestRpc(dataDir, "GET /v1/doctor");
		if (doctor.ok) {
			databaseState = "ready";
			snapshot = doctorOperationalStatus(doctor.result);
		} else {
			databaseState = "unavailable";
		}
	} else if (health.error.code !== "daemon_unavailable") {
		daemonState = "unavailable";
		databaseState = "unavailable";
	}

	const pidPath = join(dirname(dbPath), "viewer.pid");
	const parsedPid = parseViewerPidRecord(deps.exists(pidPath) ? deps.readText(pidPath) : null);
	const runtime = await observeViewerRuntime(
		parsedPid,
		{
			fetch: deps.fetch,
			isProcessRunning: deps.isProcessRunning,
		},
		viewerDefaultTarget(deps.env),
	);
	const attention: StatusAttention[] = [];
	addDaemonAttention(daemonState, attention);
	addDatabaseAttention(databaseState, attention);
	addRuntimeAttention(runtime, attention);
	const subsystems = projectDatabaseSubsystems(
		snapshot,
		observerConfigured(config, deps.env),
		attention,
	);
	const ok = !attention.some((item) => item.severity === "error");
	const boundedAttention = boundAttention(attention);
	return {
		checked_at: checkedAt.toISOString(),
		ok,
		version: VERSION,
		daemon: { state: daemonState },
		database: { state: databaseState },
		runtime: runtime.pid ? { viewer: runtime.state, pid: runtime.pid } : { viewer: runtime.state },
		...subsystems,
		attention: boundedAttention,
	};
}

export function renderStatusReport(report: OperationalStatusReport): string {
	const lines = [
		`codemem status ${report.ok ? "OK" : "ATTENTION"}`,
		`Daemon:         ${report.daemon.state}`,
		`Database:       ${report.database.state}`,
		`Viewer:         ${report.runtime.viewer}${report.runtime.pid ? ` (pid ${report.runtime.pid})` : ""}`,
		`Maintenance:    ${report.maintenance.state}`,
		`Semantic index: ${report.semantic_index.state}`,
		`Raw events:     ${report.raw_events.state}${
			report.raw_events.pending > 0 ? ` (${report.raw_events.pending} pending)` : ""
		}`,
		`Observer:       ${report.observer.state}`,
	];
	if (report.attention.length > 0) {
		lines.push(
			"Attention:",
			...report.attention.map((item) => `- ${item.severity}: ${item.message}`),
		);
	}
	return lines.join("\n");
}

export function createStatusCommand(overrides: Partial<StatusDependencies> = {}): Command {
	const deps: StatusDependencies = { ...defaultDependencies, ...overrides };
	const command = new Command("status")
		.configureHelp(helpStyle)
		.description("Show local operational status")
		.allowUnknownOption(true)
		.allowExcessArguments(true);
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	return command.action(async (opts: StatusOptions, actionCommand: Command) => {
		if (actionCommand.args.length > 0) {
			const message = "status accepts only documented options and no positional arguments";
			if (opts.json) deps.writeStdout(JSON.stringify({ error: "usage_error", message }));
			else deps.writeStderr(message);
			deps.setExitCode(2);
			return;
		}
		try {
			const report = await collectStatusReport(opts, deps);
			deps.writeStdout(opts.json ? JSON.stringify(report) : renderStatusReport(report));
			deps.setExitCode(0);
		} catch {
			const error = { error: "status_failed", message: "Unable to collect operational status" };
			if (opts.json) deps.writeStdout(JSON.stringify(error));
			else deps.writeStderr(error.message);
			deps.setExitCode(1);
		}
	});
}

export const statusCommand = createStatusCommand();
