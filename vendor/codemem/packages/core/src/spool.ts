import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { validateMemoryKind } from "./memory-kinds.js";
import { canonicalMutationJson, hashMutationPayload } from "./mutation-dispatcher.js";
import {
	isNormalizedEventKind,
	NORMALIZED_EVENT_FIELDS,
	validateNormalizedEvent,
} from "./normalized-event.js";
import type { AgentMemoryConfig, RedactionResult } from "./redaction-pipeline.js";
import { preprocessAdapterEvent } from "./redaction-pipeline.js";
import { resolveStorageLayout } from "./storage.js";
import {
	durableRemoveFile,
	ensurePrivateDirectory,
	fsyncPath,
	readProcessIdentity,
} from "./storage-platform.js";

export const SPOOL_NORMAL_QUOTA_BYTES = 128 * 1024 * 1024;
export const SPOOL_RESERVED_QUOTA_BYTES = 16 * 1024 * 1024;
export const SPOOL_QUARANTINE_QUOTA_BYTES = 32 * 1024 * 1024;
export const SPOOL_FILE_MAX_BYTES = 64 * 1024;
export const SPOOL_RESERVED_MIN_EVENTS = 64;
export const SPOOL_LOCK_DEADLINE_MS = 100;

const COUNTER_BYTES = 4096;
const COUNTER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WARNING_RATIO = 0.8;
const LOCK_OWNER_MAX_BYTES = 2048;
const LOCK_INITIALIZATION_GRACE_MS = 25;
const LOCK_WAIT_MS = 5;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
// ponytail: One global lock keeps quota/counter/claim atomic; shard only if measured contention exceeds the deadline.
const RESERVED_EVENT_KINDS = new Set(["pre_compact", "session_ended"]);
const METHOD_FIELDS: Record<string, readonly string[]> = {
	"POST /v1/events": ["idempotencyKey", "event"],
	"POST /v1/memories/record": ["idempotencyKey", "kind", "title", "body", "confidence", "project"],
};

export type SpoolQuotaClass = "normal" | "reserved";

export type SpoolLayout = {
	rootDir: string;
	tmpDir: string;
	readyDir: string;
	quarantineDir: string;
	lockPath: string;
	counterPath: string;
};

export type SpoolLockHandle = {
	close(): void;
};

export type SpoolMutation = {
	method: "POST /v1/events" | "POST /v1/memories/record";
	idempotencyKey: string;
	body: Record<string, unknown>;
};

export type SpoolWriteResult = {
	status: "queued" | "duplicate" | "dropped";
	quotaClass: SpoolQuotaClass;
	reason?: "quota_full" | "disk_full" | "lock_timeout" | "io_error" | "invalid";
	path?: string;
};

export type SpoolStatus = {
	normalBytes: number;
	reservedBytes: number;
	quarantineBytes: number;
	tmpFiles: number;
	readyFiles: number;
	quarantineFiles: number;
	dropped: DropCounter;
	warnings: string[];
	critical: boolean;
};

export type DropCounter = {
	version: 1;
	total: number;
	byKind: Record<string, number>;
	firstDroppedAt: string | null;
	lastDroppedAt: string | null;
	quarantineRejected: number;
};

export type SpoolEntry = {
	version: 1;
	method: SpoolMutation["method"];
	idempotencyKey: string;
	payloadHash: string;
	quotaClass: SpoolQuotaClass;
	redaction: SpoolRedactionMetadata;
	body: Record<string, unknown>;
};

export type SpoolRedactionMetadata = {
	sensitivity: "normal" | "private" | "secret";
	secret_rules_version: string;
	redaction_degraded: boolean;
	private_content_omitted: boolean;
	local_only: boolean;
};

type Usage = {
	normalBytes: number;
	reservedBytes: number;
	quarantineBytes: number;
	tmpFiles: number;
	readyFiles: number;
	quarantineFiles: number;
};

export type SpoolOptions = {
	dataDir?: string;
	lockDeadlineMs?: number;
	config?: AgentMemoryConfig;
	onWarning?: (message: string) => void;
};

const EMPTY_COUNTER: DropCounter = {
	version: 1,
	total: 0,
	byKind: {},
	firstDroppedAt: null,
	lastDroppedAt: null,
	quarantineRejected: 0,
};

export function resolveSpoolLayout(dataDir?: string): SpoolLayout {
	const storage = resolveStorageLayout(dataDir);
	const rootDir = storage.spoolDir;
	return {
		rootDir,
		tmpDir: join(rootDir, "tmp"),
		readyDir: join(rootDir, "ready"),
		quarantineDir: join(rootDir, "quarantine"),
		lockPath: join(rootDir, "lock"),
		counterPath: join(rootDir, "dropped-counter"),
	};
}

function ensureSpoolDirectories(layout: SpoolLayout): void {
	ensurePrivateDirectory(layout.rootDir);
	ensurePrivateDirectory(layout.tmpDir);
	ensurePrivateDirectory(layout.readyDir);
	ensurePrivateDirectory(layout.quarantineDir);
}

type SpoolLockOwner = {
	version: 1;
	pid: number;
	startTime: string;
	fingerprint: string;
	nonce: string;
};

function readLockOwner(lockPath: string): SpoolLockOwner | null {
	try {
		const info = lstatSync(lockPath);
		if (!info.isFile() || info.isSymbolicLink() || info.size > LOCK_OWNER_MAX_BYTES) return null;
		const value = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<SpoolLockOwner>;
		if (
			value.version !== 1 ||
			!Number.isInteger(value.pid) ||
			Number(value.pid) <= 0 ||
			typeof value.startTime !== "string" ||
			typeof value.fingerprint !== "string" ||
			typeof value.nonce !== "string"
		) {
			return null;
		}
		return value as SpoolLockOwner;
	} catch {
		return null;
	}
}

function sameLockOwner(left: SpoolLockOwner | null, right: SpoolLockOwner): boolean {
	return (
		left?.pid === right.pid &&
		left.startTime === right.startTime &&
		left.fingerprint === right.fingerprint &&
		left.nonce === right.nonce
	);
}

function lockOwnerAlive(owner: SpoolLockOwner): boolean {
	try {
		const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const state = stat.slice(closeParen + 2).split(" ")[0];
		if (state === "Z" || state === "X") return false;
		const live = readProcessIdentity(owner.pid);
		return live.startTime === owner.startTime && live.fingerprint === owner.fingerprint;
	} catch {
		return false;
	}
}

function removeStaleLock(lockPath: string): boolean {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(lockPath);
	} catch {
		return true;
	}
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error("Spool lock path is not a regular file.");
	}
	const owner = readLockOwner(lockPath);
	if (owner && lockOwnerAlive(owner)) return false;
	if (!owner && Date.now() - info.mtimeMs <= LOCK_INITIALIZATION_GRACE_MS) return false;

	const currentInfo = lstatSync(lockPath);
	if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) return false;
	const currentOwner = readLockOwner(lockPath);
	if (owner ? !sameLockOwner(currentOwner, owner) : currentOwner !== null) return false;
	try {
		unlinkSync(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	fsyncPath(dirname(lockPath));
	return true;
}

function sleepForLock(milliseconds: number): void {
	Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, milliseconds);
}

export class SpoolLockTimeoutError extends Error {
	constructor() {
		super("Spool lock deadline exceeded.");
		this.name = "SpoolLockTimeoutError";
	}
}

export function acquireSpoolLock(
	dataDir?: string,
	deadlineMs = SPOOL_LOCK_DEADLINE_MS,
): SpoolLockHandle {
	const deadline = normalizedDeadline(deadlineMs);
	const layout = resolveSpoolLayout(dataDir);
	ensureSpoolDirectories(layout);
	const processIdentity = readProcessIdentity(process.pid);
	const owner: SpoolLockOwner = {
		version: 1,
		pid: process.pid,
		startTime: processIdentity.startTime,
		fingerprint: processIdentity.fingerprint,
		nonce: randomUUID(),
	};
	const expiresAt = performance.now() + deadline;
	for (;;) {
		try {
			const descriptor = openSync(layout.lockPath, "wx", 0o600);
			try {
				const lockIdentity = fstatSync(descriptor);
				const contents = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
				let offset = 0;
				while (offset < contents.length) {
					const written = writeSync(descriptor, contents, offset, contents.length - offset, offset);
					if (written === 0) throw new Error("Spool lock write made no progress.");
					offset += written;
				}
				fsyncSync(descriptor);
				const published = lstatSync(layout.lockPath);
				if (
					published.dev !== lockIdentity.dev ||
					published.ino !== lockIdentity.ino ||
					!sameLockOwner(readLockOwner(layout.lockPath), owner)
				) {
					const collision = new Error(
						"Spool lock was replaced during initialization.",
					) as NodeJS.ErrnoException;
					collision.code = "EEXIST";
					throw collision;
				}
				fsyncPath(layout.rootDir);
				let open = true;
				return {
					close(): void {
						if (!open) return;
						open = false;
						try {
							const current = lstatSync(layout.lockPath);
							if (
								current.dev !== lockIdentity.dev ||
								current.ino !== lockIdentity.ino ||
								!sameLockOwner(readLockOwner(layout.lockPath), owner)
							) {
								return;
							}
							unlinkSync(layout.lockPath);
							fsyncPath(layout.rootDir);
						} catch {
							// A failed release is recovered after this process exits.
						} finally {
							closeSync(descriptor);
						}
					},
				};
			} catch (error) {
				try {
					const lockIdentity = fstatSync(descriptor);
					const current = lstatSync(layout.lockPath);
					if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
						unlinkSync(layout.lockPath);
						fsyncPath(layout.rootDir);
					}
				} catch {
					// The lock may have been replaced or removed.
				}
				closeSync(descriptor);
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			removeStaleLock(layout.lockPath);
			const remaining = expiresAt - performance.now();
			if (remaining <= 0) throw new SpoolLockTimeoutError();
			sleepForLock(Math.min(LOCK_WAIT_MS, remaining));
		}
	}
}

function encodeCounter(counter: DropCounter): Buffer {
	const contents = Buffer.from(`${JSON.stringify(counter)}\n`, "utf8");
	if (contents.length > COUNTER_BYTES) throw new Error("Spool dropped counter is full.");
	const buffer = Buffer.alloc(COUNTER_BYTES, 0x20);
	contents.copy(buffer);
	return buffer;
}

function initializeCounter(path: string): void {
	if (existsSync(path)) return;
	writeFileSync(path, encodeCounter(EMPTY_COUNTER), {
		flag: "wx",
		mode: 0o600,
		flush: true,
	});
	fsyncPath(dirname(path));
}

function readCounter(path: string): DropCounter {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== COUNTER_BYTES) {
		throw new Error("Spool dropped counter is malformed.");
	}
	const parsed = JSON.parse(readFileSync(path, "utf8").trim()) as Partial<DropCounter>;
	if (
		parsed.version !== 1 ||
		!Number.isSafeInteger(parsed.total) ||
		Number(parsed.total) < 0 ||
		!parsed.byKind ||
		typeof parsed.byKind !== "object" ||
		Array.isArray(parsed.byKind) ||
		!Number.isSafeInteger(parsed.quarantineRejected) ||
		Number(parsed.quarantineRejected) < 0 ||
		(parsed.firstDroppedAt !== null &&
			(typeof parsed.firstDroppedAt !== "string" ||
				!COUNTER_TIMESTAMP.test(parsed.firstDroppedAt))) ||
		(parsed.lastDroppedAt !== null &&
			(typeof parsed.lastDroppedAt !== "string" || !COUNTER_TIMESTAMP.test(parsed.lastDroppedAt)))
	) {
		throw new Error("Spool dropped counter is malformed.");
	}
	for (const [kind, value] of Object.entries(parsed.byKind)) {
		if (
			(kind !== "memory_record" && !isNormalizedEventKind(kind)) ||
			!Number.isSafeInteger(value) ||
			value < 0
		) {
			throw new Error("Spool dropped counter is malformed.");
		}
	}
	return parsed as DropCounter;
}

function writeCounter(path: string, counter: DropCounter): void {
	const descriptor = openSync(path, "r+");
	try {
		const buffer = encodeCounter(counter);
		let offset = 0;
		while (offset < buffer.length) {
			const written = writeSync(descriptor, buffer, offset, buffer.length - offset, offset);
			if (written === 0) throw new Error("Spool dropped counter write made no progress.");
			offset += written;
		}
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function incrementQuarantineRejected(layout: SpoolLayout): void {
	const current = readCounter(layout.counterPath);
	writeCounter(layout.counterPath, {
		...current,
		quarantineRejected: current.quarantineRejected + 1,
	});
}

function warn(callback: ((message: string) => void) | undefined, message: string): void {
	try {
		(callback ?? console.error)(`[codemem] ${message}`);
	} catch {
		// Diagnostics must not block the calling Agent.
	}
}

function dropKind(input: SpoolMutation): string {
	if (input.method === "POST /v1/memories/record") return "memory_record";
	const event = input.body.event;
	return event && typeof event === "object" && !Array.isArray(event)
		? String((event as Record<string, unknown>).kind ?? "unknown")
		: "unknown";
}

function incrementDrop(
	layout: SpoolLayout,
	kind: string,
	onWarning?: (message: string) => void,
): void {
	try {
		const current = readCounter(layout.counterPath);
		const now = new Date().toISOString();
		writeCounter(layout.counterPath, {
			...current,
			total: current.total + 1,
			byKind: { ...current.byKind, [kind]: (current.byKind[kind] ?? 0) + 1 },
			firstDroppedAt: current.firstDroppedAt ?? now,
			lastDroppedAt: now,
		});
	} catch {
		// A completely full disk may prevent even the preallocated counter rewrite.
		warn(onWarning, "spool drop counter could not be updated; event was dropped.");
	}
}

function validateIdempotencyKey(value: unknown): string {
	const hasControlCharacter =
		typeof value === "string" &&
		Array.from(value).some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 0x20 || code === 0x7f;
		});
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > 256 ||
		hasControlCharacter
	) {
		throw new Error("A bounded idempotencyKey is required before spooling.");
	}
	const checked = preprocessAdapterEvent(
		{ idempotencyKey: value },
		{ allowlist: ["idempotencyKey"], metadataKeys: ["idempotencyKey"] },
	).payload.idempotencyKey;
	if (checked !== value) throw new Error("idempotencyKey contains sensitive content.");
	return value;
}

function rejectUnknownFields(
	value: Record<string, unknown>,
	allowed: Set<string>,
	label: string,
): void {
	const unknown = Object.keys(value).find((field) => !allowed.has(field));
	if (unknown) throw new Error(`${label} contains an unsupported field: ${unknown}`);
}

function spoolRedaction(result: RedactionResult): SpoolRedactionMetadata {
	return {
		sensitivity: result.sensitivity,
		secret_rules_version: result.secret_rules_version,
		redaction_degraded: result.degraded,
		private_content_omitted: result.private_content_omitted,
		local_only: result.local_only,
	};
}

function prepareMutation(input: SpoolMutation, config?: AgentMemoryConfig): SpoolEntry {
	const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
	const methodFields = METHOD_FIELDS[input.method];
	if (!methodFields) throw new Error("RPC method is not spoolable.");
	rejectUnknownFields(input.body, new Set(methodFields), "Spool request");
	if (input.body.idempotencyKey !== idempotencyKey) {
		throw new Error("Request idempotencyKey must match the spool envelope.");
	}

	let body: Record<string, unknown>;
	let redaction: SpoolRedactionMetadata;
	let quotaClass: SpoolQuotaClass = "normal";
	if (input.method === "POST /v1/events") {
		const rawEvent = input.body.event;
		if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
			throw new Error("event is required before spooling.");
		}
		const redacted = preprocessAdapterEvent(rawEvent, {
			allowlist: [...NORMALIZED_EVENT_FIELDS],
			metadataKeys: NORMALIZED_EVENT_FIELDS.filter((field) => field !== "payload"),
			config,
		});
		const event = redacted.payload;
		if (!Object.hasOwn(event, "payload")) event.payload = {};
		if (event.idempotencyKey !== idempotencyKey) {
			throw new Error("event.idempotencyKey must match the spool envelope.");
		}
		validateNormalizedEvent(event);
		if (redacted.sensitivity === "secret") event.sensitivity = "secret";
		else if (redacted.sensitivity === "private" && event.sensitivity === "normal") {
			event.sensitivity = "private";
		}
		redaction = spoolRedaction(redacted);
		redaction.sensitivity = event.sensitivity as SpoolRedactionMetadata["sensitivity"];
		quotaClass = RESERVED_EVENT_KINDS.has(String(event.kind)) ? "reserved" : "normal";
		body = { idempotencyKey, event };
	} else {
		const redacted = preprocessAdapterEvent(input.body, {
			allowlist: [...methodFields],
			metadataKeys: ["idempotencyKey", "kind", "confidence", "project"],
			config,
		});
		body = redacted.payload;
		redaction = spoolRedaction(redacted);
		try {
			body.kind = validateMemoryKind(String(body.kind));
		} catch {
			throw new Error("Memory kind is unsupported.");
		}
		if (
			body.idempotencyKey !== idempotencyKey ||
			typeof body.kind !== "string" ||
			typeof body.title !== "string" ||
			body.title.length === 0 ||
			typeof body.body !== "string" ||
			body.body.length === 0 ||
			(body.project !== undefined && typeof body.project !== "string") ||
			(body.confidence !== undefined &&
				(typeof body.confidence !== "number" ||
					!Number.isFinite(body.confidence) ||
					body.confidence < 0 ||
					body.confidence > 1))
		) {
			throw new Error("Memory record is incomplete after adapter preprocessing.");
		}
	}

	const payloadHash = hashMutationPayload({ method: input.method, body, redaction });
	return {
		version: 1,
		method: input.method,
		idempotencyKey,
		payloadHash,
		quotaClass,
		redaction,
		body,
	};
}

function scanDirectory(path: string, usage: Usage, area: "tmp" | "ready" | "quarantine"): void {
	for (const name of readdirSync(path)) {
		const entryPath = join(path, name);
		const info = lstatSync(entryPath);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error("Spool directories may contain only regular files.");
		}
		if (area === "quarantine") {
			usage.quarantineBytes += info.size;
			usage.quarantineFiles++;
			continue;
		}
		if (name.startsWith("reserved-")) usage.reservedBytes += info.size;
		else usage.normalBytes += info.size;
		if (area === "tmp") usage.tmpFiles++;
		else usage.readyFiles++;
	}
}

function scanUsage(layout: SpoolLayout): Usage {
	const usage: Usage = {
		normalBytes: 0,
		reservedBytes: 0,
		quarantineBytes: 0,
		tmpFiles: 0,
		readyFiles: 0,
		quarantineFiles: 0,
	};
	scanDirectory(layout.tmpDir, usage, "tmp");
	scanDirectory(layout.readyDir, usage, "ready");
	scanDirectory(layout.quarantineDir, usage, "quarantine");
	return usage;
}

function readSpoolFile(path: string): string {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > SPOOL_FILE_MAX_BYTES) {
		throw new Error("Spool entry is not a bounded regular file.");
	}
	return readFileSync(path, "utf8");
}

function capacityError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG";
}

function normalizedDeadline(value: number | undefined): number {
	if (value === undefined) return SPOOL_LOCK_DEADLINE_MS;
	if (!Number.isInteger(value) || value < 1 || value > 250) {
		throw new Error("Spool lock deadline must be between 1 and 250ms.");
	}
	return value;
}

function resultForIoFailure(
	input: SpoolMutation,
	entry: SpoolEntry,
	layout: SpoolLayout,
	error: unknown,
	onWarning?: (message: string) => void,
): SpoolWriteResult {
	incrementDrop(layout, dropKind(input), onWarning);
	if (capacityError(error)) {
		warn(onWarning, "spool disk full; event was dropped.");
		return { status: "dropped", quotaClass: entry.quotaClass, reason: "disk_full" };
	}
	warn(onWarning, "spool write failed; event was dropped.");
	return { status: "dropped", quotaClass: entry.quotaClass, reason: "io_error" };
}

export function spoolMutation(input: SpoolMutation, options: SpoolOptions = {}): SpoolWriteResult {
	let entry: SpoolEntry;
	try {
		entry = prepareMutation(input, options.config);
	} catch {
		warn(options.onWarning, "spool rejected an invalid mutation; event was dropped.");
		const kind = dropKind(input);
		return {
			status: "dropped",
			quotaClass: RESERVED_EVENT_KINDS.has(kind) ? "reserved" : "normal",
			reason: "invalid",
		};
	}
	const layout = resolveSpoolLayout(options.dataDir);

	let lock: SpoolLockHandle;
	try {
		lock = acquireSpoolLock(options.dataDir, options.lockDeadlineMs);
	} catch (error) {
		if (error instanceof SpoolLockTimeoutError) {
			warn(options.onWarning, "spool lock deadline exceeded; event was dropped.");
			return { status: "dropped", quotaClass: entry.quotaClass, reason: "lock_timeout" };
		}
		warn(
			options.onWarning,
			capacityError(error)
				? "spool disk full; event was dropped."
				: "spool lock failed; event was dropped.",
		);
		return {
			status: "dropped",
			quotaClass: entry.quotaClass,
			reason: capacityError(error) ? "disk_full" : "io_error",
		};
	}

	try {
		initializeCounter(layout.counterPath);
		const keyHash = createHash("sha256").update(entry.idempotencyKey, "utf8").digest("hex");
		const stem = `${entry.quotaClass}-${keyHash}-${entry.payloadHash}`;
		const readyPath = join(layout.readyDir, `${stem}.json`);
		const tmpPath = join(layout.tmpDir, `${stem}.json.tmp`);
		const serialized = `${canonicalMutationJson(entry)}\n`;
		const bytes = Buffer.byteLength(serialized, "utf8");
		if (bytes > SPOOL_FILE_MAX_BYTES) throw new Error("Spool entry exceeds 64 KiB.");

		if (existsSync(readyPath)) {
			if (readSpoolFile(readyPath) !== serialized) {
				return resultForIoFailure(
					input,
					entry,
					layout,
					new Error("Existing spool entry does not match its content hash."),
					options.onWarning,
				);
			}
			return { status: "duplicate", quotaClass: entry.quotaClass, path: readyPath };
		}
		if (existsSync(tmpPath)) {
			if (readSpoolFile(tmpPath) !== serialized) {
				return resultForIoFailure(
					input,
					entry,
					layout,
					new Error("Existing spool temp entry is incomplete or corrupt."),
					options.onWarning,
				);
			}
			try {
				renameSync(tmpPath, readyPath);
				fsyncPath(layout.tmpDir);
				fsyncPath(layout.readyDir);
				return { status: "queued", quotaClass: entry.quotaClass, path: readyPath };
			} catch (error) {
				return resultForIoFailure(input, entry, layout, error, options.onWarning);
			}
		}

		const usage = scanUsage(layout);
		const used = entry.quotaClass === "reserved" ? usage.reservedBytes : usage.normalBytes;
		const quota =
			entry.quotaClass === "reserved" ? SPOOL_RESERVED_QUOTA_BYTES : SPOOL_NORMAL_QUOTA_BYTES;
		if (used + bytes > quota) {
			incrementDrop(layout, dropKind(input), options.onWarning);
			warn(options.onWarning, `${entry.quotaClass} spool quota full; event was dropped.`);
			return { status: "dropped", quotaClass: entry.quotaClass, reason: "quota_full" };
		}

		try {
			writeFileSync(tmpPath, serialized, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
				flush: true,
			});
			renameSync(tmpPath, readyPath);
			fsyncPath(layout.tmpDir);
			fsyncPath(layout.readyDir);
		} catch (error) {
			return resultForIoFailure(input, entry, layout, error, options.onWarning);
		}

		if ((used + bytes) / quota >= WARNING_RATIO) {
			warn(options.onWarning, `${entry.quotaClass} spool usage reached 80%.`);
		}
		return { status: "queued", quotaClass: entry.quotaClass, path: readyPath };
	} catch (error) {
		return resultForIoFailure(input, entry, layout, error, options.onWarning);
	} finally {
		lock.close();
	}
}

export function quarantineSpoolEntry(
	dataDir: string,
	readyName: string,
	reason: "broken_json" | "idempotency_conflict",
): { status: "moved" | "full"; path?: string } {
	if (
		basename(readyName) !== readyName ||
		!readyName.endsWith(".json") ||
		(reason !== "broken_json" && reason !== "idempotency_conflict")
	) {
		throw new Error("Invalid spool quarantine request.");
	}
	const layout = resolveSpoolLayout(dataDir);
	const lock = acquireSpoolLock(dataDir);
	try {
		initializeCounter(layout.counterPath);
		const source = join(layout.readyDir, readyName);
		const info = lstatSync(source);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error("Ready spool entry is not a regular file.");
		}
		const usage = scanUsage(layout);
		if (usage.quarantineBytes + info.size > SPOOL_QUARANTINE_QUOTA_BYTES) {
			incrementQuarantineRejected(layout);
			return { status: "full" };
		}
		const destination = join(layout.quarantineDir, `${reason}-${readyName}`);
		if (existsSync(destination)) throw new Error("Quarantine entry already exists.");
		renameSync(source, destination);
		fsyncPath(layout.readyDir);
		fsyncPath(layout.quarantineDir);
		return { status: "moved", path: destination };
	} finally {
		lock.close();
	}
}

export function readSpoolStatus(dataDir?: string): SpoolStatus {
	const layout = resolveSpoolLayout(dataDir);
	const lock = acquireSpoolLock(dataDir);
	try {
		initializeCounter(layout.counterPath);
		const usage = scanUsage(layout);
		const dropped = readCounter(layout.counterPath);
		const warnings: string[] = [];
		if (usage.normalBytes / SPOOL_NORMAL_QUOTA_BYTES >= WARNING_RATIO) {
			warnings.push("normal spool usage reached 80%");
		}
		if (usage.reservedBytes / SPOOL_RESERVED_QUOTA_BYTES >= WARNING_RATIO) {
			warnings.push("reserved spool usage reached 80%");
		}
		if (usage.quarantineBytes / SPOOL_QUARANTINE_QUOTA_BYTES >= WARNING_RATIO) {
			warnings.push("spool quarantine usage reached 80%");
		}
		return {
			...usage,
			dropped,
			warnings,
			critical:
				dropped.total > 0 ||
				dropped.quarantineRejected > 0 ||
				usage.reservedBytes >= SPOOL_RESERVED_QUOTA_BYTES ||
				usage.quarantineBytes >= SPOOL_QUARANTINE_QUOTA_BYTES,
		};
	} finally {
		lock.close();
	}
}

export type LegacySpoolSource = "claude" | "codex";

export async function drainLegacySpool(
	dataDir: string,
	handler: (
		source: LegacySpoolSource,
		payload: Record<string, unknown>,
	) => boolean | Promise<boolean>,
): Promise<{ processed: number; failed: number }> {
	const result = { processed: 0, failed: 0 };
	const directories: Array<[LegacySpoolSource, string]> = [
		["claude", join(dataDir, "claude-hook-spool")],
		["codex", join(dataDir, "codex-hook-spool")],
	];
	for (const [source, directory] of directories) {
		if (!existsSync(directory)) continue;
		const directoryInfo = lstatSync(directory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
			throw new Error("Legacy spool path is not a private directory.");
		}
		for (const name of readdirSync(directory).sort()) {
			if (!name.endsWith(".json") || name.startsWith(".hook-tmp-") || name.startsWith(".bad-")) {
				continue;
			}
			const path = join(directory, name);
			try {
				const info = lstatSync(path);
				if (!info.isFile() || info.isSymbolicLink() || basename(path) !== name) {
					throw new Error("Legacy spool entry is not a regular file.");
				}
				if (info.size > SPOOL_FILE_MAX_BYTES) {
					throw new Error("Legacy spool entry exceeds 64 KiB.");
				}
				const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new Error("Legacy spool entry is malformed.");
				}
				if (!(await handler(source, parsed as Record<string, unknown>))) {
					result.failed++;
					continue;
				}
				durableRemoveFile(path);
				result.processed++;
			} catch {
				result.failed++;
			}
		}
	}
	return result;
}
