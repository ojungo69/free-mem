/**
 * @codemem/server — HTTP server (viewer API + SPA host).
 *
 * Entry: `codemem serve`
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObserverClient } from "@codemem/core";
import { MemoryStore, type RawEventSweeper, resolveDbPath, VERSION } from "@codemem/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { originGuard, preflightHandler } from "./middleware.js";
import { configRoutes } from "./routes/config.js";
import { healthRoutes } from "./routes/health.js";
import { memoryRoutes } from "./routes/memory.js";
import { observerStatusRoutes } from "./routes/observer-status.js";
import { packTransportRoutes } from "./routes/pack.js";
import { rawEventsRoutes } from "./routes/raw-events.js";
import { statsRoutes } from "./routes/stats.js";

export { VERSION };

/** Shared store instance — SQLite WAL mode handles concurrent reads safely. */
let sharedStore: MemoryStore | null = null;

/** Get (or create) the shared store instance. Exported so the sweeper can share it. */
export function getStore(): MemoryStore {
	if (!sharedStore) {
		sharedStore = new MemoryStore(resolveDbPath());
	}
	return sharedStore;
}

/** Close the shared store (called on shutdown). */
export function closeStore(): void {
	sharedStore?.close();
	sharedStore = null;
}

/**
 * Create the Hono app with all viewer routes.
 * Exported for testing — pass a custom store factory to inject test DBs.
 */
export interface AppOptions {
	storeFactory?: () => MemoryStore;
	sweeper?: RawEventSweeper | null;
	observer?: ObserverClient | null;
}

export function createApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const sweeper = opts?.sweeper ?? null;
	const observer = opts?.observer ?? null;
	const app = new Hono();

	// CORS / origin guard
	app.use("*", preflightHandler());
	app.use("*", originGuard());

	// API routes
	app.route("/", healthRoutes(storeFactory));
	app.route("/", statsRoutes(storeFactory));
	app.route("/", memoryRoutes(storeFactory));
	app.route("/", packTransportRoutes(storeFactory));
	app.route(
		"/",
		observerStatusRoutes({
			getStore: storeFactory,
			getSweeper: () => sweeper,
			getObserver: () => observer,
		}),
	);
	app.route("/", configRoutes({ getSweeper: () => sweeper }));
	app.route("/", rawEventsRoutes(storeFactory, sweeper));

	// Static assets — serve under /assets/*
	// Resolves to packages/viewer-server/static/ both in dev and when installed from npm.
	const staticRoot =
		process.env.CODEMEM_VIEWER_STATIC_DIR ?? join(import.meta.dirname ?? ".", "../static");

	app.use("/assets/*", async (c, next) => {
		c.header("Cache-Control", "no-cache");
		await next();
	});

	app.use(
		"/assets/*",
		serveStatic({
			root: staticRoot,
			rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
			precompressed: true,
		}),
	);

	// SPA — serve index.html for root and all client-side routes
	const indexPath = join(staticRoot, "index.html");
	if (!existsSync(indexPath)) {
		throw new Error(
			`Viewer assets missing at ${indexPath}. Run \`pnpm build\` from the repo root before starting the viewer.`,
		);
	}
	const indexHtml = readFileSync(indexPath, "utf-8");
	app.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "not found" }, 404);
		}
		c.header("Cache-Control", "no-store");
		return c.html(indexHtml);
	});

	return app;
}

// No auto-start — the CLI's `serve` command owns server startup.
