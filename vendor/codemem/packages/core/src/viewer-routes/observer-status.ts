/**
 * Observer status route — GET /api/observer-status.
 *
 * Ports Python's viewer_routes/observer_status.py.
 * Returns observer runtime info, credential availability, and queue status.
 */

import { Hono } from "hono";
import { captureOnlyCapabilityProjection } from "../capability-manifest.js";
import type { ObserverClient } from "../observer-client.js";
import type { RawEventSweeper } from "../raw-event-sweeper.js";
import type { MemoryStore } from "../store.js";

type StoreFactory = () => MemoryStore;

export interface ObserverStatusDeps {
	getStore: StoreFactory;
	getSweeper: () => RawEventSweeper | null;
	getObserver?: () => ObserverClient | null;
	getCapabilitySnapshot?: () => Record<string, unknown>;
}

function normalizeActiveObserver(active: ReturnType<ObserverClient["getStatus"]> | null) {
	if (!active) return null;
	return {
		...active,
		auth: {
			...active.auth,
			method: active.auth.type,
			token_present: active.auth.hasToken,
		},
	};
}

function capabilityObserverStatus(capability: Record<string, unknown>) {
	if (capability.providerEnabled !== true) return null;
	const provider = capability.summaryProvider;
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) return null;
	const choice = provider as Record<string, unknown>;
	const credential = choice.credentialRef;
	const credentialKind =
		credential && typeof credential === "object" && !Array.isArray(credential)
			? (credential as Record<string, unknown>).kind
			: "none";
	return {
		provider:
			choice.wireProtocol === "anthropic_messages_v1"
				? "anthropic"
				: choice.wireProtocol === "openai_chat_completions_v1"
					? "openai"
					: null,
		model: typeof choice.modelId === "string" ? choice.modelId : null,
		runtime: "api_http",
		auth: { method: credentialKind, token_present: false },
	};
}

function buildFailureImpact(
	latestFailure: Record<string, unknown> | null,
	queueTotals: { pending: number; sessions: number },
	authBackoff: { active: boolean; remainingS: number },
): string | null {
	if (!latestFailure) return null;
	if (authBackoff.active) {
		return `Queue retries paused for ~${authBackoff.remainingS}s after an observer auth failure.`;
	}
	if (queueTotals.pending > 0) {
		return `${queueTotals.pending} queued raw events across ${queueTotals.sessions} session(s) are waiting on a successful flush.`;
	}
	return "Failed flush batches are pending retry.";
}

export function observerStatusRoutes(deps?: ObserverStatusDeps) {
	const app = new Hono();

	app.get("/api/observer-status", (c) => {
		const store = deps?.getStore();
		const sweeper = deps?.getSweeper();
		const observer = deps?.getObserver?.() ?? null;
		const capability = deps?.getCapabilitySnapshot?.() ?? captureOnlyCapabilityProjection();

		// Stub fallback when store doesn't have the required methods (e.g. tests with mock store)
		if (!store || typeof store.rawEventBacklogTotals !== "function") {
			return c.json({
				active: capabilityObserverStatus(capability),
				capability,
				available_credentials: {},
				latest_failure: null,
				queue: {
					pending: 0,
					sessions: 0,
					auth_backoff_active: false,
					auth_backoff_remaining_s: 0,
				},
			});
		}

		const queueTotals = store.rawEventBacklogTotals();
		const authBackoff = sweeper?.authBackoffStatus() ?? { active: false, remainingS: 0 };
		const latestFailure = store.latestRawEventFlushFailure();
		const active = deps?.getCapabilitySnapshot
			? capabilityObserverStatus(capability)
			: normalizeActiveObserver(observer?.getStatus() ?? null);
		const shouldShowFailure =
			latestFailure != null && (authBackoff.active || queueTotals.pending > 0);

		const failureWithImpact =
			shouldShowFailure && latestFailure
				? { ...latestFailure, impact: buildFailureImpact(latestFailure, queueTotals, authBackoff) }
				: null;

		return c.json({
			active,
			capability,
			available_credentials: {},
			latest_failure: failureWithImpact,
			queue: {
				...queueTotals,
				auth_backoff_active: authBackoff.active,
				auth_backoff_remaining_s: authBackoff.remainingS,
			},
		});
	});

	return app;
}
