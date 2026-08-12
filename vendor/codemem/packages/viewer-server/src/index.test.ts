/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { brotliCompressSync } from "node:zlib";
import * as core from "@codemem/core";
import {
	initTestSchema,
	insertTestSession,
	MemoryStore,
	seedMixedScopeFixture,
	startMaintenanceJob,
	updateMaintenanceJob,
	VERSION,
} from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { __usageCacheTestHooks } from "./routes/stats.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestStore(seedDevice = true): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-store-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	if (seedDevice) {
		rawDb
			.prepare(
				"INSERT OR IGNORE INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
			)
			.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	}
	rawDb.close();
	const store = new MemoryStore(dbPath);
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

function insertTestMemory(
	store: MemoryStore,
	options: {
		sessionId: number;
		kind: string;
		title: string;
		bodyText?: string;
		metadata?: Record<string, unknown>;
		actorId?: string | null;
		originDeviceId?: string | null;
		createdAt?: string;
		active?: boolean;
		scopeId?: string | null;
	},
): number {
	const now = options.createdAt ?? new Date().toISOString();
	const result = store.db
		.prepare(
			`INSERT INTO memory_items (
				session_id, kind, title, subtitle, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, actor_id, actor_display_name, visibility,
				workspace_id, workspace_kind, origin_device_id, origin_source, trust_state,
				facts, narrative, concepts, files_read, files_modified, prompt_number, rev, import_key,
				scope_id
			) VALUES (?, ?, ?, NULL, ?, 0.5, '', ?, ?, ?, ?, ?, ?, 'shared', 'shared:default', 'shared', ?, ?, 'trusted', NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
		)
		.run(
			options.sessionId,
			options.kind,
			options.title,
			options.bodyText ?? options.title,
			options.active === false ? 0 : 1,
			now,
			now,
			JSON.stringify(options.metadata ?? {}),
			options.actorId === undefined ? "local:test-device-001" : options.actorId,
			options.actorId == null || options.actorId === "local:test-device-001"
				? "Test User"
				: options.actorId,
			options.originDeviceId === undefined ? "test-device-001" : options.originDeviceId,
			String(options.metadata?.source ?? "test"),
			`${options.kind}-${options.title}-${now}`,
			options.scopeId ?? null,
		);
	return Number(result.lastInsertRowid);
}

/** Create a test Hono app backed by a fresh in-memory DB. */
function createTestApp(opts?: { seedDevice?: boolean; sweeper?: unknown }) {
	let store: MemoryStore | null = null;
	let storeCleanup: (() => void) | null = null;

	const storeFactory = () => {
		if (!store) {
			const created = createTestStore(opts?.seedDevice);
			store = created.store;
			storeCleanup = created.cleanup;
		}
		return store;
	};

	const app = createApp({
		sweeper: (opts?.sweeper ?? null) as never,
		storeFactory,
	});

	return {
		app,
		ensureStore: () => storeFactory(),
		getStore: () => store,
		cleanup: () => {
			storeCleanup?.();
			store = null;
			storeCleanup = null;
		},
	};
}

function promptPackAttemptId(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

function postViewerJson(app: ReturnType<typeof createApp>, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "http://127.0.0.1:38888",
		},
		body: JSON.stringify(body),
	});
}

function grantSyncScopeToDevices(store: MemoryStore, scopeId: string, deviceIds: string[]): void {
	const now = "2026-01-01T00:00:00Z";
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)
			 ON CONFLICT(scope_id) DO UPDATE SET updated_at = excluded.updated_at`,
		)
		.run(scopeId, scopeId, now, now);
	for (const deviceId of deviceIds) {
		store.db
			.prepare(
				`INSERT INTO scope_memberships(
					scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES (?, ?, 'member', 'active', 1, ?)
				 ON CONFLICT(scope_id, device_id) DO UPDATE SET updated_at = excluded.updated_at`,
			)
			.run(scopeId, deviceId, now);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("viewer-server", () => {
	it("serves viewer shell and app bundle with cache-safe headers", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-static-cache-"));
		const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
		process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
		try {
			writeFileSync(
				join(tmpDir, "index.html"),
				'<!doctype html><script src="/assets/app.js"></script>',
			);
			writeFileSync(join(tmpDir, "app.js"), "globalThis.__codememTestApp = true;");
			const app = createApp({
				storeFactory: () => createTestStore().store,
			});

			const index = await app.request("/");
			expect(index.headers.get("cache-control")).toBe("no-store");

			const bundle = await app.request("/assets/app.js");
			expect(bundle.status).toBe(200);
			expect(bundle.headers.get("cache-control")).toBe("no-cache");
		} finally {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("serves the brotli-precompressed app bundle when the client accepts it", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-static-br-"));
		const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
		process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
		try {
			writeFileSync(
				join(tmpDir, "index.html"),
				'<!doctype html><script src="/assets/app.js"></script>',
			);
			const rawBundle = "globalThis.__codememTestApp = true;";
			writeFileSync(join(tmpDir, "app.js"), rawBundle);
			writeFileSync(join(tmpDir, "app.js.br"), brotliCompressSync(Buffer.from(rawBundle)));
			const app = createApp({
				storeFactory: () => createTestStore().store,
			});

			const compressed = await app.request("/assets/app.js", {
				headers: { "Accept-Encoding": "br" },
			});
			expect(compressed.status).toBe(200);
			expect(compressed.headers.get("content-encoding")).toBe("br");

			// No matching encoding -> raw file, no Content-Encoding header.
			const identity = await app.request("/assets/app.js", {
				headers: { "Accept-Encoding": "identity" },
			});
			expect(identity.status).toBe(200);
			expect(identity.headers.get("content-encoding")).toBeNull();
		} finally {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("createApp fails with a clear build hint when viewer assets are missing", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-static-missing-"));
		const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
		process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
		try {
			expect(() =>
				createApp({
					storeFactory: () => createTestStore().store,
				}),
			).toThrow(/Run `pnpm build` from the repo root before starting the viewer\./);
		} finally {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	describe("GET /api/stats", () => {
		it("returns database stats", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("database");
				expect(typeof body.viewer_pid).toBe("number");
				const db = body.database as Record<string, unknown>;
				expect(db).toHaveProperty("path");
				expect(db).toHaveProperty("sessions");
				expect(db).toHaveProperty("memory_items");
			} finally {
				cleanup();
			}
		});

		it("counts only visible memory scopes in memory stats", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible stats memory",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden stats memory",
					scopeId: "unauthorized-team",
				});

				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { database: Record<string, number> };
				expect(body.database.memory_items).toBe(1);
				expect(body.database.active_memory_items).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("keeps active maintenance jobs in stable started order", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				startMaintenanceJob(store.db, {
					kind: "job-a",
					title: "Job A",
					message: "A",
					progressTotal: 10,
				});
				startMaintenanceJob(store.db, {
					kind: "job-b",
					title: "Job B",
					message: "B",
					progressTotal: 10,
				});
				updateMaintenanceJob(store.db, "job-b", {
					message: "B updated",
					progressCurrent: 5,
				});

				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const jobs = body.maintenance_jobs as Array<Record<string, unknown>>;
				expect(jobs.map((job) => job.kind)).toEqual(["job-a", "job-b"]);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/runtime", () => {
		it("returns viewer runtime version info", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/runtime");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toEqual({ version: VERSION });
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/usage", () => {
		it("returns recent pack rows for the current scope", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("codemem", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Usage-visible memory",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 123, 0, 456, ?, ?)`,
					)
					.run(
						sessionId,
						"2026-03-26T23:30:00Z",
						JSON.stringify({ pack_tokens: 123, exact_duplicates_collapsed: 4 }),
					);

				const res = await app.request("/api/usage?project=codemem");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const recentPacks = body.recent_packs as Array<Record<string, unknown>>;
				expect(recentPacks).toHaveLength(1);
				expect(recentPacks[0]).toMatchObject({
					session_id: sessionId,
					event: "pack",
					tokens_read: 123,
					tokens_saved: 456,
				});
				expect(recentPacks[0]?.metadata_json).toMatchObject({
					exact_duplicates_collapsed: 4,
				});
			} finally {
				cleanup();
			}
		});

		it("removes hidden memory ids from recent pack metadata", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				const visibleId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible pack item",
					scopeId: "authorized-team",
				});
				const hiddenId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden pack item",
					scopeId: "unauthorized-team",
				});
				const inactiveId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Forgotten pack item",
					scopeId: "authorized-team",
					active: false,
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 123, 0, 456, ?, ?)`,
					)
					.run(
						sessionId,
						"2026-03-26T23:30:00Z",
						JSON.stringify({
							pack_item_ids: [visibleId, hiddenId, inactiveId],
							added_ids: [visibleId, hiddenId, inactiveId],
							removed_ids: [hiddenId, inactiveId],
							retained_ids: [String(visibleId), String(hiddenId), String(inactiveId)],
						}),
					);
				const hiddenSessionId = insertTestSession(store.db);
				const hiddenOnlyId = insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden only pack item",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 999, 0, 999, ?, ?)`,
					)
					.run(
						hiddenSessionId,
						"2026-03-27T23:30:00Z",
						JSON.stringify({ pack_item_ids: [hiddenOnlyId], project: "secret-project" }),
					);

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: Array<{ metadata_json: unknown }>;
					totals: { count: number; tokens_read: number; tokens_saved: number };
				};
				// recent_packs stays scope-filtered: only the visible-session pack
				// survives, with hidden ids stripped from its metadata.
				expect(body.recent_packs).toHaveLength(1);
				// Aggregate totals are unfiltered SQL sums over every usage row
				// (both packs), matching store.stats() semantics.
				expect(body.totals).toMatchObject({ count: 2, tokens_read: 1122, tokens_saved: 1455 });
				expect(body.recent_packs[0]?.metadata_json).toMatchObject({
					pack_item_ids: [visibleId],
					added_ids: [visibleId],
					removed_ids: [],
					retained_ids: [visibleId],
				});
			} finally {
				cleanup();
			}
		});

		it("does not expose hidden usage rows that reference visible pack ids", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const visibleSessionId = insertTestSession(store.db);
				const visibleId = insertTestMemory(store, {
					sessionId: visibleSessionId,
					kind: "discovery",
					title: "Visible pack item from another session",
					scopeId: "authorized-team",
				});
				const hiddenSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden session item",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 999, 0, 999, ?, ?)`,
					)
					.run(
						hiddenSessionId,
						"2026-03-29T23:30:00Z",
						JSON.stringify({ pack_item_ids: [visibleId], project: "secret-project" }),
					);

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: unknown[];
					totals: { count: number; tokens_read: number; tokens_saved: number };
				};
				// The hidden-session pack is still excluded from recent_packs
				// (session not visible), but the unfiltered aggregate totals count
				// it just like store.stats() would.
				expect(body.recent_packs).toHaveLength(0);
				expect(body.totals).toMatchObject({ count: 1, tokens_read: 999, tokens_saved: 999 });
			} finally {
				cleanup();
			}
		});

		it("batches usage memory visibility instead of fetching each pack item", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const visibleIds = Array.from({ length: 25 }, (_, idx) =>
					insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: `Visible usage item ${idx}`,
					}),
				);
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 123, 0, 456, ?, ?)`,
					)
					.run(
						sessionId,
						"2026-03-28T23:30:00Z",
						JSON.stringify({ pack_item_ids: visibleIds, added_ids: visibleIds }),
					);
				const getSpy = vi.spyOn(store, "get");

				const res = await app.request("/api/usage");

				expect(res.status).toBe(200);
				expect(getSpy).not.toHaveBeenCalled();
				const body = (await res.json()) as { recent_packs: Array<{ metadata_json: unknown }> };
				expect(body.recent_packs[0]?.metadata_json).toMatchObject({
					pack_item_ids: visibleIds,
					added_ids: visibleIds,
				});
			} finally {
				cleanup();
			}
		});

		it("serves a cached usage payload within the short TTL window", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Cached usage memory",
				});
				const insertPack = (createdAt: string) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, 'pack', 100, 0, 200, ?, '{}')`,
						)
						.run(sessionId, createdAt);

				insertPack("2026-03-26T23:30:00Z");
				const first = (await (await app.request("/api/usage")).json()) as {
					totals: { count: number };
				};
				expect(first.totals.count).toBe(1);

				// A second pack inserted immediately should NOT change the cached
				// response while the TTL window is still open.
				insertPack("2026-03-26T23:31:00Z");
				const second = (await (await app.request("/api/usage")).json()) as {
					totals: { count: number };
				};
				expect(second.totals.count).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("busts the usage cache when scope visibility changes within the TTL", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Scoped usage memory",
					scopeId: "authorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 100, 0, 200, ?, '{}')`,
					)
					.run(sessionId, "2026-03-26T23:30:00Z");

				const beforeRevoke = (await (await app.request("/api/usage")).json()) as {
					recent_packs: unknown[];
				};
				expect(beforeRevoke.recent_packs).toHaveLength(1);

				// Revoke the device's membership. Even within the TTL window the
				// next request must recompute and hide the now-invisible scope
				// instead of serving the cached (visible) payload. recent_packs is
				// the scope-sensitive surface here (aggregate totals are now
				// unfiltered, so they would not reflect a visibility change).
				store.db
					.prepare("DELETE FROM scope_memberships WHERE scope_id = ? AND device_id = ?")
					.run("authorized-team", store.deviceId);

				const afterRevoke = (await (await app.request("/api/usage")).json()) as {
					recent_packs: unknown[];
				};
				expect(afterRevoke.recent_packs).toHaveLength(0);
			} finally {
				cleanup();
			}
		});

		it("evicts expired usage-cache entries on sweep", () => {
			const { cache, sweep } = __usageCacheTestHooks;
			cache.clear();
			try {
				const nowMs = 1_000_000;
				// One already-expired entry and one still-live entry.
				cache.set("expired-key", { payload: {}, expiresAtMs: nowMs - 1 });
				cache.set("live-key", { payload: {}, expiresAtMs: nowMs + 10_000 });
				sweep(cache, nowMs);
				expect(cache.has("expired-key")).toBe(false);
				expect(cache.has("live-key")).toBe(true);
				expect(cache.size).toBe(1);
			} finally {
				cache.clear();
			}
		});

		it("caps the usage cache under a flood of distinct /api/usage requests", async () => {
			const { app, cleanup } = createTestApp();
			const { cache, maxEntries } = __usageCacheTestHooks;
			cache.clear();
			try {
				await app.request("/api/stats");
				// Each distinct ?project= yields a distinct cache key (see
				// usageCacheKey), mirroring the per-request-unique key growth the
				// sweep defends against. Driving the real endpoint guards the
				// handler's use of the sweep, not just the helper in isolation — if
				// the sweep call is ever removed from the handler, this fails.
				for (let i = 0; i < maxEntries + 50; i += 1) {
					await app.request(`/api/usage?project=flood-${i}`);
				}
				expect(cache.size).toBeGreaterThan(1);
				expect(cache.size).toBeLessThanOrEqual(maxEntries);
			} finally {
				cache.clear();
				cleanup();
			}
		});

		it("aggregates token/event totals in SQL with hand-summed global and project values", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const codememSession = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("codemem", codememSession);
				const otherSession = insertTestSession(store.db);
				store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("other", otherSession);

				const insertUsage = (
					sessionId: number,
					event: string,
					read: number,
					written: number,
					saved: number | null,
					createdAt: string,
				) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, ?, ?, ?, ?, ?, '{}')`,
						)
						.run(sessionId, event, read, written, saved, createdAt);

				// codemem project: two packs + one search.
				insertUsage(codememSession, "pack", 100, 10, 5, "2026-03-26T23:30:00Z");
				insertUsage(codememSession, "pack", 200, 20, null, "2026-03-26T23:31:00Z");
				insertUsage(codememSession, "search", 30, 3, 7, "2026-03-26T23:32:00Z");
				// other project: one pack.
				insertUsage(otherSession, "pack", 1000, 100, 50, "2026-03-26T23:33:00Z");

				const res = await app.request("/api/usage?project=codemem");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					events_global: Array<{
						event: string;
						total_tokens_read: number;
						total_tokens_written: number;
						total_tokens_saved: number;
						count: number;
					}>;
					totals_global: {
						tokens_read: number;
						tokens_written: number;
						tokens_saved: number;
						count: number;
					};
					events_filtered: Array<{
						event: string;
						total_tokens_read: number;
						total_tokens_written: number;
						total_tokens_saved: number;
						count: number;
					}> | null;
					totals_filtered: {
						tokens_read: number;
						tokens_written: number;
						tokens_saved: number;
						count: number;
					} | null;
					totals: {
						tokens_read: number;
						tokens_written: number;
						tokens_saved: number;
						count: number;
					};
				};

				// Global aggregate = all four rows, NULL tokens_saved coalesced to 0.
				expect(body.totals_global).toEqual({
					tokens_read: 1330,
					tokens_written: 133,
					tokens_saved: 62,
					count: 4,
				});
				// events_global is sorted by event name ASC (pack before search).
				expect(body.events_global).toEqual([
					{
						event: "pack",
						total_tokens_read: 1300,
						total_tokens_written: 130,
						total_tokens_saved: 55,
						count: 3,
					},
					{
						event: "search",
						total_tokens_read: 30,
						total_tokens_written: 3,
						total_tokens_saved: 7,
						count: 1,
					},
				]);

				// Project-filtered aggregate = only the codemem rows.
				expect(body.totals_filtered).toEqual({
					tokens_read: 330,
					tokens_written: 33,
					tokens_saved: 12,
					count: 3,
				});
				expect(body.events_filtered).toEqual([
					{
						event: "pack",
						total_tokens_read: 300,
						total_tokens_written: 30,
						total_tokens_saved: 5,
						count: 2,
					},
					{
						event: "search",
						total_tokens_read: 30,
						total_tokens_written: 3,
						total_tokens_saved: 7,
						count: 1,
					},
				]);

				// When a project filter is present, `totals` mirrors the filtered values.
				expect(body.totals).toEqual(body.totals_filtered);
			} finally {
				cleanup();
			}
		});

		it("orders recent_packs by created_at DESC and caps the surfaced window", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Recent-pack visible memory",
				});
				const insertPack = (createdAt: string, tokensRead: number) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, 'pack', ?, 0, 0, ?, '{}')`,
						)
						.run(sessionId, tokensRead, createdAt);

				// Insert 15 packs in ascending time order; the route should return
				// the newest first and never surface more than 10.
				for (let i = 0; i < 15; i += 1) {
					const minute = String(i).padStart(2, "0");
					insertPack(`2026-03-26T23:${minute}:00Z`, i);
				}

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: Array<{ created_at: string }>;
				};
				expect(body.recent_packs).toHaveLength(10);
				const timestamps = body.recent_packs.map((row) => row.created_at);
				const sortedDesc = [...timestamps].sort((a, b) => b.localeCompare(a));
				expect(timestamps).toEqual(sortedDesc);
				// Newest seeded pack (minute 14) is first; oldest surfaced is minute 05.
				expect(timestamps[0]).toBe("2026-03-26T23:14:00Z");
				expect(timestamps.at(-1)).toBe("2026-03-26T23:05:00Z");
			} finally {
				cleanup();
			}
		});

		it("does not surface a visible pack older than the bounded recent-pack window", async () => {
			// Documents the deliberate truncation tradeoff: the recent_packs window
			// considers only the newest RECENT_PACK_SCAN_LIMIT (200) pack events, so
			// a visible pack buried under that many newer non-visible packs is not
			// surfaced — while the unfiltered aggregate still counts every event.
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Starvation-test visible memory",
				});
				const insertPack = (sessionRef: number | null, createdAt: string) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, 'pack', 1, 0, 0, ?, '{}')`,
						)
						.run(sessionRef, createdAt);

				// One visible pack at the OLDEST timestamp (session is visible)...
				insertPack(sessionId, "2026-03-26T00:00:00Z");
				// ...buried under 200 NEWER non-visible packs (NULL session => a row
				// with no pack_item_ids and a null session is never visible). The
				// newest-200 window is entirely non-visible, so the lone visible pack
				// sits at position 201 and is never considered.
				for (let i = 0; i < 200; i += 1) {
					const minute = String(Math.floor(i / 60)).padStart(2, "0");
					const second = String(i % 60).padStart(2, "0");
					insertPack(null, `2026-04-01T00:${minute}:${second}Z`);
				}

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: unknown[];
					totals_global: { count: number };
				};
				// recent_packs is starved to empty even though a visible pack exists...
				expect(body.recent_packs).toHaveLength(0);
				// ...while the unfiltered aggregate still counts every pack event (201).
				expect(body.totals_global.count).toBe(201);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/sessions", () => {
		it("returns sessions list", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				// Force store creation
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (store) {
					const sessionId = insertTestSession(store.db);
					insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: "Visible session memory",
					});
				}
				const res = await app.request("/api/sessions");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("items");
				const items = body.items as Record<string, unknown>[];
				expect(items.length).toBeGreaterThanOrEqual(1);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/projects", () => {
		it("returns empty projects for fresh DB", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/projects");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("projects");
			} finally {
				cleanup();
			}
		});

		it("only lists projects backed by visible memory scopes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);

				const visibleSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("visible-project", visibleSessionId);
				insertTestMemory(store, {
					sessionId: visibleSessionId,
					kind: "discovery",
					title: "Visible scoped memory",
					scopeId: "authorized-team",
				});

				const hiddenSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("secret-project", hiddenSessionId);
				insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden scoped memory",
					scopeId: "unauthorized-team",
				});

				const projectsRes = await app.request("/api/projects");
				expect(projectsRes.status).toBe(200);
				const projectsBody = (await projectsRes.json()) as { projects: string[] };
				expect(projectsBody.projects).toEqual(["visible-project"]);

				const sessionsRes = await app.request("/api/sessions");
				expect(sessionsRes.status).toBe(200);
				const sessionsBody = (await sessionsRes.json()) as {
					items: Array<{ id: number; project: string }>;
				};
				expect(sessionsBody.items.map((item) => item.id)).toEqual([visibleSessionId]);
			} finally {
				cleanup();
			}
		});
	});

	describe("memory feed routes", () => {
		it("applies sharing-domain visibility to memory list endpoints", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);

				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible observation",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden observation",
					scopeId: "unauthorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Visible summary",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Hidden summary",
					scopeId: "unauthorized-team",
				});

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = (await observationsRes.json()) as {
					items: Array<{ title: string }>;
				};
				expect(observations.items.map((item) => item.title)).toEqual(["Visible observation"]);

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
				const summaries = (await summariesRes.json()) as { items: Array<{ title: string }> };
				expect(summaries.items.map((item) => item.title)).toEqual(["Visible summary"]);

				const memoryRes = await app.request("/api/memory?limit=10");
				expect(memoryRes.status).toBe(200);
				const memory = (await memoryRes.json()) as { items: Array<{ title: string }> };
				expect(memory.items.map((item) => item.title).sort()).toEqual([
					"Visible observation",
					"Visible summary",
				]);
			} finally {
				cleanup();
			}
		});

		it("keeps mixed-domain unauthorized scope rows out of viewer direct surfaces", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const fixture = seedMixedScopeFixture(store.db, store.deviceId);

				const memoryRes = await app.request("/api/memory?limit=10");
				expect(memoryRes.status).toBe(200);
				const memory = (await memoryRes.json()) as {
					items: Array<{ id: number; title: string }>;
				};
				expect(memory.items.map((item) => item.id)).toEqual(
					expect.arrayContaining(fixture.visibleIds),
				);
				expect(memory.items.map((item) => item.id)).not.toContain(fixture.unauthorizedId);

				const observationsRes = await app.request("/api/observations?limit=10");
				expect(observationsRes.status).toBe(200);
				const observations = (await observationsRes.json()) as {
					items: Array<{ id: number; title: string }>;
				};
				expect(observations.items.map((item) => item.id)).toEqual(
					expect.arrayContaining(fixture.visibleIds),
				);
				expect(observations.items.map((item) => item.title)).not.toContain(
					fixture.unauthorizedTitle,
				);

				const packRes = await app.request(`/api/pack?context=${fixture.query}&limit=10`);
				expect(packRes.status).toBe(200);
				const pack = (await packRes.json()) as { item_ids: number[]; pack_text: string };
				expect(pack.item_ids.some((id) => fixture.visibleIds.includes(id))).toBe(true);
				expect(pack.item_ids).not.toContain(fixture.unauthorizedId);
				expect(pack.pack_text).not.toContain(fixture.unauthorizedTitle);
			} finally {
				cleanup();
			}
		});

		it("applies mine/theirs scope filters to observations", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Mine",
					actorId: "local:test-device-001",
					originDeviceId: "test-device-001",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Theirs",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
				});
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-claimed", store.actorId, 1, "2026-01-01T00:00:00Z");
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Claimed peer mine",
					actorId: "local:peer-claimed",
					originDeviceId: "peer-claimed",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Claimed peer metadata mine",
					actorId: null,
					originDeviceId: null,
					metadata: { origin_device_id: "peer-claimed" },
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Null owned fields",
					actorId: null,
					originDeviceId: null,
					metadata: { source: "observer" },
				});

				const mineRes = await app.request("/api/observations?scope=mine");
				expect(mineRes.status).toBe(200);
				const mineItems = (
					(await mineRes.json()) as { items: Array<{ title: string; owned_by_self?: boolean }> }
				).items;
				expect(mineItems.map((item) => item.title).sort()).toEqual([
					"Claimed peer metadata mine",
					"Claimed peer mine",
					"Mine",
				]);
				expect(mineItems.every((item) => item.owned_by_self === true)).toBe(true);

				const theirsRes = await app.request("/api/observations?scope=theirs");
				expect(theirsRes.status).toBe(200);
				const theirsItems = (
					(await theirsRes.json()) as { items: Array<{ title: string; owned_by_self?: boolean }> }
				).items;
				expect(theirsItems.map((item) => item.title).sort()).toEqual([
					"Null owned fields",
					"Theirs",
				]);
				expect(theirsItems.every((item) => item.owned_by_self === false)).toBe(true);
			} finally {
				cleanup();
			}
		});

		it("moves an owned memory to a new project via /api/memories/project", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Memory on wrong project",
				});

				const res = await app.request("/api/memories/project", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId, project: "new-project" }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					session_id: number;
					project: string;
					moved_memory_count: number;
				};
				expect(body.project).toBe("new-project");
				expect(body.session_id).toBe(sessionId);
				expect(body.moved_memory_count).toBe(1);

				const row = store.db
					.prepare("SELECT project FROM sessions WHERE id = ?")
					.get(sessionId) as { project: string };
				expect(row.project).toBe("new-project");
			} finally {
				cleanup();
			}
		});

		it("rejects /api/memories/project with empty project", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Memory",
				});

				const res = await app.request("/api/memories/project", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId, project: "   " }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error?: string };
				expect(body.error).toContain("project");
			} finally {
				cleanup();
			}
		});

		it("does not mutate memories outside visible sharing domains", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("secret-project", sessionId);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden local-owned memory",
					scopeId: "unauthorized-team",
				});

				for (const [path, body] of [
					["/api/memories/project", { memory_id: memoryId, project: "new-project" }],
					["/api/memories/visibility", { memory_id: memoryId, visibility: "private" }],
					["/api/memories/forget", { memory_id: memoryId }],
				] as const) {
					const res = await app.request(path, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Origin: "http://127.0.0.1:38888",
						},
						body: JSON.stringify(body),
					});
					expect(res.status).toBe(404);
					expect(await res.json()).toEqual({ error: "memory not found" });
				}

				const row = store.db
					.prepare(
						`SELECT memory_items.active, memory_items.visibility, sessions.project
						 FROM memory_items JOIN sessions ON sessions.id = memory_items.session_id
						 WHERE memory_items.id = ?`,
					)
					.get(memoryId) as { active: number; visibility: string; project: string };
				expect(row).toMatchObject({ active: 1, visibility: "shared", project: "secret-project" });
			} finally {
				cleanup();
			}
		});

		it("forgets an owned memory via the viewer API", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Owned memory",
				});

				const forgetRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(forgetRes.status).toBe(200);
				expect(await forgetRes.json()).toEqual({ status: "ok" });

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = (
					(await observationsRes.json()) as { items: Array<{ id?: number; title: string }> }
				).items;
				expect(observations.map((item) => item.title)).not.toContain("Owned memory");

				const row = store.db
					.prepare("SELECT active, deleted_at FROM memory_items WHERE id = ?")
					.get(memoryId) as { active: number; deleted_at: string | null };
				expect(row.active).toBe(0);
				expect(row.deleted_at).toBeTruthy();
			} finally {
				cleanup();
			}
		});

		it("treats repeated forget requests as a no-op success", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Already forgotten",
				});

				const firstRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(firstRes.status).toBe(200);

				const rowAfterFirstForget = store.db
					.prepare("SELECT rev, deleted_at FROM memory_items WHERE id = ?")
					.get(memoryId) as { rev: number; deleted_at: string | null };

				const secondRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(secondRes.status).toBe(200);
				expect(await secondRes.json()).toEqual({ status: "ok" });

				const rowAfterSecondForget = store.db
					.prepare("SELECT rev, deleted_at FROM memory_items WHERE id = ?")
					.get(memoryId) as { rev: number; deleted_at: string | null };
				expect(rowAfterSecondForget.rev).toBe(rowAfterFirstForget.rev);
				expect(rowAfterSecondForget.deleted_at).toBe(rowAfterFirstForget.deleted_at);
			} finally {
				cleanup();
			}
		});

		it("rejects forgetting a memory not owned by this device", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Peer memory",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
				});

				const forgetRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(forgetRes.status).toBe(403);
				const body = (await forgetRes.json()) as { error: string };
				expect(body.error).toBe("memory not owned by this device");
			} finally {
				cleanup();
			}
		});

		it("treats metadata-only local provenance as owned for forget requests", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "decision",
					title: "Metadata-owned memory",
					actorId: null,
					originDeviceId: null,
					metadata: {
						actor_id: "local:test-device-001",
						origin_device_id: "test-device-001",
					},
				});

				const forgetRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(forgetRes.status).toBe(200);
				expect(await forgetRes.json()).toEqual({ status: "ok" });
			} finally {
				cleanup();
			}
		});

		it("validates forget requests", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const invalidIdRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: "abc" }),
				});
				expect(invalidIdRes.status).toBe(400);
				expect(await invalidIdRes.json()).toEqual({ error: "memory_id must be int" });

				const missingRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: 99999 }),
				});
				expect(missingRes.status).toBe(404);
				expect(await missingRes.json()).toEqual({ error: "memory not found" });
			} finally {
				cleanup();
			}
		});

		it("preserves query parameters on the /api/memories alias", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Mine",
					bodyText: "Owned by local actor",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Theirs",
					bodyText: "Owned by remote actor",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
				});

				const aliasRes = await app.request(
					"/api/memories?project=test-project&scope=mine&limit=1&offset=0",
				);
				expect(aliasRes.status).toBe(301);
				expect(aliasRes.headers.get("location")).toBe(
					"/api/observations?project=test-project&scope=mine&limit=1&offset=0",
				);

				const aliasLocation = aliasRes.headers.get("location");
				if (!aliasLocation) throw new Error("expected alias redirect to include Location header");
				const res = await app.request(aliasLocation);
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{ title: string }>;
					pagination: { limit: number; offset: number };
				};
				expect(body.items.map((item) => item.title)).toEqual(["Mine"]);
				expect(body.pagination.limit).toBe(1);
				expect(body.pagination.offset).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("routes observer summaries into summaries and excludes them from observations", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Observer summary memory",
					bodyText: "## Request\nFix feed\n\n## Completed\nShipped route fix",
					metadata: {
						is_summary: true,
						source: "observer_summary",
						request: "Fix feed",
						completed: "Shipped route fix",
					},
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Legacy summary",
					metadata: { request: "Legacy request" },
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Regular change",
					metadata: { source: "observer" },
				});

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
				const summaries = (
					(await summariesRes.json()) as { items: Array<{ title: string; kind: string }> }
				).items;
				expect(summaries).toHaveLength(2);
				expect(summaries.map((item) => item.title).sort()).toEqual([
					"Legacy summary",
					"Observer summary memory",
				]);
				expect(new Set(summaries.map((item) => item.kind))).toEqual(new Set(["session_summary"]));

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = ((await observationsRes.json()) as { items: Array<{ title: string }> })
					.items;
				expect(observations.map((item) => item.title)).toContain("Regular change");
				expect(observations.map((item) => item.title)).not.toContain("Observer summary memory");
				expect(observations.map((item) => item.title)).not.toContain("Legacy summary");
			} finally {
				cleanup();
			}
		});

		it("keeps session observation counts aligned with active feed items", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Active observation",
					bodyText: "Still visible",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Inactive observation",
					bodyText: "Soft deleted",
					active: false,
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Observer summary memory",
					bodyText: "## Request\nCount summary\n\n## Completed\nDone",
					metadata: { is_summary: true, source: "observer_summary" },
				});

				const res = await app.request("/api/session");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { observations: number };
				expect(body.observations).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("excludes hidden sharing domains from session memory counts", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible count memory",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden count memory",
					scopeId: "unauthorized-team",
				});

				const res = await app.request("/api/session");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { memories: number; observations: number };
				expect(body.memories).toBe(1);
				expect(body.observations).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("gates prompt and artifact aggregate counts by visible memory sessions", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);

				const seedProjectSession = (project: string, scopeId: string) => {
					const sessionId = insertTestSession(store.db);
					store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run(project, sessionId);
					insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: `${project} memory`,
						scopeId,
					});
					store.db
						.prepare(
							`INSERT INTO user_prompts(session_id, project, prompt_text, created_at, created_at_epoch, metadata_json)
							 VALUES (?, ?, 'prompt', ?, 0, '{}')`,
						)
						.run(sessionId, project, "2026-01-01T00:00:00Z");
					store.db
						.prepare(
							`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
							 VALUES (?, 'note', ?, 'artifact', 'hash', ?, '{}')`,
						)
						.run(sessionId, `${project}.txt`, "2026-01-01T00:00:00Z");
				};

				seedProjectSession("visible-project", "authorized-team");
				seedProjectSession("secret-project", "unauthorized-team");

				const hiddenRes = await app.request("/api/session?project=secret-project");
				expect(hiddenRes.status).toBe(200);
				expect(await hiddenRes.json()).toMatchObject({
					artifacts: 0,
					memories: 0,
					observations: 0,
					prompts: 0,
					total: 0,
				});

				const visibleRes = await app.request("/api/session?project=visible-project");
				expect(visibleRes.status).toBe(200);
				expect(await visibleRes.json()).toMatchObject({
					artifacts: 1,
					memories: 1,
					observations: 1,
					prompts: 1,
					total: 3,
				});
			} finally {
				cleanup();
			}
		});

		it("tolerates malformed metadata when classifying summaries", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Broken metadata row",
					bodyText: "Should still render as observation",
				});
				store.db
					.prepare("UPDATE memory_items SET metadata_json = ? WHERE title = ?")
					.run("{not-json", "Broken metadata row");

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = ((await observationsRes.json()) as { items: Array<{ title: string }> })
					.items;
				expect(observations.map((item) => item.title)).toContain("Broken metadata row");

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/artifacts", () => {
		it("requires a visible memory in the session before returning local artifacts", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);

				const visibleSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: visibleSessionId,
					kind: "discovery",
					title: "Visible artifact session memory",
					scopeId: "authorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
						 VALUES (?, 'note', 'visible.txt', 'visible artifact', 'visible-hash', ?, '{}')`,
					)
					.run(visibleSessionId, "2026-01-01T00:00:00Z");

				const hiddenSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden artifact session memory",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
						 VALUES (?, 'note', 'hidden.txt', 'hidden artifact', 'hidden-hash', ?, '{}')`,
					)
					.run(hiddenSessionId, "2026-01-01T00:00:00Z");

				const mixedSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: mixedSessionId,
					kind: "discovery",
					title: "Mixed visible artifact memory",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId: mixedSessionId,
					kind: "discovery",
					title: "Mixed hidden artifact memory",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
						 VALUES (?, 'note', 'mixed.txt', 'mixed artifact', 'mixed-hash', ?, '{}')`,
					)
					.run(mixedSessionId, "2026-01-01T00:00:00Z");

				const visibleRes = await app.request(`/api/artifacts?session_id=${visibleSessionId}`);
				expect(visibleRes.status).toBe(200);
				const visibleBody = (await visibleRes.json()) as { items: Array<{ path: string }> };
				expect(visibleBody.items.map((item) => item.path)).toEqual(["visible.txt"]);

				const hiddenRes = await app.request(`/api/artifacts?session_id=${hiddenSessionId}`);
				expect(hiddenRes.status).toBe(404);
				expect(await hiddenRes.json()).toEqual({ error: "session not found" });

				const mixedRes = await app.request(`/api/artifacts?session_id=${mixedSessionId}`);
				expect(mixedRes.status).toBe(404);
				expect(await mixedRes.json()).toEqual({ error: "session not found" });
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/pack", () => {
		it("uses async pack builder path", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const expected = {
					context: "semantic context",
					items: [],
					item_ids: [],
					pack_text: "",
					metrics: {
						total_items: 0,
						pack_tokens: 0,
						fallback_used: true,
						fallback: "recent" as const,
						limit: 10,
						token_budget: null,
						project: null,
						pack_item_ids: [],
						mode: "default" as const,
						added_ids: [],
						removed_ids: [],
						retained_ids: [],
						pack_token_delta: 0,
						pack_delta_available: false,
						work_tokens: 0,
						work_tokens_unique: 0,
						tokens_saved: 0,
						compression_ratio: null,
						overhead_tokens: null,
						avoided_work_tokens: 0,
						avoided_work_saved: 0,
						avoided_work_ratio: null,
						avoided_work_known_items: 0,
						avoided_work_unknown_items: 0,
						avoided_work_sources: {},
						work_source: "estimate" as const,
						work_usage_items: 0,
						work_estimate_items: 0,
						savings_reliable: true,
						sources: { fts: 0, semantic: 0, fuzzy: 0 },
					},
				};

				const asyncSpy = vi.spyOn(store, "buildMemoryPackAsync").mockResolvedValue(expected);
				const syncSpy = vi.spyOn(store, "buildMemoryPack").mockImplementation(() => {
					throw new Error("sync pack builder should not be called");
				});

				const res = await app.request("/api/pack?context=semantic%20context");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toEqual(expected);
				expect(asyncSpy).toHaveBeenCalledTimes(1);
				expect(syncSpy).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/pack", () => {
		it("rejects requests from a different viewer identity target", async () => {
			vi.stubEnv("CODEMEM_DEVICE_ID", "viewer-device");
			vi.stubEnv("CODEMEM_ACTOR_ID", "viewer-actor");
			vi.stubEnv("CODEMEM_CONFIG", "/tmp/viewer-config.json");
			vi.stubEnv("CODEMEM_RUNTIME_ROOT", "/tmp/viewer-runtime");
			vi.stubEnv("CODEMEM_WORKSPACE_ID", "viewer-workspace");
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const viewerIdentityTarget = {
					device_id: "viewer-device",
					actor_id_present: true,
					actor_id: "viewer-actor",
					config_path: "/tmp/viewer-config.json",
					runtime_root: "/tmp/viewer-runtime",
					workspace_id: "viewer-workspace",
					home_dir: resolve(process.env.HOME || homedir()),
					pack_compression: null,
					embedding_disabled: false,
					embedding_model: "Xenova/bge-small-en-v1.5",
				};
				const profile = await app.request("/api/prompt-pack-profile");
				expect(profile.status).toBe(200);
				expect(await profile.json()).toMatchObject({
					service: "codemem-viewer",
					protocol_version: 1,
					db_path: resolve(ensureStore().dbPath),
					identity_target: viewerIdentityTarget,
				});
				const res = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: {
						...viewerIdentityTarget,
						device_id: "request-device",
					},
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({
					error: {
						code: "viewer_identity_mismatch",
						message: "viewer identity does not match request",
					},
				});

				const compressionMismatch = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: { ...viewerIdentityTarget, pack_compression: "ids" },
				});
				expect(compressionMismatch.status).toBe(409);

				const embeddingMismatch = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: { ...viewerIdentityTarget, embedding_disabled: true },
				});
				expect(embeddingMismatch.status).toBe(409);

				const unsupported = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: { ...viewerIdentityTarget, future_field: "new" },
				});
				expect(unsupported.status).toBe(409);
				expect(await unsupported.json()).toMatchObject({
					error: { code: "viewer_contract_unsupported" },
				});
			} finally {
				cleanup();
				vi.unstubAllEnvs();
			}
		});

		it("rejects a viewer whose cached effective identity is stale", async () => {
			const configDir = mkdtempSync(join(tmpdir(), "codemem-viewer-identity-"));
			const configPath = join(configDir, "config.json");
			const envKeys = [
				"CODEMEM_DEVICE_ID",
				"CODEMEM_ACTOR_ID",
				"CODEMEM_CONFIG",
				"CODEMEM_RUNTIME_ROOT",
				"CODEMEM_WORKSPACE_ID",
				"CODEMEM_PACK_COMPRESSION",
				"CODEMEM_EMBEDDING_DISABLED",
				"CODEMEM_EMBEDDING_MODEL",
			] as const;
			const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
			for (const key of envKeys) delete process.env[key];
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ actor_id: "actor-before" }));
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				expect(store.actorId).toBe("actor-before");
				writeFileSync(configPath, JSON.stringify({ actor_id: "actor-after" }));
				const res = await postViewerJson(app, "/api/pack", {
					context: "stale viewer identity",
					db_path: store.dbPath,
					identity_target: {
						device_id: null,
						actor_id_present: false,
						actor_id: null,
						config_path: resolve(configPath),
						runtime_root: null,
						workspace_id: null,
						home_dir: resolve(process.env.HOME || homedir()),
						pack_compression: null,
						embedding_disabled: false,
						embedding_model: "Xenova/bge-small-en-v1.5",
					},
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "viewer_identity_mismatch" },
				});
			} finally {
				cleanup();
				rmSync(configDir, { recursive: true, force: true });
				for (const key of envKeys) {
					const value = previousEnv[key];
					if (value == null) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		it("validates structured request fields", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const invalidJson = await app.request("/api/pack", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: "{",
				});
				expect(invalidJson.status).toBe(400);
				expect(await invalidJson.json()).toEqual({
					error: { code: "invalid_request", message: "invalid json body" },
				});

				const invalidWorkingSet = await postViewerJson(app, "/api/pack", {
					context: "viewer transport",
					working_set_files: ["../private.txt"],
				});
				expect(invalidWorkingSet.status).toBe(400);
				expect(await invalidWorkingSet.json()).toMatchObject({
					error: {
						code: "invalid_request",
						message: "working_set_files contains an invalid repository-relative path",
					},
				});

				const mismatchedDb = await postViewerJson(app, "/api/pack", {
					context: "viewer transport",
					db_path: `${ensureStore().dbPath}.other`,
				});
				expect(mismatchedDb.status).toBe(409);
				expect(await mismatchedDb.json()).toEqual({
					error: {
						code: "viewer_db_mismatch",
						message: "viewer database does not match request",
					},
				});

				const equivalentDb = await postViewerJson(app, "/api/pack", {
					context: "viewer transport",
					db_path: `${dirname(ensureStore().dbPath)}/./${basename(ensureStore().dbPath)}`,
				});
				expect(equivalentDb.status).toBe(200);
			} finally {
				cleanup();
			}
		});

		it("returns the same machine-readable pack as GET for equivalent inputs", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.remember(
					sessionId,
					"decision",
					"Structured pack parity",
					"Viewer POST uses the shared pack builder.",
					0.9,
				);

				const getResponse = await app.request(
					"/api/pack?context=structured%20pack%20parity&limit=5&token_budget=800",
				);
				const postResponse = await postViewerJson(app, "/api/pack", {
					context: "structured pack parity",
					limit: 5,
					token_budget: 800,
					all_projects: true,
				});

				expect(postResponse.status).toBe(200);
				const postBody = (await postResponse.json()) as Record<string, unknown>;
				const getBody = (await getResponse.json()) as Record<string, unknown>;
				expect(postBody).toMatchObject({
					pack_text: getBody.pack_text,
					items: getBody.items,
					item_ids: getBody.item_ids,
				});
			} finally {
				cleanup();
			}
		});

		it("passes project, working-set, and render options to the shared builder", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			const previousProject = process.env.CODEMEM_PROJECT;
			process.env.CODEMEM_PROJECT = "stale-viewer-project";
			try {
				const store = ensureStore();
				const builder = vi.spyOn(store, "buildMemoryPackAsync");
				const response = await postViewerJson(app, "/api/pack", {
					context: "focused viewer pack",
					limit: 4,
					token_budget: 600,
					project: "viewer-project",
					working_set_files: ["./packages/viewer-server/src/index.ts"],
					compact: true,
					compact_detail_count: 2,
				});

				expect(response.status).toBe(200);
				expect(builder).toHaveBeenCalledWith(
					"focused viewer pack",
					4,
					600,
					{
						project: "viewer-project",
						working_set_paths: ["packages/viewer-server/src/index.ts"],
					},
					{ compact: true, compactDetailCount: 2 },
				);
			} finally {
				if (previousProject == null) delete process.env.CODEMEM_PROJECT;
				else process.env.CODEMEM_PROJECT = previousProject;
				cleanup();
			}
		});

		it("records attempts and reports changed-artifact conflicts without blocking pack delivery", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "feature", "Viewer ledger candidate", "first artifact", 0.8);
				const request = {
					context: "viewer ledger candidate",
					all_projects: true,
					working_set_files: ["./packages/viewer-server/src/index.ts"],
					attempt: {
						attempt_id: promptPackAttemptId(1),
						started_at: "2026-08-03T10:00:00.000Z",
						source: "opencode",
						request_id: "viewer-pack-request",
					},
				};

				const first = await postViewerJson(app, "/api/pack", request);
				expect(first.status).toBe(200);
				const firstBody = (await first.json()) as Record<string, unknown>;
				expect(firstBody.ledger_artifact_fingerprint).toMatch(/^[a-f0-9]{64}$/);
				expect(firstBody).not.toHaveProperty("ledger_outcome");
				expect(core.getRetrievalAttempt(store.db, promptPackAttemptId(1))).toMatchObject({
					retrievalStatus: "succeeded",
					workingSetFiles: ["packages/viewer-server/src/index.ts"],
				});

				const retry = await postViewerJson(app, "/api/pack", request);
				expect(retry.status).toBe(200);
				expect(await retry.json()).not.toHaveProperty("ledger_outcome");

				store.remember(
					sessionId,
					"decision",
					"Viewer ledger candidate changed",
					"second artifact",
					0.95,
				);
				const conflict = await postViewerJson(app, "/api/pack", request);
				expect(conflict.status).toBe(200);
				expect(await conflict.json()).toMatchObject({
					ledger_outcome: {
						ok: false,
						errorCode: "retrieval_ledger_write_failed",
						reason: "idempotency_conflict",
					},
				});
			} finally {
				cleanup();
			}
		});

		it("returns a stable structured error when pack construction fails", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				vi.spyOn(ensureStore(), "buildMemoryPackAsync").mockRejectedValue(
					new Error("private storage detail"),
				);
				const response = await postViewerJson(app, "/api/pack", {
					context: "pack failure",
					all_projects: true,
				});
				expect(response.status).toBe(500);
				expect(await response.json()).toEqual({
					error: { code: "pack_failed", message: "memory pack could not be built" },
				});
			} finally {
				cleanup();
			}
		});

		it("delivers a built pack when ledger instrumentation fails", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "feature", "Viewer pack survives", "ledger outage", 0.8);
				const build = store.buildMemoryPackWithTraceAsync.bind(store);
				vi.spyOn(store, "buildMemoryPackWithTraceAsync").mockImplementation(async (...args) => {
					const artifacts = await build(...args);
					store.db.exec("DROP TABLE retrieval_attempts");
					return artifacts;
				});

				const response = await postViewerJson(app, "/api/pack", {
					context: "viewer pack survives",
					all_projects: true,
					attempt: {
						attempt_id: promptPackAttemptId(9),
						started_at: "2026-08-03T10:00:00.000Z",
						source: "opencode",
					},
				});

				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					pack_text: expect.stringContaining("Viewer pack survives"),
				});
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/prompt-pack-ledger", () => {
		it("preserves record, delivery, and cache-reuse idempotency", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const terminal = {
					action: "record",
					attempt_id: promptPackAttemptId(10),
					started_at: "2026-08-03T10:00:00.000Z",
					source: "opencode",
					request_id: "skipped-request",
					retrieval_status: "skipped",
					failure_code: "injection_disabled",
					failure_stage: "policy",
				};
				const record = await postViewerJson(app, "/api/prompt-pack-ledger", terminal);
				expect(record.status).toBe(200);
				expect(await record.json()).toMatchObject({ ok: true, value: { inserted: true } });
				const recordRetry = await postViewerJson(app, "/api/prompt-pack-ledger", terminal);
				expect(await recordRetry.json()).toMatchObject({
					ok: true,
					value: { inserted: false },
				});
				const recordConflict = await postViewerJson(app, "/api/prompt-pack-ledger", {
					...terminal,
					failure_code: "compaction_skipped",
				});
				expect(recordConflict.status).toBe(409);
				expect(await recordConflict.json()).toEqual({
					ok: false,
					errorCode: "retrieval_ledger_write_failed",
					reason: "idempotency_conflict",
				});

				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "decision", "Ledger delivery candidate", "bounded body", 0.9);
				const pack = await postViewerJson(app, "/api/pack", {
					context: "ledger delivery candidate",
					all_projects: true,
					attempt: {
						attempt_id: promptPackAttemptId(11),
						started_at: "2026-08-03T10:00:00.500Z",
						source: "opencode",
						request_id: "delivery-request",
					},
				});
				expect(pack.status).toBe(200);

				const delivery = {
					action: "delivery",
					attempt_id: promptPackAttemptId(11),
					delivery_status: "handed_off",
				};
				const delivered = await postViewerJson(app, "/api/prompt-pack-ledger", delivery);
				expect(await delivered.json()).toMatchObject({ ok: true, value: { changed: true } });
				const deliveryRetry = await postViewerJson(app, "/api/prompt-pack-ledger", delivery);
				expect(await deliveryRetry.json()).toMatchObject({
					ok: true,
					value: { changed: false },
				});

				const cacheReuse = {
					action: "cache_reuse",
					attempt_id: promptPackAttemptId(12),
					started_at: "2026-08-03T10:00:01.000Z",
					source: "opencode",
					request_id: "cache-request",
					original_attempt_id: promptPackAttemptId(11),
				};
				const cloned = await postViewerJson(app, "/api/prompt-pack-ledger", cacheReuse);
				expect(await cloned.json()).toMatchObject({ ok: true, value: { inserted: true } });
				const cloneRetry = await postViewerJson(app, "/api/prompt-pack-ledger", cacheReuse);
				expect(await cloneRetry.json()).toMatchObject({
					ok: true,
					value: { inserted: false },
				});
				expect(core.getRetrievalAttempt(store.db, promptPackAttemptId(12))).toMatchObject({
					deliveryStatus: "not_attempted",
					requestId: `cache_reuse:cache-request:from:${promptPackAttemptId(11)}`,
				});
			} finally {
				cleanup();
			}
		});

		it("returns structured validation and core failure outcomes", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const invalid = await postViewerJson(app, "/api/prompt-pack-ledger", {
					action: "unknown",
					attempt_id: promptPackAttemptId(20),
				});
				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toEqual({
					error: { code: "invalid_request", message: "ledger action is invalid" },
				});

				const missing = await postViewerJson(app, "/api/prompt-pack-ledger", {
					action: "cache_reuse",
					attempt_id: promptPackAttemptId(21),
					original_attempt_id: promptPackAttemptId(22),
				});
				expect(missing.status).toBe(422);
				expect(await missing.json()).toEqual({
					ok: false,
					errorCode: "retrieval_ledger_write_failed",
					reason: "attempt_not_found",
				});

				const mismatchedDb = await postViewerJson(app, "/api/prompt-pack-ledger", {
					action: "record",
					attempt_id: promptPackAttemptId(23),
					retrieval_status: "skipped",
					failure_code: "injection_disabled",
					failure_stage: "policy",
					db_path: `${ensureStore().dbPath}.other`,
				});
				expect(mismatchedDb.status).toBe(409);
				expect(await mismatchedDb.json()).toMatchObject({
					error: { code: "viewer_db_mismatch" },
				});
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/pack/trace", () => {
		it("uses async pack trace builder path", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const expected = {
					version: 1 as const,
					inputs: {
						query: "semantic context",
						project: "test-project",
						working_set_files: ["packages/ui/src/app.ts"],
						token_budget: null,
						limit: 10,
					},
					mode: {
						selected: "task" as const,
						reasons: ["query matched task hints"],
					},
					retrieval: {
						candidate_count: 0,
						candidates: [],
					},
					assembly: {
						deduped_ids: [],
						collapsed_groups: [],
						trimmed_ids: [],
						trim_reasons: [],
						sections: {
							summary: [],
							timeline: [],
							observations: [],
						},
					},
					output: {
						estimated_tokens: 0,
						truncated: false,
						section_counts: {
							summary: 0,
							timeline: 0,
							observations: 0,
						},
						pack_text: "",
					},
				};

				const asyncSpy = vi.spyOn(store, "buildMemoryPackTraceAsync").mockResolvedValue(expected);

				const res = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						context: "semantic context",
						project: "test-project",
						working_set_files: ["packages/ui/src/app.ts"],
					}),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toEqual(expected);
				expect(asyncSpy).toHaveBeenCalledTimes(1);
				expect(asyncSpy).toHaveBeenCalledWith("semantic context", 10, null, {
					project: "test-project",
					working_set_paths: ["packages/ui/src/app.ts"],
				});
			} finally {
				cleanup();
			}
		});

		it("rejects invalid trace payloads", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const invalidJson = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{not-json",
				});
				expect(invalidJson.status).toBe(400);
				expect(await invalidJson.json()).toEqual({ error: "invalid json body" });

				const missingContext = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ project: "test-project" }),
				});
				expect(missingContext.status).toBe(400);
				expect(await missingContext.json()).toEqual({ error: "context required" });

				const nonStringContext = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context: { bad: true } }),
				});
				expect(nonStringContext.status).toBe(400);
				expect(await nonStringContext.json()).toEqual({ error: "context required" });

				const badLimit = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context: "semantic context", limit: 3.5 }),
				});
				expect(badLimit.status).toBe(400);
				expect(await badLimit.json()).toEqual({ error: "limit must be a positive int" });

				const badBudget = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context: "semantic context", token_budget: 2.5 }),
				});
				expect(badBudget.status).toBe(400);
				expect(await badBudget.json()).toEqual({ error: "token_budget must be int" });

				const badWorkingSet = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						context: "semantic context",
						working_set_files: "packages/ui/src/app.ts",
					}),
				});
				expect(badWorkingSet.status).toBe(400);
				expect(await badWorkingSet.json()).toEqual({
					error: "working_set_files must be an array of strings",
				});

				const mixedWorkingSet = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						context: "semantic context",
						working_set_files: ["packages/ui/src/app.ts", 123],
					}),
				});
				expect(mixedWorkingSet.status).toBe(400);
				expect(await mixedWorkingSet.json()).toEqual({
					error: "working_set_files must be an array of strings",
				});
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/observer-status", () => {
		it("returns live observer status and suppresses stale failures after success", async () => {
			const { store, cleanup } = createTestStore();
			try {
				(
					store as MemoryStore & {
						rawEventBacklogTotals: () => { pending: number; sessions: number };
						latestRawEventFlushFailure: () => Record<string, unknown> | null;
					}
				).rawEventBacklogTotals = () => ({ pending: 0, sessions: 0 });
				(
					store as MemoryStore & {
						latestRawEventFlushFailure: () => Record<string, unknown> | null;
					}
				).latestRawEventFlushFailure = () => ({
					observer_provider: "openai",
					observer_model: "gpt-4.1-mini",
					error_message: "OpenAI returned no usable output for raw-event processing.",
					updated_at: "2026-03-20T10:57:37Z",
				});
				const activeStatus = {
					provider: "opencode",
					model: "gpt-5.4-mini",
					runtime: "api_http",
					auth: { type: "sdk_client", hasToken: true, source: "cache" },
					lastError: null,
				};
				const appWithObserver = createApp({
					storeFactory: () => store,
					sweeper: { authBackoffStatus: () => ({ active: false, remainingS: 0 }) } as never,
					observer: { getStatus: () => activeStatus } as never,
				});
				const res = await appWithObserver.request("/api/observer-status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.active).toEqual({
					...activeStatus,
					auth: {
						...activeStatus.auth,
						method: "sdk_client",
						token_present: true,
					},
				});
				expect(body.available_credentials).toHaveProperty("opencode");
				expect(
					(body.available_credentials as Record<string, { env_var: boolean }>).opencode.env_var,
				).toBe(false);
				expect(body).toHaveProperty("queue");
				expect(body.latest_failure).toBeNull();
			} finally {
				cleanup();
			}
		});
	});

	describe("/api/config", () => {
		it("GET resolves the same workspace-scoped file as the core resolver POST uses", async () => {
			// Workspace-scoped override via CODEMEM_RUNTIME_ROOT is honored only by
			// the core resolver (getCodememConfigPath / readCodememConfigFile). The
			// legacy local getConfigPath() ignored it, so GET and POST could resolve
			// different files. GET must now match the core resolver exactly.
			const runtimeRoot = mkdtempSync(join(tmpdir(), "codemem-runtime-root-"));
			const scopedConfigPath = join(runtimeRoot, "config", "codemem.json");
			mkdirSync(join(runtimeRoot, "config"), { recursive: true });
			writeFileSync(scopedConfigPath, JSON.stringify({ observer_model: "scoped-model" }));
			const prevRuntimeRoot = process.env.CODEMEM_RUNTIME_ROOT;
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_RUNTIME_ROOT = runtimeRoot;
			delete process.env.CODEMEM_CONFIG;
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				// GET resolves to the workspace-scoped file the core resolver chooses,
				// which is the same path POST writes to.
				expect(body.path).toBe(core.getCodememConfigPath());
				expect(body.path).toBe(scopedConfigPath);
				expect((body.config as Record<string, unknown>).observer_model).toBe("scoped-model");
			} finally {
				cleanup();
				rmSync(runtimeRoot, { recursive: true, force: true });
				if (prevRuntimeRoot == null) delete process.env.CODEMEM_RUNTIME_ROOT;
				else process.env.CODEMEM_RUNTIME_ROOT = prevRuntimeRoot;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("returns provider options from real opencode config prefixes", async () => {
			const tmpHome = mkdtempSync(join(tmpdir(), "codemem-home-test-"));
			const opencodeConfigDir = join(tmpHome, ".config", "opencode");
			const prevHome = process.env.HOME;
			const prevConfig = process.env.CODEMEM_CONFIG;
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			process.env.HOME = tmpHome;
			process.env.CODEMEM_CONFIG = configPath;
			mkdirSync(opencodeConfigDir, { recursive: true });
			writeFileSync(
				join(opencodeConfigDir, "opencode.jsonc"),
				JSON.stringify({ model: "openai/gpt-5.4", small_model: "opencode/gpt-5-nano" }),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.providers).toEqual(["anthropic", "openai", "opencode"]);
			} finally {
				cleanup();
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("redacts sensitive config values from config responses", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					observer_auth_file: "~/.codemem/token.txt",
					observer_auth_timeout_ms: 1500,
					observer_headers: { Authorization: "Bearer abc" },
					sync_enabled: true,
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const config = body.config as Record<string, unknown>;
				const effective = body.effective as Record<string, unknown>;
				expect(config.observer_auth_file).toBe("[redacted]");
				expect(config.observer_headers).toBe("[redacted]");
				expect(config).not.toHaveProperty("observer_auth_timeout_ms");
				expect(effective).not.toHaveProperty("observer_auth_timeout_ms");
				expect(config).not.toHaveProperty("sync_enabled");
				expect(effective).not.toHaveProperty("sync_coordinator_admin_secret");
				expect(effective).not.toHaveProperty("sync_enabled");
				expect(body.protected_keys).toEqual(
					expect.arrayContaining([
						"claude_command",
						"codex_command",
						"observer_auth_file",
						"observer_headers",
						"observer_base_url",
					]),
				);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("writes config and returns effects", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const notifyConfigChanged = vi.fn();
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			const { app, cleanup } = createTestApp({ sweeper: { notifyConfigChanged } });
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({
						config: { observer_model: "gpt-4.1-mini", raw_events_sweeper_interval_s: 12 },
					}),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.config as Record<string, unknown>).observer_model).toBe("gpt-4.1-mini");
				expect((body.effects as Record<string, unknown>).hot_reloaded_keys).toEqual([
					"raw_events_sweeper_interval_s",
				]);
				expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
				expect(readFileSync(configPath, "utf8")).toContain('"observer_model": "gpt-4.1-mini"');
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("returns tiered observer routing fields from config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					observer_tier_routing_enabled: true,
					observer_simple_model: "gpt-5.4-mini",
					observer_rich_model: "gpt-5.4",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const config = body.config as Record<string, unknown>;
				const effective = body.effective as Record<string, unknown>;
				expect(config.observer_tier_routing_enabled).toBe(true);
				expect(config.observer_simple_model).toBe("gpt-5.4-mini");
				expect(config.observer_rich_model).toBe("gpt-5.4");
				expect(config).not.toHaveProperty("observer_rich_openai_use_responses");
				expect(effective.observer_tier_routing_enabled).toBe(true);
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("accepts the Codex sidecar runtime and exposes its protected command", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_runtime: "codex_sidecar" } }),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.config as Record<string, unknown>).observer_runtime).toBe("codex_sidecar");
				expect((body.effective as Record<string, unknown>).codex_command).toEqual(["codex"]);
				expect(body.protected_keys).toEqual(expect.arrayContaining(["codex_command"]));
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("reports CODEMEM_CODEX_COMMAND as normalized env-managed config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousCommand = process.env.CODEMEM_CODEX_COMMAND;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_CODEX_COMMAND =
				'["/Applications/ChatGPT.app/Contents/Resources/codex","--profile","observer"]';
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.effective as Record<string, unknown>).codex_command).toEqual([
					"/Applications/ChatGPT.app/Contents/Resources/codex",
					"--profile",
					"observer",
				]);
				expect(body.env_overrides).toEqual(
					expect.objectContaining({ codex_command: "CODEMEM_CODEX_COMMAND" }),
				);
			} finally {
				cleanup();
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousCommand == null) delete process.env.CODEMEM_CODEX_COMMAND;
				else process.env.CODEMEM_CODEX_COMMAND = previousCommand;
			}
		});

		it("normalizes a string-form Codex command from the config file", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousCommand = process.env.CODEMEM_CODEX_COMMAND;
			process.env.CODEMEM_CONFIG = configPath;
			delete process.env.CODEMEM_CODEX_COMMAND;
			writeFileSync(configPath, JSON.stringify({ codex_command: "codex --profile observer" }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.effective as Record<string, unknown>).codex_command).toEqual([
					"codex",
					"--profile",
					"observer",
				]);
			} finally {
				cleanup();
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousCommand == null) delete process.env.CODEMEM_CODEX_COMMAND;
				else process.env.CODEMEM_CODEX_COMMAND = previousCommand;
			}
		});

		it("does not report normalized command arrays as changed on unrelated saves", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousClaudeCommand = process.env.CODEMEM_CLAUDE_COMMAND;
			const previousCodexCommand = process.env.CODEMEM_CODEX_COMMAND;
			process.env.CODEMEM_CONFIG = configPath;
			delete process.env.CODEMEM_CLAUDE_COMMAND;
			delete process.env.CODEMEM_CODEX_COMMAND;
			writeFileSync(
				configPath,
				JSON.stringify({
					codex_command: "codex --profile observer",
					observer_model: "gpt-5.4-mini",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_model: "gpt-5.4" } }),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const effects = body.effects as Record<string, unknown>;
				expect(effects.effective_keys).toEqual(["observer_model"]);
				expect(effects.restart_required_keys).toEqual(["observer_model"]);
			} finally {
				cleanup();
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousClaudeCommand == null) delete process.env.CODEMEM_CLAUDE_COMMAND;
				else process.env.CODEMEM_CLAUDE_COMMAND = previousClaudeCommand;
				if (previousCodexCommand == null) delete process.env.CODEMEM_CODEX_COMMAND;
				else process.env.CODEMEM_CODEX_COMMAND = previousCodexCommand;
			}
		});

		it("writes tiered observer routing config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ observer_rich_openai_use_responses: true }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({
						config: {
							observer_tier_routing_enabled: true,
							observer_simple_model: "gpt-5.4-mini",
							observer_simple_temperature: 0.2,
							observer_reasoning_effort: "medium",
							observer_reasoning_summary: "auto",
							observer_rich_model: "gpt-5.4",
							observer_rich_temperature: 0.1,
							observer_rich_reasoning_effort: "medium",
							observer_rich_reasoning_summary: "auto",
							observer_rich_max_output_tokens: 12000,
						},
					}),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const config = body.config as Record<string, unknown>;
				expect(config.observer_tier_routing_enabled).toBe(true);
				expect(config).not.toHaveProperty("observer_rich_openai_use_responses");
				const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
				expect(saved).not.toHaveProperty("observer_rich_openai_use_responses");
				expect(saved.observer_simple_temperature).toBe(0.2);
				expect(saved.observer_reasoning_effort).toBe("medium");
				expect(saved.observer_reasoning_summary).toBe("auto");
				expect(saved.observer_rich_temperature).toBe(0.1);
				expect(saved.observer_rich_max_output_tokens).toBe(12000);
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("accepts built-in observer providers on a clean config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevHome = process.env.HOME;
			const tmpHome = mkdtempSync(join(tmpdir(), "codemem-home-test-"));
			process.env.CODEMEM_CONFIG = configPath;
			process.env.HOME = tmpHome;
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_provider: "anthropic" } }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.config as Record<string, unknown>).observer_provider).toBe("anthropic");
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
			}
		});

		it("clears hot-reload env override when interval key is removed", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevInterval = process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS = "12000";
			const notifyConfigChanged = vi.fn();
			const { app, cleanup } = createTestApp({ sweeper: { notifyConfigChanged } });
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { raw_events_sweeper_interval_s: null } }),
				});
				expect(res.status).toBe(200);
				expect(process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS).toBeUndefined();
				expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevInterval == null) delete process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS;
				else process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS = prevInterval;
			}
		});

		it("returns warnings for env-overridden keys", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevModel = process.env.CODEMEM_OBSERVER_MODEL;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_OBSERVER_MODEL = "env-model";
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_model: "saved-model" } }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.effective as Record<string, unknown>).observer_model).toBe("env-model");
				expect((body.effects as Record<string, unknown>).ignored_by_env_keys).toEqual([
					"observer_model",
				]);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevModel == null) delete process.env.CODEMEM_OBSERVER_MODEL;
				else process.env.CODEMEM_OBSERVER_MODEL = prevModel;
			}
		});

		it("validates payload types", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_tier_routing_enabled: "yes" } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("observer_tier_routing_enabled must be boolean");
			} finally {
				cleanup();
			}
		});

		it("rejects invalid tiered observer routing values", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_simple_temperature: "hot" } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("observer_simple_temperature must be non-negative number");
			} finally {
				cleanup();
			}
		});

		it("rejects protected config mutations from the viewer API", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_auth_file: "/tmp/token" } }),
				});
				expect(res.status).toBe(403);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe(
					"observer_auth_file cannot be changed from the viewer API; edit the config file or environment instead",
				);
			} finally {
				cleanup();
			}
		});

		it("ignores unchanged protected keys and removes retired sync settings", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					observer_model: "old-model",
					observer_auth_file: "/tmp/token",
					observer_auth_command: ["retired-token-command"],
					observer_auth_timeout_ms: 1500,
					sync_coordinator_url: "https://coord.example.test",
					sync_enabled: true,
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({
						config: {
							observer_model: "new-model",
							observer_auth_file: "[redacted]",
							sync_coordinator_url: "https://coord.example.test",
						},
					}),
				});
				expect(res.status).toBe(200);
				const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
				expect(saved.observer_model).toBe("new-model");
				expect(saved.observer_auth_file).toBe("/tmp/token");
				expect(saved).not.toHaveProperty("observer_auth_command");
				expect(saved).not.toHaveProperty("observer_auth_timeout_ms");
				expect(saved).not.toHaveProperty("sync_coordinator_url");
				expect(saved).not.toHaveProperty("sync_enabled");
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("rejects non-object config wrapper payloads", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: "bad" }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("config must be an object");
			} finally {
				cleanup();
			}
		});

		it("parses integer fields strictly", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_max_chars: "123abc" } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("observer_max_chars must be int");
			} finally {
				cleanup();
			}
		});
	});

	describe("CORS middleware", () => {
		it("allows POST without Origin header (CLI/programmatic callers)", async () => {
			// Matches Python's reject_if_unsafe policy — no Origin + no suspicious
			// browser signals = CLI caller, allowed through.
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				// Should NOT be 403 — CLI callers don't send Origin
				expect(res.status).not.toBe(403);
			} finally {
				cleanup();
			}
		});

		it("rejects POST without Origin but with cross-site Sec-Fetch-Site", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Sec-Fetch-Site": "cross-site",
					},
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				expect(res.status).toBe(403);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("forbidden");
			} finally {
				cleanup();
			}
		});

		it("rejects POST with non-loopback Origin", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				expect(res.status).toBe(403);
			} finally {
				cleanup();
			}
		});

		it("allows POST with loopback Origin", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: 999, visibility: "shared" }),
				});
				// Should get past CORS (404 or 400 expected, not 403)
				expect(res.status).not.toBe(403);
			} finally {
				cleanup();
			}
		});

		it("allows GET without Origin header", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
			} finally {
				cleanup();
			}
		});

		it("returns 400 for invalid JSON on visibility updates", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: "{bad json",
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("invalid JSON");
			} finally {
				cleanup();
			}
		});
	});

	describe("viewer HTML", () => {
		it("returns HTML at root with viewer page", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/");
				expect(res.status).toBe(200);
				const html = await res.text();
				expect(html).toContain("<title>codemem viewer</title>");
				expect(html).toContain("<!doctype html>");
			} finally {
				cleanup();
			}
		});
	});
});
