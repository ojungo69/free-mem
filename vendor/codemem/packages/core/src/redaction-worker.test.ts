import { describe, expect, it } from "vitest";
import { REDACTION_WORKER_DEADLINE_MS, WorkerSecretScanner } from "./redaction-worker.js";
import { SecretScanner } from "./secret-scanner.js";

// Deliberately no warmRedactionWorker() call in this file: the cold-start path is what
// #119 is about. This anchors the scenario, not the timing - starting the worker measures
// 75-89 ms here against a 100 ms budget, so charging startup to the scan deadline only
// throws once the machine is busy enough to close that margin.
describe("WorkerSecretScanner cold start", () => {
	it("redacts on the first scan of a process, before anything warms the worker", () => {
		const scanner = new WorkerSecretScanner(new SecretScanner());
		expect(scanner.scan(`ghp_${"A".repeat(36)}`).redacted).toBe("[REDACTED:github_pat_classic]");
	});

	it("keeps the 100 ms scan budget", () => {
		expect(REDACTION_WORKER_DEADLINE_MS).toBe(100);
	});
});
