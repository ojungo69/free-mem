import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readViewerBearerToken, startDaemon } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type ViewerRpcCall } from "./index.js";
import { createViewerRpcCall } from "./rpc-client.js";

const roots: string[] = [];

function mountedApp(rpc: ViewerRpcCall) {
	const staticDir = mkdtempSync(join(tmpdir(), "codemem-viewer-auth-http-"));
	roots.push(staticDir);
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>viewer</title>");
	const previous = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;
	try {
		return createApp({ rpc });
	} finally {
		if (previous === undefined) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
		else process.env.CODEMEM_VIEWER_STATIC_DIR = previous;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("viewer HTTP security boundary", () => {
	it("P1-T043-01-browser-auth-401 rejects missing and incorrect credentials", async () => {
		const rpc = vi.fn<ViewerRpcCall>(async (method) => {
			if (method === "GET /v1/health") return { status: "ok" };
			if (method === "POST /v1/viewer/auth/verify") return { authenticated: false };
			throw new Error(`unexpected ${method}`);
		});
		const app = mountedApp(rpc);

		expect((await app.request("/api/runtime")).status).toBe(401);
		expect((await app.request("/api/health")).status).toBe(200);
		expect(
			(
				await app.request("/api/runtime", {
					headers: { Authorization: `Bearer ${"i".repeat(43)}` },
				})
			).status,
		).toBe(401);
	});

	it("P1-T043-02-origin-403 rejects a malicious Origin before credential exchange", async () => {
		const rpc = vi.fn<ViewerRpcCall>();
		const app = mountedApp(rpc);
		const response = await app.request("/api/runtime", {
			headers: { Authorization: `Bearer ${"v".repeat(43)}`, Origin: "https://attacker.example" },
		});
		expect(response.status).toBe(403);
		expect(rpc).not.toHaveBeenCalled();
		const otherLoopbackPort = await app.request("http://127.0.0.1:3737/api/runtime", {
			headers: {
				Authorization: `Bearer ${"v".repeat(43)}`,
				Origin: "http://127.0.0.1:9999",
			},
		});
		expect(otherLoopbackPort.status).toBe(403);
		const missingOrigin = await app.request("http://127.0.0.1:3737/api/auth/logout", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${"v".repeat(43)}`,
				"Sec-Fetch-Site": "cross-site",
			},
		});
		expect(missingOrigin.status).toBe(403);
		expect(rpc).not.toHaveBeenCalled();
	});

	it("P1-T043-11-loopback-cookie-csp retires cookie auth for loopback sessions", async () => {
		const nonce = "n".repeat(43);
		const rpc = vi.fn<ViewerRpcCall>(async (method, body) => {
			if (method === "POST /v1/viewer/auth/exchange" && body?.nonce === nonce) {
				return { session: { cookie: "signed-session", expiresAt: Date.now() + 10_000 } };
			}
			if (method === "POST /v1/viewer/auth/verify" && body?.session === "signed-session") {
				return { authenticated: true };
			}
			if (method === "POST /v1/viewer/auth/logout" && body?.session === "signed-session") {
				return { loggedOut: true };
			}
			if (method === "GET /v1/view") {
				return { status: 200, body: { version: "test" } };
			}
			throw new Error(`unexpected ${method}`);
		});
		const app = mountedApp(rpc);
		let pulls = 0;
		const oversizedBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(600));
				if (pulls === 8) controller.close();
			},
		});
		const oversized = await app.request(
			new Request("http://127.0.0.1:3737/api/auth/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3737" },
				body: oversizedBody,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		);
		expect(oversized.status).toBe(413);
		expect(pulls).toBeLessThan(8);
		expect(rpc).not.toHaveBeenCalled();
		for (const origin of ["http://127.0.0.2:3737", "http://[::1]:3737"]) {
			const response = await app.request(`${origin}/api/auth/exchange`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: origin },
				body: JSON.stringify({ nonce }),
			});

			expect(response.status).toBe(200);
			expect(response.headers.get("set-cookie")).toBeNull();
			expect(await response.json()).toEqual({ session: "signed-session" });
			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
			expect(response.headers.get("content-security-policy")).not.toContain("unpkg.com");
		}

		const sessionAuth = await app.request("http://127.0.0.1:3737/api/runtime", {
			headers: { Authorization: "Session signed-session" },
		});
		expect(sessionAuth.status).toBe(200);

		const cookieOnly = await app.request("http://127.0.0.1:3737/api/runtime", {
			headers: { Cookie: "codemem_session=signed-session" },
		});
		expect(cookieOnly.status).toBe(401);

		const logout = await app.request("http://127.0.0.1:3737/api/auth/logout", {
			method: "POST",
			headers: {
				Authorization: "Session signed-session",
				Origin: "http://127.0.0.1:3737",
			},
		});
		expect(logout.status).toBe(204);
		expect(rpc).toHaveBeenCalledWith("POST /v1/viewer/auth/logout", {
			session: "signed-session",
		});
	});

	it("P1-T043-08-viewer-daemon-unavailable returns typed 503 without the daemon", async () => {
		const rpc = vi.fn<ViewerRpcCall>(async (method) => {
			if (method === "POST /v1/viewer/auth/verify") return { authenticated: true };
			if (method === "GET /v1/view") {
				return { status: 200, body: { version: "test" } };
			}
			throw new Error(`unexpected ${method}`);
		});
		const app = mountedApp(rpc);
		const ok = await app.request("/api/runtime", {
			headers: { Authorization: `Bearer ${"v".repeat(43)}` },
		});
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control")).toBe("no-store");
		expect(await ok.json()).toEqual({ version: "test" });

		const unavailable = mountedApp(async () => {
			throw new Error("daemon unavailable");
		});
		const response = await unavailable.request("/api/runtime", {
			headers: { Authorization: `Bearer ${"v".repeat(43)}` },
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: { code: "daemon_unavailable", message: "Daemon is not running." },
		});
	});

	it("P1-T043-07-viewer-read-only exposes no legacy mutation routes", async () => {
		const rpc = vi.fn<ViewerRpcCall>(async (method) => {
			if (method === "POST /v1/viewer/auth/verify") return { authenticated: true };
			throw new Error(`unexpected ${method}`);
		});
		const app = mountedApp(rpc);
		for (const path of [
			"/api/config",
			"/api/memories/project",
			"/api/memories/forget",
			"/api/memories/visibility",
			"/api/raw-events",
			"/api/claude-hooks",
			"/api/codex-hooks",
			"/api/prompt-pack-ledger",
			"/api/pack",
		]) {
			const response = await app.request(`http://127.0.0.1:3737${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${"v".repeat(43)}`,
					"Content-Type": "application/json",
					Origin: "http://127.0.0.1:3737",
				},
				body: "{}",
			});
			expect(response.status, path).toBe(404);
		}
		const invalidTrace = await app.request("http://127.0.0.1:3737/api/pack/trace", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${"v".repeat(43)}`,
				"Content-Type": "application/json",
				Origin: "http://127.0.0.1:3737",
			},
			body: JSON.stringify({ context: "test", working_set_files: "not-an-array" }),
		});
		expect(invalidTrace.status).toBe(400);
	});

	it("P1-T043-13-daemon-restart-session invalidates an HTTP session on restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "codemem-viewer-auth-e2e-"));
		roots.push(root);
		const dataDir = join(root, "data");
		let daemon = await startDaemon({ dataDir });
		const rpc = createViewerRpcCall({ socketPath: daemon.socketPath });
		const app = mountedApp(rpc);
		try {
			const bearer = readViewerBearerToken(daemon.layout.controlDir);
			expect(bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(
				(
					await app.request("/api/runtime", {
						headers: { Authorization: `Bearer ${bearer}` },
					})
				).status,
			).toBe(200);

			const issued = await rpc("POST /v1/viewer/auth/nonce");
			const exchange = await app.request("http://127.0.0.1:3737/api/auth/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3737" },
				body: JSON.stringify({ nonce: issued.nonce }),
			});
			const session = ((await exchange.json()) as { session?: unknown }).session;
			expect(session).toMatch(/^v1\./);
			expect(exchange.headers.get("set-cookie")).toBeNull();
			expect(
				(
					await app.request("/api/runtime", {
						headers: { Authorization: `Session ${String(session)}` },
					})
				).status,
			).toBe(200);

			await daemon.stop();
			daemon = await startDaemon({ dataDir });
			expect(
				(
					await app.request("/api/runtime", {
						headers: { Authorization: `Session ${String(session)}` },
					})
				).status,
			).toBe(401);
		} finally {
			await daemon.stop();
		}
	});
});
