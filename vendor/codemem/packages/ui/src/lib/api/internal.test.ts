import { describe, expect, it, vi } from "vitest";
import { bootstrapViewerSession, payloadError } from "./internal";

describe("viewer browser auth bootstrap", () => {
	it("P1-T043-06-browser-url-privacy removes every nonce before network use", async () => {
		const nonce = "n".repeat(43);
		const replaceState = vi.fn();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const exchanged = bootstrapViewerSession({
			hash: `#auth=${nonce}`,
			pathname: "/",
			search: "",
			state: { tab: "feed" },
			replaceState,
			fetch: fetchImpl,
		});

		expect(replaceState).toHaveBeenCalledWith({ tab: "feed" }, "", "/");
		expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(
			fetchImpl.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
		await exchanged;
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/auth/exchange",
			expect.objectContaining({ method: "POST", credentials: "same-origin" }),
		);

		const invalidReplaceState = vi.fn();
		const invalidFetch = vi.fn<typeof fetch>();
		await expect(
			bootstrapViewerSession({
				hash: "#auth=invalid",
				pathname: "/viewer",
				search: "?tab=feed",
				state: null,
				replaceState: invalidReplaceState,
				fetch: invalidFetch,
			}),
		).rejects.toThrow("Invalid viewer login nonce");
		expect(invalidReplaceState).toHaveBeenCalledWith(null, "", "/viewer?tab=feed");
		expect(invalidFetch).not.toHaveBeenCalled();
		expect(
			payloadError({ error: { code: "daemon_unavailable", message: "Daemon is not running." } }),
		).toBe("Daemon is not running.");
	});
});
