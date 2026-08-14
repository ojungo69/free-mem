import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_DATA_DIR = join(homedir(), ".codemem");

export interface StorageLayout {
	dataDir: string;
	controlDir: string;
	dbDir: string;
	versionsDir: string;
	currentPointerPath: string;
	journalPath: string;
	installManifestPath: string;
	lockPath: string;
	identityPath: string;
	socketPath: string;
	spoolDir: string;
	backupsDir: string;
}

export function resolveStorageLayout(dataDir: string = DEFAULT_DATA_DIR): StorageLayout {
	const root = resolve(dataDir);
	const controlDir = join(root, "control");
	const dbDir = join(root, "db");
	return {
		dataDir: root,
		controlDir,
		dbDir,
		versionsDir: join(dbDir, "versions"),
		currentPointerPath: join(dbDir, "current"),
		journalPath: join(controlDir, "restore-journal.json"),
		installManifestPath: join(controlDir, "install-manifest.json"),
		lockPath: join(controlDir, "lock.db"),
		identityPath: join(controlDir, "identity.json"),
		socketPath: join(controlDir, "daemon.sock"),
		spoolDir: join(controlDir, "spool"),
		backupsDir: join(controlDir, "backups"),
	};
}
