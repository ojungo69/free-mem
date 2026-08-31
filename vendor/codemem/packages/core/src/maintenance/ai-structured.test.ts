import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initTestSchema } from "../test-utils.js";
import { aiBackfillStructuredContent } from "./ai-structured.js";

const summaryProvider = {
	version: 1,
	role: "summary",
	state: "enabled",
	wireProtocol: "openai_chat_completions_v1",
	modelId: "deterministic-summary-model-v1",
	modelRevision: "1",
	endpointUrl: "https://summary.stub.invalid/v1/chat/completions",
	credentialRef: { kind: "environment", name: "FREE_MEM_SUMMARY_API_KEY" },
	providerFingerprint: "sha256:d184deae938722877e017d85ab382a4f72c287857bf0f346f483263680635ede",
	executionLocation: "remote",
	egressPolicy: "explicit_remote",
	costClass: "external_metered",
	tlsPolicy: "system",
	redirectPolicy: "reject",
} as const;

const observerProfile = {
	observerRequestTimeoutMs: 60_000,
	observerMaxInputChars: 12_000,
	observerMaxOutputTokens: 4_000,
	observerMaxResponseBytes: 1_048_576,
	observerTemperature: 0.2,
} as const;

type FrozenBackfillOptions = NonNullable<Parameters<typeof aiBackfillStructuredContent>[1]> & {
	summaryProvider: typeof summaryProvider;
	resourceProfile: typeof observerProfile;
	runtimeReason: "pending_privacy_boundary";
};

describe("AI structured maintenance frozen provider", () => {
	it("keeps frozen maintenance pending without reading legacy provider environment", async () => {
		const db = new Database(":memory:");
		const originalFetch = globalThis.fetch;
		const environment = {
			FREE_MEM_SUMMARY_API_KEY: process.env.FREE_MEM_SUMMARY_API_KEY,
			CODEMEM_OBSERVER_API_KEY: process.env.CODEMEM_OBSERVER_API_KEY,
			CODEMEM_OBSERVER_BASE_URL: process.env.CODEMEM_OBSERVER_BASE_URL,
			CODEMEM_OBSERVER_HEADERS: process.env.CODEMEM_OBSERVER_HEADERS,
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		};
		const namedToken = "fixture-maintenance-named-token";
		let request: { url: string; headers: Record<string, string> } | undefined;
		let fetchCalls = 0;

		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-08-31T00:00:00Z", "fixture-project").lastInsertRowid,
			);
			db.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active,
					created_at, updated_at, metadata_json, rev, visibility
				 ) VALUES (?, 'change', 'Fixture change', 'The fixture changed safely.', 0.8, '', 1,
					?, ?, '{}', 1, 'shared')`,
			).run(sessionId, "2026-08-31T00:00:00Z", "2026-08-31T00:00:00Z");

			process.env.FREE_MEM_SUMMARY_API_KEY = namedToken;
			process.env.CODEMEM_OBSERVER_API_KEY = "fixture-legacy-codemem-token";
			process.env.CODEMEM_OBSERVER_BASE_URL = "https://legacy.invalid/v1";
			process.env.CODEMEM_OBSERVER_HEADERS = JSON.stringify({ "x-legacy": "must-not-send" });
			process.env.OPENAI_API_KEY = "fixture-legacy-openai-token";
			globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
				fetchCalls += 1;
				request = {
					url: String(input),
					headers: Object.fromEntries(
						Object.entries((init.headers as Record<string, string>) ?? {}),
					),
				};
				const structured = JSON.stringify({
					narrative: "The fixture changed safely.",
					facts: ["The fixture changed"],
					concepts: ["what-changed"],
				});
				return new Response(
					JSON.stringify({
						output_text: structured,
						output: [{ type: "message", content: [{ type: "output_text", text: structured }] }],
						choices: [{ message: { content: structured } }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as typeof globalThis.fetch;

			const result = await aiBackfillStructuredContent(db, {
				dryRun: true,
				summaryProvider,
				resourceProfile: observerProfile,
				runtimeReason: "pending_privacy_boundary",
			} as FrozenBackfillOptions);

			expect(result).toMatchObject({ checked: 0, updated: 0, skipped: 1, failed: 0 });
			expect(fetchCalls).toBe(0);
			expect(request).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
			for (const [key, value] of Object.entries(environment)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			db.close();
		}
	});
});
