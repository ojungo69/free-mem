import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "./index.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_PAT = `ghp_${"A".repeat(36)}`;
const INJECTED = `<injected-context>echo ${AWS_KEY}</injected-context>`;

function captureLogs(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const push = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	const log = vi.spyOn(console, "log").mockImplementation(push);
	const warn = vi.spyOn(console, "warn").mockImplementation(push);
	const error = vi.spyOn(console, "error").mockImplementation(push);
	const info = vi.spyOn(console, "info").mockImplementation(push);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		lines.push(String(chunk));
		return true;
	});
	return {
		lines,
		restore: () => {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
			info.mockRestore();
			stderr.mockRestore();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Phase 1 redaction", () => {
	it("P1-T038-01-adapter-order", () => {
		const result = core.preprocessAdapterEvent(
			{
				denied_secret: `${"Z".repeat(40_000)}${AWS_KEY}`,
				path: "~/agent-memory/demo",
				body: `${INJECTED}visible ${GITHUB_PAT}`,
			},
			{ allowlist: ["body", "path"] },
		);
		expect(result.payload).not.toHaveProperty("denied_secret");
		expect(typeof result.payload.body).toBe("string");
		expect(result.payload.body).toContain("visible");
		expect(result.payload.body).not.toContain(AWS_KEY);
		expect(result.payload.body).not.toContain("<injected-context>");
		expect(result.payload.body).not.toContain(GITHUB_PAT);
		expect(result.payload.body).toMatch(/\[REDACTED:/);
		expect(result.payload.path).toBe(`${homedir()}/agent-memory/demo`);
		expect(result.sensitivity).toBe("secret");
		expect(result.secret_rules_version.length).toBeGreaterThan(0);
	});

	it("P1-T038-02-private-tag-grammar", () => {
		const result = core.preprocessAdapterEvent(
			{
				nested: "keep <private>outer<private>inner</private>LEAK</private> after",
				unclosed: "keep <private>UNCLOSED_SECRET",
				closed: "keep <private>hidden</private> visible",
				local: "note <local-only>device-only</local-only> done",
			},
			{ allowlist: ["nested", "unclosed", "closed", "local"] },
		);
		expect(String(result.payload.nested)).toBe("keep  after");
		expect(String(result.payload.nested)).not.toContain("LEAK");
		expect(String(result.payload.nested)).not.toContain("inner");
		expect(String(result.payload.unclosed)).toBe("keep ");
		expect(String(result.payload.unclosed)).not.toContain("UNCLOSED_SECRET");
		expect(String(result.payload.closed)).toBe("keep  visible");
		expect(String(result.payload.local)).toBe("note device-only done");
		expect(result.private_content_omitted).toBe(true);
		expect(result.local_only).toBe(true);
		expect(result.sensitivity).toBe("private");

		const nestedOpen = core.preprocessAdapterEvent(
			{ body: "keep <private>outer<private>inner</private>LEAK" },
			{ allowlist: ["body"] },
		);
		expect(String(nestedOpen.payload.body)).toBe("keep ");
		expect(String(nestedOpen.payload.body)).not.toContain("LEAK");
		expect(nestedOpen.private_content_omitted).toBe(true);

		const oversized = `${"x".repeat(300)}<private>${"SECRET_NOTE".repeat(80)}</private> ok`;
		const clipped = core.preprocessAdapterEvent({ body: oversized }, { allowlist: ["body"] });
		expect(String(clipped.payload.body)).not.toContain("SECRET_NOTE");
		expect(clipped.private_content_omitted).toBe(true);

		const splitPat = `ghp_${"A".repeat(18)}</private>${"A".repeat(18)}`;
		const reassembled = core.preprocessAdapterEvent({ body: splitPat }, { allowlist: ["body"] });
		expect(String(reassembled.payload.body)).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
		expect(String(reassembled.payload.body)).not.toContain("ghp_");

		const dottedI = `${"İ".repeat(34)}<private>UNCLOSED_SECRET</private> visible`;
		const folded = core.preprocessAdapterEvent({ body: dottedI }, { allowlist: ["body"] });
		expect(String(folded.payload.body)).not.toContain("UNCLOSED_SECRET");
		expect(String(folded.payload.body)).toContain("visible");

		const rebuilt = core.preprocessAdapterEvent(
			{ body: "<pri<private>x</private>vate>LEAK" },
			{ allowlist: ["body"] },
		);
		expect(String(rebuilt.payload.body)).not.toContain("LEAK");
	});

	it("P1-T038-03-japanese-redaction", () => {
		const prose =
			"このアプリケーションコンフィギュレーションはスーパーユーザー向けのドキュメントです";
		const mixed = `認証情報は ${AWS_KEY} を設定ファイルへ書かない`;
		const result = core.preprocessAdapterEvent({ prose, mixed }, { allowlist: ["prose", "mixed"] });
		expect(result.payload.prose).toBe(prose);
		expect(String(result.payload.mixed)).not.toContain(AWS_KEY);
		expect(String(result.payload.mixed)).toContain("認証情報は");
		expect(String(result.payload.mixed)).toMatch(/\[REDACTED:/);
	});

	it("P1-T038-04-daemon-second-layer", () => {
		const raw = { body: `token ${GITHUB_PAT}`, title: "keep" };
		const intake = core.applyDaemonIntake(raw, { allowlist: ["body", "title"] });
		const serialized = JSON.stringify(intake);
		expect(serialized).not.toContain(GITHUB_PAT);
		expect(intake.sensitivity).toBe("secret");
		expect(intake.payload.body).toBeUndefined();
		expect(intake.payload.title).toBeUndefined();
	});

	it("P1-T038-05-config-fail-closed", () => {
		const parsed = core.parseAgentMemoryToml(`
remote_processing = "true"
extra_allow_sync = true
secret_regex = 123
tool_field_allowlist = "body"
`);
		expect(parsed.remoteProcessing).toBe(false);
		expect(parsed.warnings.length).toBeGreaterThan(0);
		expect(parsed.toolFieldAllowlist).toEqual([]);
		expect(parsed.secretRules).toEqual([]);
		expect(parsed.degraded).toBe(true);
		expect(parsed.warnings.join("\n")).not.toMatch(/true|123|body|AKIA|ghp_/);
		const leakedLine = core.parseAgentMemoryToml(`${AWS_KEY} without-equals`);
		expect(leakedLine.warnings.join("\n")).not.toContain(AWS_KEY);
		const dropped = core.preprocessAdapterEvent(
			{ body: "plain text only" },
			{ config: parsed, allowlist: ["body"] },
		);
		expect(dropped.degraded).toBe(true);
		expect(dropped.payload.body).toBeUndefined();
	});

	it("P1-T038-06-no-plaintext-log", () => {
		const logs = captureLogs();
		try {
			const adapter = core.preprocessAdapterEvent(
				{ body: `password=${GITHUB_PAT}` },
				{ allowlist: ["body"] },
			);
			const intake = core.applyDaemonIntake(
				{ body: `password=${AWS_KEY}` },
				{ allowlist: ["body"] },
			);
			const dumped = `${logs.lines.join("\n")}\n${JSON.stringify(adapter)}\n${JSON.stringify(intake)}`;
			expect(dumped).not.toContain(GITHUB_PAT);
			expect(dumped).not.toContain(AWS_KEY);
		} finally {
			logs.restore();
		}
	});
});
