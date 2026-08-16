import { describe, expect, it } from "vitest";
import {
	isOneOf,
	isSpaceOrPunctuation,
	isWhitespace,
	trimEndWhere,
	trimStartWhere,
	trimWhere,
} from "./text-trim.js";

const SLASH = isOneOf("/");

describe("trimEndWhere / trimStartWhere / trimWhere", () => {
	it("matches the regexes they replace", () => {
		// 置き換え元と同じ結果になることを、境界を含めて確かめる
		const cases = ["", "/", "//", "a/", "a//", "/a", "//a//", "a", "/a/b//", "  ", "a  "];
		for (const s of cases) {
			expect(trimEndWhere(s, SLASH)).toBe(s.replace(/\/+$/, ""));
			expect(trimStartWhere(s, SLASH)).toBe(s.replace(/^\/+/, ""));
			expect(trimEndWhere(s, isWhitespace)).toBe(s.replace(/\s+$/, ""));
		}
	});

	it("trims both edges without touching the middle", () => {
		expect(trimWhere("--a--b--", isOneOf("-"))).toBe("a--b");
		expect(trimWhere("---", isOneOf("-"))).toBe("");
		expect(trimWhere("", isOneOf("-"))).toBe("");
	});

	it("treats surrogate pairs as one code point, like the /u regexes", () => {
		// 星域面の句読点。code unit 単位で見ると U+D800 台の片割れになり判定を外す
		const aegeanWordSeparator = "\u{10100}";
		expect(isSpaceOrPunctuation(aegeanWordSeparator)).toBe(true);
		const s = `a${aegeanWordSeparator}${aegeanWordSeparator}`;
		expect(trimEndWhere(s, isSpaceOrPunctuation)).toBe("a");
		expect(trimEndWhere(s, isSpaceOrPunctuation)).toBe(s.replace(/[\s\p{P}]+$/u, ""));
		// 絵文字は \p{P} ではないので落とさない（元の正規表現と同じ）
		expect(trimEndWhere("a😀", isSpaceOrPunctuation)).toBe("a😀");
	});

	it("does not scale with the length of the trimmed run", () => {
		// `s.replace(/\/+$/, "")` はここで二次に走る（32k で ~530ms、128k で ~8s）
		const started = performance.now();
		const huge = `${"/".repeat(512 * 1024)}x`;
		expect(trimEndWhere(huge, SLASH)).toBe(huge);
		expect(trimEndWhere(`x${"/".repeat(512 * 1024)}`, SLASH)).toBe("x");
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

describe("ReDoS を外した正規表現の等価性", () => {
	it("ファイル名検出は元の正規表現と同じ判定になる", () => {
		const before = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|yaml|yml)\b/;
		const after = /[\w.-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|yaml|yml)\b/;
		const cases = [
			"see packages/core/src/store.ts for details",
			"a.ts",
			".ts",
			"x..ts",
			"foo-bar.test.ts",
			"README.md and schema.sql",
			"no file here",
			"tsconfig",
			"a.tsx b.yml",
			"weird.ts.bak",
			"-.md",
			"_.json",
		];
		for (const s of cases) expect(after.test(s)).toBe(before.test(s));
	});

	it("`label: value` 判定は元の正規表現と同じになる", () => {
		const before = /.+?:\s+.+/;
		const after = /[^\n]:\s+[^\n]/;
		const cases = [
			"label: value",
			"label:value",
			"label:  value",
			": value",
			"a:b: c",
			"a:\nb",
			"a:\n",
			"",
			":",
			"a: ",
			"one two: three four",
		];
		for (const s of cases) expect(after.test(s)).toBe(before.test(s));
	});

	it("「変更なし」フィルタは元の正規表現と同じ文を拾う", () => {
		const before =
			/\bno\s+code\s*,?\s+configuration\s*,?\s+or\s+documentation\s+changes?\s+(?:were|was)\s+made\b/i;
		const after =
			/\bno\s+code[\s,]+configuration[\s,]+or\s+documentation\s+changes?\s+(?:were|was)\s+made\b/i;
		const positives = [
			"no code, configuration, or documentation changes were made",
			"No code configuration or documentation change was made",
			"NO CODE ,  CONFIGURATION , OR DOCUMENTATION CHANGES WERE MADE",
		];
		for (const s of positives) {
			expect(before.test(s)).toBe(true);
			expect(after.test(s)).toBe(true);
		}
		const negatives = [
			"no code changes were made",
			"code, configuration, or documentation changes",
		];
		for (const s of negatives) expect(after.test(s)).toBe(before.test(s));
	});

	it("空白と読点だけの差は許容が広がるが、拾う対象は変わらない", () => {
		// `\s*,?\s+` → `[\s,]+` で「空白なしのカンマ区切り」も通るようになる。
		// 元は落としていた形なので、広がった側だけを明示しておく
		const before =
			/\bno\s+code\s*,?\s+configuration\s*,?\s+or\s+documentation\s+changes?\s+(?:were|was)\s+made\b/i;
		const after =
			/\bno\s+code[\s,]+configuration[\s,]+or\s+documentation\s+changes?\s+(?:were|was)\s+made\b/i;
		const widened = "no code,configuration,or documentation changes were made";
		expect(before.test(widened)).toBe(false);
		expect(after.test(widened)).toBe(true);
	});

	it("フェンス剥がしは元の正規表現と同じ結果になる", () => {
		const strip = (value: string) =>
			value.endsWith("```") ? trimEndWhere(value.slice(0, -3), isWhitespace) : value;
		for (const s of ['{"a":1}', '{"a":1}\n```', '{"a":1}```', "```", "  ```", "", "a```b"]) {
			expect(strip(s)).toBe(s.replace(/\s*```$/, ""));
		}
	});
});
