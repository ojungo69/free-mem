import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	VIEWER_NONCE_TTL_MS,
	VIEWER_SESSION_LIMIT,
	VIEWER_SESSION_TTL_MS,
	ViewerAuthState,
} from "./viewer-auth.js";

const roots: string[] = [];

function tempControlDir(): string {
	const root = mkdtempSync(join(tmpdir(), "codemem-viewer-auth-"));
	roots.push(root);
	return join(root, "control");
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("viewer auth", () => {
	it("P1-T043-09-bearer-file persists a 256-bit owner-only bearer token", () => {
		const controlDir = tempControlDir();
		const first = new ViewerAuthState({ controlDir, instanceId: "daemon-a" });
		const tokenPath = join(controlDir, "token");
		const token = readFileSync(tokenPath, "utf8").trim();

		expect(Buffer.from(token, "base64url")).toHaveLength(32);
		expect(lstatSync(tokenPath).mode & 0o777).toBe(0o600);
		expect(first.verifyBearer(token)).toBe(true);
		expect(first.verifyBearer(`${token.slice(0, -1)}x`)).toBe(false);

		const restarted = new ViewerAuthState({ controlDir, instanceId: "daemon-b" });
		expect(readFileSync(tokenPath, "utf8").trim()).toBe(token);
		expect(restarted.verifyBearer(token)).toBe(true);
	});

	it("P1-T043-03-nonce-single-use-race rejects expired or concurrent nonce reuse", async () => {
		let now = 1_000;
		const auth = new ViewerAuthState({
			controlDir: tempControlDir(),
			instanceId: "daemon-a",
			now: () => now,
		});
		const expired = auth.issueNonce();
		now += VIEWER_NONCE_TTL_MS + 1;
		expect(auth.exchangeNonce(expired.nonce)).toBeNull();

		const current = auth.issueNonce();
		const exchanged = await Promise.all([
			Promise.resolve().then(() => auth.exchangeNonce(current.nonce)),
			Promise.resolve().then(() => auth.exchangeNonce(current.nonce)),
		]);
		expect(exchanged.filter(Boolean)).toHaveLength(1);
		expect(auth.exchangeNonce(current.nonce)).toBeNull();
	});

	it("P1-T043-04-session-expiry-restart expires, restarts, and logs out sessions", () => {
		let now = 10_000;
		const controlDir = tempControlDir();
		const auth = new ViewerAuthState({
			controlDir,
			instanceId: "daemon-a",
			now: () => now,
		});
		const session = auth.exchangeNonce(auth.issueNonce().nonce);
		expect(session).not.toBeNull();
		expect(auth.verifySession(session?.cookie ?? "")).toBe(true);

		const restarted = new ViewerAuthState({
			controlDir,
			instanceId: "daemon-b",
			now: () => now,
		});
		expect(restarted.verifySession(session?.cookie ?? "")).toBe(false);

		expect(auth.logout(session?.cookie ?? "")).toBe(true);
		expect(auth.verifySession(session?.cookie ?? "")).toBe(false);

		const expiring = auth.exchangeNonce(auth.issueNonce().nonce);
		now += VIEWER_SESSION_TTL_MS + 1;
		expect(auth.verifySession(expiring?.cookie ?? "")).toBe(false);
	});

	it("P1-T043-05-session-eviction evicts the oldest browser session above the cap", () => {
		let now = 20_000;
		const auth = new ViewerAuthState({
			controlDir: tempControlDir(),
			instanceId: "daemon-a",
			now: () => now,
		});
		const cookies: string[] = [];
		for (let index = 0; index <= VIEWER_SESSION_LIMIT; index += 1) {
			const session = auth.exchangeNonce(auth.issueNonce().nonce);
			expect(session).not.toBeNull();
			cookies.push(session?.cookie ?? "");
			now += 1;
		}

		expect(auth.verifySession(cookies[0] ?? "")).toBe(false);
		for (const cookie of cookies.slice(1)) expect(auth.verifySession(cookie)).toBe(true);
	});
});
