import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { durableReplaceFile } from "./storage-platform.js";

export type ManagedBlock = {
	id: string;
	path: string;
	marker: string;
	fingerprint: string;
};

export type InstallManifest = {
	version: 1;
	blocks: ManagedBlock[];
};

function beginMarker(marker: string): string {
	return `# BEGIN ${marker}`;
}

function endMarker(marker: string): string {
	return `# END ${marker}`;
}

function fingerprintOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function wrapBlock(marker: string, content: string): string {
	return `${beginMarker(marker)}\n${content.trimEnd()}\n${endMarker(marker)}\n`;
}

function extractBlock(file: string, marker: string): string | null {
	const begin = beginMarker(marker);
	const end = endMarker(marker);
	const start = file.indexOf(begin);
	if (start < 0) return null;
	const stop = file.indexOf(end, start);
	if (stop < 0) return null;
	return file.slice(start, stop + end.length) + (file[stop + end.length] === "\n" ? "\n" : "");
}

export function applyManagedBlock(input: {
	path: string;
	id: string;
	marker: string;
	content: string;
}): ManagedBlock {
	const existing = existsSync(input.path) ? readFileSync(input.path, "utf8") : "";
	const wrapped = wrapBlock(input.marker, input.content);
	const previous = extractBlock(existing, input.marker);
	const next = previous
		? existing.replace(previous, wrapped)
		: `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${wrapped}`;
	durableReplaceFile(input.path, next);
	return {
		id: input.id,
		path: input.path,
		marker: input.marker,
		fingerprint: fingerprintOf(wrapped),
	};
}

export function removeManagedBlock(path: string, block: ManagedBlock): void {
	if (!existsSync(path)) return;
	const existing = readFileSync(path, "utf8");
	const current = extractBlock(existing, block.marker);
	if (current === null) return;
	if (fingerprintOf(current) !== block.fingerprint) {
		throw new Error(`Refusing to remove managed block ${block.id}: fingerprint mismatch.`);
	}
	durableReplaceFile(path, existing.replace(current, ""));
}

export function writeInstallManifest(path: string, manifest: InstallManifest): void {
	if (manifest.version !== 1) throw new Error("Unsupported install manifest version.");
	durableReplaceFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readInstallManifest(path: string): InstallManifest {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallManifest>;
	if (parsed.version !== 1 || !Array.isArray(parsed.blocks)) {
		throw new Error("Install manifest is malformed.");
	}
	return parsed as InstallManifest;
}

export function installWithManifest(input: {
	manifestPath: string;
	blocks: Array<{ id: string; path: string; marker: string; content: string }>;
}): InstallManifest {
	const blocks = input.blocks.map((block) => applyManagedBlock(block));
	const manifest: InstallManifest = { version: 1, blocks };
	writeInstallManifest(input.manifestPath, manifest);
	return manifest;
}

export function uninstallWithManifest(manifestPath: string): void {
	const manifest = readInstallManifest(manifestPath);
	for (const block of manifest.blocks) {
		removeManagedBlock(block.path, block);
	}
}
