import { describe, expect, it } from "vitest";
import { observerStatusRoutes } from "./observer-status.js";

const frozenStatus = {
	configurationFingerprint:
		"sha256:2a5a5d2d3803d8f2dc2767981cbbf4f77cffc3aae8cebdc9d310e7645b27d53d",
	summaryProvider: {
		providerFingerprint: "sha256:d184deae938722877e017d85ab382a4f72c287857bf0f346f483263680635ede",
		wireProtocol: "openai_chat_completions_v1",
		modelId: "deterministic-summary-model-v1",
		endpointUrl: "https://summary.stub.invalid/v1/chat/completions",
		credentialRef: { kind: "environment", name: "FREE_MEM_SUMMARY_API_KEY" },
	},
	readiness: "pending_privacy_boundary",
} as const;

type ObserverStatusRouteFactory = (deps: {
	getStore: () => unknown;
	getSweeper: () => null;
	getObserver: () => null;
	getCapabilitySnapshot: () => typeof frozenStatus;
}) => ReturnType<typeof observerStatusRoutes>;

describe("viewer frozen observer status", () => {
	it("reports one frozen safe identity without probing later legacy credentials", async () => {
		const previousOpenAI = process.env.OPENAI_API_KEY;
		const store = {
			rawEventBacklogTotals: () => ({ pending: 0, sessions: 0 }),
			latestRawEventFlushFailure: () => null,
		};
		const createRoutes = observerStatusRoutes as unknown as ObserverStatusRouteFactory;
		const routes = createRoutes({
			getStore: () => store,
			getSweeper: () => null,
			getObserver: () => null,
			getCapabilitySnapshot: () => frozenStatus,
		});

		try {
			const before = (await (await routes.request("/api/observer-status")).json()) as Record<
				string,
				unknown
			>;
			process.env.OPENAI_API_KEY = "fixture-late-legacy-token";
			const after = (await (await routes.request("/api/observer-status")).json()) as Record<
				string,
				unknown
			>;

			expect(before.capability).toEqual(frozenStatus);
			expect(before.active).toBeNull();
			expect(after).toEqual(before);
			expect(before).toHaveProperty("available_credentials", {});
			expect(JSON.stringify(before)).not.toContain("fixture-late-legacy-token");
		} finally {
			if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousOpenAI;
		}
	});
});
