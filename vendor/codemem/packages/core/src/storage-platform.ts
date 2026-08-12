import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function assertSupportedStoragePlatform(): void {
	if (process.platform !== "linux") {
		throw new Error(`Local storage is supported only on Linux/WSL; got ${process.platform}.`);
	}
}

export function ensurePrivateDirectory(path: string): void {
	assertSupportedStoragePlatform();
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

export function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function durableReplaceFile(path: string, contents: string): void {
	const parent = dirname(path);
	ensurePrivateDirectory(parent);
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
			flush: true,
		});
		renameSync(temporaryPath, path);
		fsyncPath(parent);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The temporary file may not have been created or may already be renamed.
		}
		throw error;
	}
}

export function durableRemoveFile(path: string): void {
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	unlinkSync(path);
	fsyncPath(dirname(path));
}

export function durableReplaceSymlink(path: string, target: string): void {
	const parent = dirname(path);
	ensurePrivateDirectory(parent);
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		symlinkSync(target, temporaryPath);
		renameSync(temporaryPath, path);
		fsyncPath(parent);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The temporary link may not have been created or may already be renamed.
		}
		throw error;
	}
}

export function durableCopyFile(source: string, destination: string): void {
	ensurePrivateDirectory(dirname(destination));
	copyFileSync(source, destination, constants.COPYFILE_EXCL);
	chmodSync(destination, 0o600);
	fsyncPath(destination);
	fsyncPath(dirname(destination));
}
