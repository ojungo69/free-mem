import { describe, expect, it } from "vitest";
import {
	convertGitleaksRules,
	fingerprintSecretRules,
	GITLEAKS_PIN,
	GITLEAKS_PINNED_RULE_IDS,
} from "./gitleaks-pinned-rules.js";
import { SecretScanner } from "./secret-scanner.js";

const cycle = (alphabet: string, length: number): string =>
	Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("");

describe("pinned Gitleaks runtime subset", () => {
	it("P1-T056-02-gitleaks-pin-source pins the official source and mandatory rule order", () => {
		expect(GITLEAKS_PIN).toEqual({
			version: "8.30.1",
			configUrl: "https://raw.githubusercontent.com/gitleaks/gitleaks/v8.30.1/config/gitleaks.toml",
			configSha256: "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf",
			subsetContractVersion: 1,
		});
		expect(GITLEAKS_PINNED_RULE_IDS).toEqual([
			"age-secret-key",
			"artifactory-api-key",
			"sentry-user-token",
			"shippo-api-token",
			"shopify-access-token",
			"sonar-api-token",
		]);
	});

	it("P1-T056-03-gitleaks-subset-conversion redacts the subset and rejects unsupported syntax", () => {
		const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		const hexadecimal = "0123456789abcdef";
		const fixtures = [
			{
				kind: "age-secret-key",
				secret: `AGE-SECRET-KEY-1${cycle("QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58)}`,
			},
			{ kind: "artifactory-api-key", secret: `AKCp${cycle(alphanumeric, 69)}` },
			{ kind: "sentry-user-token", secret: `sntryu_${cycle(hexadecimal, 64)}` },
			{ kind: "shippo-api-token", secret: `shippo_live_${cycle(hexadecimal, 40)}` },
			{ kind: "shopify-access-token", secret: `shpat_${cycle(hexadecimal, 32)}` },
			{
				kind: "sonar-api-token",
				secret: `sqp_${cycle(hexadecimal, 40)}`,
				prefix: "sonar_token = ",
			},
		];
		const scanner = new SecretScanner();
		for (const fixture of fixtures) {
			const result = scanner.scan(`${fixture.prefix ?? ""}${fixture.secret}`);
			expect(result.redacted).not.toContain(fixture.secret);
			expect(result.detections).toContainEqual({ kind: fixture.kind, count: 1 });
		}

		for (const regex of [
			"(?=secret)secret",
			"[[:alnum:]]+",
			String.raw`secret\z`,
			String.raw`(secret)\1`,
		]) {
			expect(() => convertGitleaksRules([{ id: "unsupported", regex }])).toThrow(
				"unsupported regex syntax",
			);
		}
		expect(() =>
			convertGitleaksRules([{ id: "missing-group", regex: "SECRET-[A-Z]+", secretGroup: 1 }]),
		).toThrow("invalid secretGroup");
	});

	it("P1-T056-04-gitleaks-ruleset-hash fingerprints all behavior fields in load order", () => {
		const rules = [
			{
				kind: "one",
				pattern: /one/gi,
				minEntropy: 2,
				redactGroup: 1,
				origin: "fixture-a",
			},
			{ kind: "two", pattern: /two/g, origin: "fixture-b" },
		];
		const baseline = fingerprintSecretRules(rules, false);
		expect(baseline).toBe("b06a48f88ee2fa84882be628acb0574c841faa4d85f5bf987dffaacd35f70a52");
		const variants = [
			fingerprintSecretRules([{ ...rules[0], minEntropy: 3 }, rules[1]], false),
			fingerprintSecretRules([{ ...rules[0], redactGroup: 2 }, rules[1]], false),
			fingerprintSecretRules([{ ...rules[0], origin: "fixture-c" }, rules[1]], false),
			fingerprintSecretRules([...rules].reverse(), false),
		];
		expect(new Set([baseline, ...variants])).toHaveLength(5);
		expect(fingerprintSecretRules(rules, true)).toBe(`${baseline}:degraded`);
	});
});
