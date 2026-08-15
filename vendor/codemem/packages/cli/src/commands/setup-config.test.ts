import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureSetupFileSnapshots,
	loadJsoncConfig,
	resolveOpencodeConfigPath,
	type SetupFileMutation,
	withSetupFileMutationTracking,
	writeJsonConfig,
} from "./setup-config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-setup-config-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveOpencodeConfigPath", () => {
	it("prefers an existing opencode.json when both files exist", () => {
		const dir = makeTempDir();
		const jsoncPath = join(dir, "opencode.jsonc");
		const jsonPath = join(dir, "opencode.json");
		writeFileSync(jsoncPath, "{}\n", "utf-8");
		writeFileSync(jsonPath, "{}\n", "utf-8");

		expect(resolveOpencodeConfigPath(dir)).toBe(jsonPath);
	});

	it("falls back to existing opencode.jsonc", () => {
		const dir = makeTempDir();
		const jsoncPath = join(dir, "opencode.jsonc");
		writeFileSync(jsoncPath, "{}\n", "utf-8");

		expect(resolveOpencodeConfigPath(dir)).toBe(jsoncPath);
	});

	it("falls back to existing opencode.json", () => {
		const dir = makeTempDir();
		const jsonPath = join(dir, "opencode.json");
		writeFileSync(jsonPath, "{}\n", "utf-8");

		expect(resolveOpencodeConfigPath(dir)).toBe(jsonPath);
	});

	it("defaults to opencode.jsonc when neither file exists", () => {
		const dir = makeTempDir();
		expect(resolveOpencodeConfigPath(dir)).toBe(join(dir, "opencode.jsonc"));
	});
});

describe("loadJsoncConfig", () => {
	it("parses JSONC with comments and trailing commas", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			[
				"{",
				"  // keep comment",
				'  "mcp": {',
				'    "codemem": {',
				'      "enabled": true,',
				"    },",
				"  },",
				"}",
			].join("\n"),
			"utf-8",
		);

		expect(loadJsoncConfig(configPath)).toEqual({
			mcp: {
				codemem: {
					enabled: true,
				},
			},
		});

		chmodSync(configPath, 0o640);
		writeJsonConfig(configPath, { updated: true });
		expect(loadJsoncConfig(configPath)).toEqual({ updated: true });
		if (process.platform !== "win32") {
			expect(statSync(configPath).mode & 0o777).toBe(0o640);
		}
		expect(readdirSync(dir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
		const newConfigPath = join(dir, "new.json");
		writeJsonConfig(newConfigPath, { created: true });
		if (process.platform !== "win32") {
			expect(statSync(newConfigPath).mode & 0o777).toBe(0o600);
		}

		const racedPath = join(dir, "raced.json");
		writeFileSync(racedPath, '{"value":"before"}\n');
		const baseline = captureSetupFileSnapshots([racedPath]);
		writeFileSync(racedPath, '{"value":"concurrent"}\n');
		expect(() =>
			withSetupFileMutationTracking(
				new Map<string, SetupFileMutation>(),
				new Map(baseline.map((snapshot) => [snapshot.path, snapshot])),
				() => writeJsonConfig(racedPath, { value: "setup" }),
			),
		).toThrow("Setup target changed before its first write");
		expect(readFileSync(racedPath, "utf8")).toBe('{"value":"concurrent"}\n');
	});
});
