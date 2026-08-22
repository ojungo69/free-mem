import { describe, expect, it } from "vitest";
import { escapeHtml, escapeRegExp } from "./dom";

describe("dom string escaping", () => {
	it("escapes every HTML metacharacter", () => {
		expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
		);
	});

	it("escapes regex metacharacters so the value matches literally", () => {
		const escaped = escapeRegExp("a.b*c(d)");
		expect(escaped).toBe(String.raw`a\.b\*c\(d\)`);
		expect(new RegExp(escaped).test("a.b*c(d)")).toBe(true);
		expect(new RegExp(escaped).test("axbxcxdx")).toBe(false);
	});
});
