import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statfsSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

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

const NETWORK_FS_TYPES = new Set<number>([
	0x6969, // NFS
	0x517b, // SMB
	0xff534d42, // CIFS
	0xfe534d42, // SMB2
	0x01021997, // 9P
	0x65735546, // FUSE (sshfs / rclone / gvfs / s3fs)
	0x6a656a63, // virtiofs
	0x00c36400, // Ceph
	0x6b414653, // kAFS
	0x5346414f, // AFS
	0x0bd00bd0, // Lustre
	0x01161970, // GFS2
	0x7461636f, // OCFS2
]);

const FORBIDDEN_MOUNT_FSTYPES = new Set([
	"nfs",
	"nfs4",
	"cifs",
	"smb3",
	"smbfs",
	"9p",
	"drvfs",
	"virtiofs",
	"ceph",
	"afs",
	"lustre",
	"gfs2",
	"ocfs2",
]);

export function isNetworkFilesystemType(type: number | bigint): boolean {
	const numeric = typeof type === "bigint" ? Number(type) : type;
	return NETWORK_FS_TYPES.has(numeric >>> 0);
}

export function isForbiddenMountFstype(fstype: string): boolean {
	const normalized = fstype.toLowerCase();
	return normalized.startsWith("fuse") || FORBIDDEN_MOUNT_FSTYPES.has(normalized);
}

export function isWslWindowsSharePath(path: string): boolean {
	const normalized = resolve(path).replaceAll("\\", "/").toLowerCase();
	return /^\/mnt\/[a-z](\/|$)/.test(normalized);
}

function existingAncestor(path: string): string {
	let current = resolve(path);
	for (;;) {
		if (existsSync(current)) return current;
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

function decodeMountinfoPath(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, digits: string) =>
		String.fromCharCode(Number.parseInt(digits, 8)),
	);
}

function mountFstypeFor(path: string): string | null {
	let mountInfo: string;
	try {
		mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
	} catch {
		return null;
	}
	const resolved = resolve(path);
	let best: { mountPoint: string; fstype: string } | null = null;
	for (const line of mountInfo.split("\n")) {
		if (!line) continue;
		const separator = line.indexOf(" - ");
		if (separator < 0) continue;
		const left = line.slice(0, separator).split(" ");
		const right = line.slice(separator + 3).split(" ");
		const mountPoint = decodeMountinfoPath(left[4] ?? "");
		const fstype = right[0] ?? "";
		if (!mountPoint || !fstype) continue;
		const prefix = mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`;
		if (resolved !== mountPoint && !resolved.startsWith(prefix) && mountPoint !== "/") {
			continue;
		}
		if (mountPoint === "/" && resolved !== "/" && !resolved.startsWith("/")) continue;
		if (!best || mountPoint.length > best.mountPoint.length) {
			best = { mountPoint, fstype };
		}
	}
	return best?.fstype ?? null;
}

export function assertDataDirPreflight(dataDir: string): void {
	assertSupportedStoragePlatform();
	if (isWslWindowsSharePath(dataDir)) {
		throw new Error("data_dir preflight rejected a WSL-Windows share path.");
	}
	const probe = existingAncestor(dataDir);
	if (isNetworkFilesystemType(statfsSync(probe).type)) {
		throw new Error("data_dir preflight rejected a network filesystem.");
	}
	const fstype = mountFstypeFor(probe);
	if (fstype && isForbiddenMountFstype(fstype)) {
		throw new Error("data_dir preflight rejected a network filesystem.");
	}
}

export function readProcessIdentity(pid: number): { startTime: string; fingerprint: string } {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const closeParen = stat.lastIndexOf(")");
	if (closeParen < 0) throw new Error(`Cannot parse /proc/${pid}/stat.`);
	const startTime = stat.slice(closeParen + 2).split(" ")[19];
	if (!startTime) throw new Error(`Cannot read start time for pid ${pid}.`);
	let bootId = "";
	try {
		bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		// boot_id is a uniqueness aid; starttime still distinguishes PID reuse on one boot.
	}
	const link = readlinkSync(`/proc/${pid}/exe`);
	const target = link.endsWith(" (deleted)") ? link.slice(0, -" (deleted)".length) : link;
	let exe: string;
	try {
		exe = realpathSync(target);
	} catch {
		exe = target;
	}
	const cmdline = readFileSync(`/proc/${pid}/cmdline`);
	return {
		startTime: `${bootId}:${startTime}`,
		fingerprint: createHash("sha256").update(exe).update("\0").update(cmdline).digest("hex"),
	};
}
