import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "@codemem/core";

export function resolveOpencodeConfigPath(configDir: string): string {
	const jsonPath = join(configDir, "opencode.json");
	if (existsSync(jsonPath)) return jsonPath;
	const jsoncPath = join(configDir, "opencode.jsonc");
	if (existsSync(jsoncPath)) return jsoncPath;
	return jsoncPath;
}

export function loadJsoncConfig(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf-8");
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		const cleaned = stripTrailingCommas(stripJsonComments(raw));
		return JSON.parse(cleaned) as Record<string, unknown>;
	}
}

export function writeJsonConfig(path: string, data: Record<string, unknown>): void {
	atomicReplaceSetupFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

function fsyncParentBestEffort(path: string): void {
	if (process.platform === "win32") return;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(dirname(path), "r");
		fsyncSync(descriptor);
	} catch {
		// Some supported filesystems do not permit opening/fsyncing directories.
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Directory fsync is best-effort on cross-platform editor config paths.
			}
		}
	}
}

export function atomicReplaceSetupFile(
	path: string,
	contents: string | Uint8Array,
	mode?: number,
): void {
	mkdirSync(dirname(path), { recursive: true });
	let writeMode = mode ?? 0o600;
	if (mode === undefined && existsSync(path)) {
		const current = lstatSync(path);
		if (!current.isFile() || current.isSymbolicLink()) {
			throw new Error(`Refusing to atomically replace a non-regular setup file: ${path}`);
		}
		writeMode = current.mode & 0o777;
	}
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, contents, { flag: "wx", mode: writeMode, flush: true });
		if (process.platform !== "win32") chmodSync(temporary, writeMode);
		renameSync(temporary, path);
		fsyncParentBestEffort(path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary may not exist or may already have been renamed.
		}
		throw error;
	}
}

export function atomicRemoveSetupFile(path: string): void {
	if (!existsSync(path)) return;
	unlinkSync(path);
	fsyncParentBestEffort(path);
}
