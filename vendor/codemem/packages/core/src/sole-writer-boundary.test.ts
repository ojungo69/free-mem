import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

function productionSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "dist" || entry.name === "node_modules" ? [] : productionSources(path);
		}
		if (
			!entry.name.endsWith(".ts") ||
			entry.name.endsWith(".test.ts") ||
			entry.name.endsWith(".eval.test.ts") ||
			entry.name === "test-utils.ts" ||
			entry.name === "test-schema.generated.ts"
		) {
			return [];
		}
		return [path];
	});
}

describe("Phase 1 sole-writer boundary", () => {
	it("P1-T048-01-zero-external-db-handles", () => {
		const allowedByOpener: Record<string, Set<string>> = {
			connect: new Set([
				"packages/core/src/daemon-canonical.ts",
				"packages/core/src/daemon-jobs.ts",
				"packages/core/src/db.ts",
			]),
			memoryStore: new Set([
				"packages/core/src/daemon-canonical.ts",
				"packages/core/src/daemon-jobs.ts",
			]),
			actorOpen: new Set([
				"packages/core/src/db.ts",
				"packages/core/src/online-backup.ts",
				"packages/core/src/storage.ts",
				"packages/core/src/writer-actor.ts",
			]),
			rawDatabase: new Set([
				"packages/core/src/daemon-lifecycle.ts",
				"packages/core/src/writer-actor.ts",
			]),
		};
		const patterns: Record<string, RegExp> = {
			connect: /(?<![\w.])connect(?:ReadOnly)?\s*\(/,
			memoryStore: /new\s+MemoryStore\s*\(/,
			actorOpen: /\b(?:WriterActor|ReadOnlyActor)\.open\s*\(/,
			rawDatabase: /new\s+(?:BetterSqlite3|Database)\s*\(/,
		};
		const violations: string[] = [];
		for (const path of productionSources(resolve(repoRoot, "packages"))) {
			const sourcePath = relative(repoRoot, path).replaceAll("\\", "/");
			const source = readFileSync(path, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			for (const [opener, pattern] of Object.entries(patterns)) {
				if (pattern.test(source) && !allowedByOpener[opener]?.has(sourcePath)) {
					violations.push(`${sourcePath}: ${opener}`);
				}
			}
		}

		expect(violations).toEqual([]);
		for (const name of [
			"connect",
			"connectReadOnly",
			"ReadOnlyActor",
			"WriterActor",
			"openMigratedWriter",
			"MemoryStore",
			"openTestMemoryStore",
			"exportMemories",
			"importMemories",
			"initDatabase",
			"vacuumDatabase",
			"getMemoryArtifactReport",
			"getMemoryRoleReport",
			"getRawEventRelinkPlan",
			"getRawEventRelinkReport",
			"getRawEventStatus",
			"getReliabilityMetrics",
			"rawEventsGate",
			"retryRawEventFailures",
			"DedupKeyBackfillRunner",
			"RefBackfillRunner",
			"ScopeBackfillRunner",
			"SessionContextBackfillRunner",
			"SummaryDedupBackfillRunner",
			"VectorModelMigrationRunner",
		]) {
			expect(Reflect.get(core, name), `${name} must not be a public DB bypass`).toBeUndefined();
		}
	});
});
