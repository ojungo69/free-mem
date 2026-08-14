import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activateDatabaseArtifact,
	readCurrentDatabasePointer,
	recoverStorageJournal,
	resolveStorageLayout,
	runLegacyMigration,
	type StorageLayout,
	sha256File,
} from "./storage.js";
import { ReadOnlyActor } from "./writer-actor.js";

const fsFault = vi.hoisted(() => ({
	plan: null as null | {
		kind:
			| "journal-write"
			| "journal-flush"
			| "journal-rename"
			| "fsync"
			| "pointer-rename"
			| "journal-cleanup";
		journalState?: "prepared" | "switched" | "committed";
		target?: string;
		occurrence?: number;
	},
	journalState: null as null | "prepared" | "switched" | "committed",
	matches: 0,
	fired: false,
	fsyncTargets: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const fail = (message: string): never => {
		fsFault.fired = true;
		const error = new Error(message) as NodeJS.ErrnoException;
		error.code = "EIO";
		throw error;
	};
	const matches = (kind: NonNullable<typeof fsFault.plan>["kind"]): boolean => {
		const plan = fsFault.plan;
		if (!plan || fsFault.fired || plan.kind !== kind) return false;
		fsFault.matches++;
		return fsFault.matches === (plan.occurrence ?? 1);
	};
	const journalTemp = (path: unknown): boolean =>
		/\/restore-journal\.json\.[^.]+\.[^.]+\.tmp$/.test(String(path));

	return {
		...actual,
		writeFileSync(...args: Parameters<typeof actual.writeFileSync>): void {
			if (journalTemp(args[0])) {
				try {
					const state = JSON.parse(String(args[1])).state;
					if (state === "prepared" || state === "switched" || state === "committed") {
						fsFault.journalState = state;
					}
				} catch {
					// Production validates journal JSON before this write.
				}
				const plan = fsFault.plan;
				if (plan?.journalState === fsFault.journalState && matches("journal-write")) {
					fail("synthetic journal temp write failure");
				}
				if (plan?.journalState === fsFault.journalState && matches("journal-flush")) {
					Reflect.apply(actual.writeFileSync, actual, [
						args[0],
						args[1],
						{ ...(args[2] as object), flush: false },
					]);
					fail("synthetic journal temp flush failure");
				}
			}
			actual.writeFileSync(...args);
		},
		renameSync(source: string, destination: string): void {
			const plan = fsFault.plan;
			if (
				destination.endsWith("/control/restore-journal.json") &&
				plan?.journalState === fsFault.journalState &&
				matches("journal-rename")
			) {
				fail("synthetic journal rename failure");
			}
			if (destination.endsWith("/db/current") && matches("pointer-rename")) {
				fail("synthetic pointer rename failure");
			}
			actual.renameSync(source, destination);
		},
		fsyncSync(fd: number): void {
			const target = actual.readlinkSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, "");
			fsFault.fsyncTargets.push(target);
			const plan = fsFault.plan;
			if (
				plan?.target === target &&
				(plan.journalState === undefined || plan.journalState === fsFault.journalState) &&
				matches("fsync")
			) {
				fail(`synthetic fsync failure: ${target}`);
			}
			actual.fsyncSync(fd);
		},
		unlinkSync(path: string): void {
			if (fsFault.plan?.target === path && matches("journal-cleanup")) {
				fail("synthetic committed journal cleanup failure");
			}
			actual.unlinkSync(path);
		},
	};
});

type ExpectedPointer = "OLD" | "NEW";

type FaultCase = {
	name: string;
	expected: ExpectedPointer;
	fault:
		| {
				kind: "journal-write" | "journal-flush" | "journal-rename";
				journalState: "prepared" | "switched" | "committed";
		  }
		| { kind: "journal-parent-fsync"; journalState: "prepared" | "switched" | "committed" }
		| { kind: "staging-artifact-fsync" | "staging-versions-fsync" }
		| { kind: "pointer-rename" | "pointer-parent-fsync" }
		| { kind: "reopen" | "integrity" }
		| { kind: "rollback-pointer-rename" | "rollback-pointer-parent-fsync" }
		| { kind: "committed-cleanup" };
};

const cases: FaultCase[] = [
	...(["prepared", "switched", "committed"] as const).flatMap((journalState) =>
		(["journal-write", "journal-flush", "journal-rename", "journal-parent-fsync"] as const).map(
			(kind): FaultCase => ({
				name: `${journalState}-${kind}`,
				fault: { kind, journalState },
				expected: journalState === "committed" && kind === "journal-parent-fsync" ? "NEW" : "OLD",
			}),
		),
	),
	{ name: "staging-artifact-fsync", fault: { kind: "staging-artifact-fsync" }, expected: "OLD" },
	{ name: "staging-versions-fsync", fault: { kind: "staging-versions-fsync" }, expected: "OLD" },
	{ name: "pointer-rename", fault: { kind: "pointer-rename" }, expected: "OLD" },
	{ name: "pointer-parent-fsync", fault: { kind: "pointer-parent-fsync" }, expected: "OLD" },
	{ name: "reopen", fault: { kind: "reopen" }, expected: "OLD" },
	{ name: "integrity", fault: { kind: "integrity" }, expected: "OLD" },
	{ name: "rollback-pointer-rename", fault: { kind: "rollback-pointer-rename" }, expected: "OLD" },
	{ name: "committed-cleanup", fault: { kind: "committed-cleanup" }, expected: "NEW" },
	{
		name: "rollback-pointer-parent-fsync",
		fault: { kind: "rollback-pointer-parent-fsync" },
		expected: "OLD",
	},
];

const roots: string[] = [];

function createDatabase(path: string, sentinel: ExpectedPointer): void {
	const db = new BetterSqlite3(path);
	try {
		db.exec("CREATE TABLE recovery_guard (value TEXT NOT NULL)");
		db.prepare("INSERT INTO recovery_guard(value) VALUES (?)").run(sentinel);
	} finally {
		db.close();
	}
	chmodSync(path, 0o600);
}

function fixture(index: number): {
	layout: StorageLayout;
	oldPointer: string;
	newPointer: string;
	newPath: string;
	artifactSha256: string;
} {
	const root = mkdtempSync(join(tmpdir(), `codemem-t057-${index}-`));
	roots.push(root);
	const layout = resolveStorageLayout(join(root, "data"));
	const oldSource = join(root, "old.sqlite");
	createDatabase(oldSource, "OLD");
	runLegacyMigration({
		layout,
		operationId: `seed-${index}`,
		verifiedBackupPath: oldSource,
		verifiedBackupSha256: sha256File(oldSource),
	});
	const oldPointer = readCurrentDatabasePointer(layout);
	if (!oldPointer) throw new Error("fixture did not publish the old database");
	const newPointer = `versions/restore-case-${index}.sqlite`;
	const newPath = join(layout.dbDir, newPointer);
	createDatabase(newPath, "NEW");
	return { layout, oldPointer, newPointer, newPath, artifactSha256: sha256File(newPath) };
}

function resetFsFault(): void {
	fsFault.plan = null;
	fsFault.journalState = null;
	fsFault.matches = 0;
	fsFault.fired = false;
}

function armFsFault(testCase: FaultCase, data: ReturnType<typeof fixture>): boolean {
	resetFsFault();
	fsFault.fsyncTargets.length = 0;
	const fault = testCase.fault;
	switch (fault.kind) {
		case "journal-write":
		case "journal-flush":
		case "journal-rename":
			fsFault.plan = { kind: fault.kind, journalState: fault.journalState };
			return false;
		case "journal-parent-fsync":
			fsFault.plan = {
				kind: "fsync",
				journalState: fault.journalState,
				target: data.layout.controlDir,
			};
			return false;
		case "staging-artifact-fsync":
			fsFault.plan = { kind: "fsync", target: data.newPath };
			return false;
		case "staging-versions-fsync":
			fsFault.plan = { kind: "fsync", target: data.layout.versionsDir };
			return false;
		case "pointer-rename":
			fsFault.plan = { kind: "pointer-rename" };
			return false;
		case "pointer-parent-fsync":
			fsFault.plan = { kind: "fsync", target: data.layout.dbDir };
			return false;
		case "rollback-pointer-rename":
			fsFault.plan = { kind: "pointer-rename", occurrence: 2 };
			return true;
		case "rollback-pointer-parent-fsync":
			fsFault.plan = { kind: "fsync", target: data.layout.dbDir, occurrence: 2 };
			return true;
		case "committed-cleanup":
			fsFault.plan = { kind: "journal-cleanup", target: data.layout.journalPath };
			return false;
		case "reopen":
		case "integrity":
			return true;
	}
}

function armReadFault(kind: "reopen" | "integrity", target: string): () => boolean {
	const originalOpen = ReadOnlyActor.open;
	let fired = false;
	vi.spyOn(ReadOnlyActor, "open").mockImplementation((path) => {
		if (!fired && path === target) {
			fired = true;
			if (kind === "reopen") {
				const error = new Error("synthetic database reopen failure") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			const actor = originalOpen(path);
			const originalPragma = actor.pragma.bind(actor);
			vi.spyOn(actor, "pragma").mockImplementation((source, options) =>
				source === "integrity_check"
					? [{ integrity_check: "synthetic failure" }]
					: originalPragma(source, options),
			);
			return actor;
		}
		return originalOpen(path);
	});
	return () => fired;
}

function assertCanonical(testCase: FaultCase, data: ReturnType<typeof fixture>): void {
	const expectedPointer = testCase.expected === "OLD" ? data.oldPointer : data.newPointer;
	const current = readCurrentDatabasePointer(data.layout);
	expect(current, testCase.name).toBe(expectedPointer);
	expect(realpathSync(data.layout.currentPointerPath), testCase.name).toBe(
		join(data.layout.dbDir, expectedPointer),
	);
	const db = ReadOnlyActor.open(join(data.layout.dbDir, expectedPointer));
	try {
		expect(db.prepare("SELECT value FROM recovery_guard").pluck().get(), testCase.name).toBe(
			testCase.expected,
		);
	} finally {
		db.close();
	}
	expect(existsSync(data.layout.journalPath), testCase.name).toBe(false);
	expect(
		readdirSync(data.layout.controlDir).filter((name) => name.startsWith("restore-journal.json.")),
		testCase.name,
	).toEqual([]);
	expect(lstatSync(data.layout.currentPointerPath).isSymbolicLink(), testCase.name).toBe(true);
	expect(
		readdirSync(data.layout.dbDir, { withFileTypes: true })
			.filter((entry) => entry.isSymbolicLink())
			.map((entry) => entry.name),
		testCase.name,
	).toEqual(["current"]);
	for (const suffix of ["-wal", "-shm"]) {
		expect(existsSync(`${join(data.layout.dbDir, expectedPointer)}${suffix}`), testCase.name).toBe(
			false,
		);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	resetFsFault();
	fsFault.fsyncTargets.length = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Phase 1 backup restore smoke", () => {
	it("P1-T057-01-backup-restore-fault-matrix", () => {
		for (const [index, testCase] of cases.entries()) {
			const data = fixture(index);
			const needsReadFault = armFsFault(testCase, data);
			const readFaultKind =
				testCase.fault.kind === "integrity" ? "integrity" : needsReadFault ? "reopen" : null;
			const readFaultFired = readFaultKind
				? armReadFault(readFaultKind, data.newPath)
				: () => false;
			let failure: unknown = null;
			try {
				activateDatabaseArtifact(data.layout, {
					operationId: `restore-case-${index}`,
					pointer: data.newPointer,
					artifactSha256: data.artifactSha256,
				});
			} catch (error) {
				failure = error;
			}

			expect(fsFault.plan === null || fsFault.fired, testCase.name).toBe(true);
			expect(!needsReadFault || readFaultFired(), testCase.name).toBe(true);
			expect(failure === null, testCase.name).toBe(testCase.expected === "NEW");
			const dbFsyncsBeforeRecovery = fsFault.fsyncTargets.filter(
				(target) => target === data.layout.dbDir,
			).length;
			vi.restoreAllMocks();
			resetFsFault();
			recoverStorageJournal(data.layout);
			if (testCase.fault.kind === "rollback-pointer-parent-fsync") {
				expect(
					fsFault.fsyncTargets.filter((target) => target === data.layout.dbDir).length -
						dbFsyncsBeforeRecovery,
					testCase.name,
				).toBe(1);
			}
			assertCanonical(testCase, data);
			rmSync(data.layout.dataDir, { recursive: true, force: true });
		}
	});
});
