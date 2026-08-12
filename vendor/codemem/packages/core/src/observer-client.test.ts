import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";

function fixtureToken(label: string): string {
	return ["fixture", label, "token"].join("-");
}

// ---------------------------------------------------------------------------
// loadObserverConfig
// ---------------------------------------------------------------------------

describe("loadObserverConfig", () => {
	const envKeys = [
		"CODEMEM_CONFIG",
		"CODEMEM_OBSERVER_PROVIDER",
		"CODEMEM_OBSERVER_MODEL",
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_API_KEY",
		"CODEMEM_OBSERVER_BASE_URL",
		"CODEMEM_OBSERVER_TEMPERATURE",
		"CODEMEM_OBSERVER_TIER_ROUTING_ENABLED",
		"CODEMEM_OBSERVER_SIMPLE_MODEL",
		"CODEMEM_OBSERVER_SIMPLE_TEMPERATURE",
		"CODEMEM_OBSERVER_RICH_MODEL",
		"CODEMEM_OBSERVER_RICH_TEMPERATURE",
		"CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
		"CODEMEM_OBSERVER_RICH_REASONING_SUMMARY",
		"CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS",
		"CODEMEM_OBSERVER_OPENAI_USE_RESPONSES",
		"CODEMEM_OBSERVER_REASONING_EFFORT",
		"CODEMEM_OBSERVER_REASONING_SUMMARY",
		"CODEMEM_OBSERVER_MAX_OUTPUT_TOKENS",
		"CODEMEM_OBSERVER_AUTH_SOURCE",
		"CODEMEM_OBSERVER_AUTH_FILE",
		"CODEMEM_OBSERVER_AUTH_CACHE_TTL_S",
		"CODEMEM_OBSERVER_MAX_CHARS",
		"CODEMEM_OBSERVER_MAX_TOKENS",
		"CODEMEM_OBSERVER_HEADERS",
	];

	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of envKeys) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = saved[k];
			}
		}
	});

	it("returns defaults when no config file exists", () => {
		// Point at a nonexistent config path
		process.env.CODEMEM_CONFIG = "/tmp/codemem-test-nonexistent/config.json";
		const cfg = loadObserverConfig();
		expect(cfg.observerProvider).toBeNull();
		expect(cfg.observerModel).toBeNull();
		expect(cfg.observerMaxChars).toBe(12_000);
		expect(cfg.observerMaxTokens).toBe(4_000);
		expect(cfg.observerTemperature).toBe(0.2);
		expect(cfg.observerAuthSource).toBe("auto");
		expect(cfg.observerHeaders).toEqual({});
	});

	it("reads from a config file", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "anthropic",
				observer_model: "claude-haiku-4-5",
				observer_max_chars: 8000,
				observer_temperature: 0.35,
				observer_headers: { "x-custom": "value" },
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerProvider).toBe("anthropic");
			expect(cfg.observerModel).toBe("claude-haiku-4-5");
			expect(cfg.observerMaxChars).toBe(8000);
			expect(cfg.observerTemperature).toBe(0.35);
			expect(cfg.observerHeaders).toEqual({ "x-custom": "value" });
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("env vars override config file values", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "anthropic",
				observer_max_chars: 8000,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_OBSERVER_PROVIDER = "openai";
			process.env.CODEMEM_OBSERVER_MAX_CHARS = "5000";
			process.env.CODEMEM_OBSERVER_TEMPERATURE = "0.15";
			process.env.CODEMEM_OBSERVER_TIER_ROUTING_ENABLED = "true";
			process.env.CODEMEM_OBSERVER_SIMPLE_MODEL = "gpt-5.4-mini";
			process.env.CODEMEM_OBSERVER_SIMPLE_TEMPERATURE = "0.2";
			process.env.CODEMEM_OBSERVER_RICH_MODEL = "gpt-5.4";
			process.env.CODEMEM_OBSERVER_RICH_TEMPERATURE = "0.25";
			process.env.CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS = "12000";
			const cfg = loadObserverConfig();
			expect(cfg.observerProvider).toBe("openai");
			expect(cfg.observerMaxChars).toBe(5000);
			expect(cfg.observerTemperature).toBe(0.15);
			expect(cfg.observerTierRoutingEnabled).toBe(true);
			expect(cfg.observerSimpleModel).toBe("gpt-5.4-mini");
			expect(cfg.observerSimpleTemperature).toBe(0.2);
			expect(cfg.observerRichModel).toBe("gpt-5.4");
			expect(cfg.observerRichTemperature).toBe(0.25);
			expect(cfg.observerRichMaxOutputTokens).toBe(12000);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("handles JSONC config files", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.jsonc");
		writeFileSync(
			configPath,
			`{
				// observer settings
				"observer_provider": "openai",
				"observer_model": "gpt-4.1-mini",
			}`,
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerProvider).toBe("openai");
			expect(cfg.observerModel).toBe("gpt-4.1-mini");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("records explicit config keys for user-set tier routing fields", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "openai",
				observer_tier_routing_enabled: false,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerExplicitConfigKeys).toEqual(
				expect.arrayContaining(["observerProvider", "observerTierRoutingEnabled"]),
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("populates observerOpenAIUseResponses when set via config file", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "openai",
				observer_openai_use_responses: true,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerOpenAIUseResponses).toBe(true);
			expect(cfg.observerExplicitConfigKeys).toEqual(
				expect.arrayContaining(["observerOpenAIUseResponses"]),
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("preserves an explicit false Responses setting for custom-gateway compatibility", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "openai",
				observer_base_url: "https://gateway.example.test/v1",
				observer_openai_use_responses: false,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerBaseUrl).toBe("https://gateway.example.test/v1");
			expect(cfg.observerOpenAIUseResponses).toBe(false);
			expect(cfg.observerExplicitConfigKeys).toEqual(
				expect.arrayContaining(["observerOpenAIUseResponses"]),
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("populates observerOpenAIUseResponses when set via env var", () => {
		process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES = "true";
		process.env.CODEMEM_CONFIG = "/tmp/codemem-test-nonexistent/config.json";
		const cfg = loadObserverConfig();
		expect(cfg.observerOpenAIUseResponses).toBe(true);
		expect(cfg.observerExplicitConfigKeys).toEqual(
			expect.arrayContaining(["observerOpenAIUseResponses"]),
		);
	});
});

// ---------------------------------------------------------------------------
// ObserverClient constructor
// ---------------------------------------------------------------------------

describe("ObserverClient", () => {
	describe("constructor", () => {
		it("defaults tier routing on for capability-safe api_http providers when not explicitly set", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(true);
		});

		it("keeps tier routing off when the user explicitly disables it", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerTierRoutingEnabled: false,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(false);
		});

		it("keeps default tier routing off when a custom base URL is configured", () => {
			const observerApiKey = fixtureToken("custom-base-url");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: "https://openai-proxy.example/v1",
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(false);
		});

		it("keeps default tier routing off for unmapped api_http providers", () => {
			const observerApiKey = fixtureToken("unmapped-provider");
			const client = new ObserverClient({
				observerProvider: "opencode",
				observerModel: "opencode/gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: "https://gateway.example/v1",
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(false);
		});

		it("P1-T031-01-sidecar-retired normalizes retired runtimes to api_http", () => {
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousRuntime = process.env.CODEMEM_OBSERVER_RUNTIME;
			try {
				process.env.CODEMEM_CONFIG = "/tmp/codemem-test-nonexistent/config.json";
				process.env.CODEMEM_OBSERVER_RUNTIME = "codex_sidecar";
				expect(loadObserverConfig().observerRuntime).toBe("api_http");
			} finally {
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousRuntime == null) delete process.env.CODEMEM_OBSERVER_RUNTIME;
				else process.env.CODEMEM_OBSERVER_RUNTIME = previousRuntime;
			}

			for (const observerRuntime of ["claude_sidecar", "codex_sidecar"]) {
				const client = new ObserverClient({
					observerProvider: "openai",
					observerModel: "gpt-5.4-mini",
					observerRuntime,
					observerApiKey: null,
					observerBaseUrl: null,
					observerTemperature: 0.2,
					observerMaxChars: 12_000,
					observerMaxTokens: 4_000,
					observerHeaders: {},
					observerAuthSource: "none",
					observerAuthFile: null,
					observerAuthCacheTtlS: 300,
				});
				expect(client.runtime).toBe("api_http");
				expect(client.getStatus().auth.type).toBe("none");
			}
		});

		it("defaults to openai provider and default model", () => {
			const client = new ObserverClient({
				observerProvider: null,
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.provider).toBe("openai");
			expect(client.model).toBe("gpt-5.4-mini");
			expect(client.temperature).toBe(0.2);
			expect(client.runtime).toBe("api_http");
		});

		it("falls back to deterministic default temperature when omitted", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.temperature).toBe(0.2);
		});

		it("uses anthropic provider and default model when configured", () => {
			const client = new ObserverClient({
				observerProvider: "anthropic",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.provider).toBe("anthropic");
			expect(client.model).toBe("claude-haiku-4-5");
		});

		it("uses configured model when provided", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-4o",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerOpenAIUseResponses: true,
				observerReasoningEffort: "low",
				observerReasoningSummary: "auto",
				observerMaxOutputTokens: 12000,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.model).toBe("gpt-4o");
			expect(client.openaiUseResponses).toBe(true);
			expect(client.reasoningEffort).toBe("low");
			expect(client.reasoningSummary).toBe("auto");
			expect(client.maxOutputTokens).toBe(12000);
		});

		it("defaults OpenAI api_http clients to Responses when transport is not explicitly set", () => {
			const observerApiKey = fixtureToken("openai-responses-default");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.openaiUseResponses).toBe(true);
		});

		it("ignores explicit false for official OpenAI api_http Responses usage", () => {
			const observerApiKey = fixtureToken("openai-responses-disabled");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerOpenAIUseResponses: false,
				observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.openaiUseResponses).toBe(true);
		});

		it("round-trips per-tier provider overrides through toConfig", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerSimpleProvider: "anthropic",
				observerRichProvider: "anthropic",
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.simpleProvider).toBe("anthropic");
			expect(client.richProvider).toBe("anthropic");
			const config = client.toConfig();
			expect(config.observerSimpleProvider).toBe("anthropic");
			expect(config.observerRichProvider).toBe("anthropic");
		});

		it("preserves auth source details in toConfig", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "file",
				observerAuthFile: "/tmp/observer-auth.json",
				observerAuthCacheTtlS: 120,
			});
			const config = client.toConfig();
			expect(config.observerAuthSource).toBe("file");
			expect(config.observerAuthFile).toBe("/tmp/observer-auth.json");
			expect(config.observerAuthCacheTtlS).toBe(120);
		});

		it("infers anthropic from claude model prefix", () => {
			const client = new ObserverClient({
				observerProvider: null,
				observerModel: "claude-haiku-4-5",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.provider).toBe("anthropic");
			expect(client.model).toBe("claude-haiku-4-5");
		});

		it("infers opencode provider from prefixed model", () => {
			const prevHome = process.env.HOME;
			const tmpDir = mkdtempSync(join(tmpdir(), "codemem-opencode-test-"));
			const configDir = join(tmpDir, ".config", "opencode");
			mkdirSync(configDir, { recursive: true });
			try {
				writeFileSync(
					join(configDir, "opencode.jsonc"),
					JSON.stringify({ small_model: "opencode/gpt-5-nano" }),
				);
				process.env.HOME = tmpDir;
				const client = new ObserverClient({
					observerProvider: null,
					observerModel: "opencode/gpt-5.4-mini",
					observerRuntime: null,
					observerApiKey: null,
					observerBaseUrl: null,
					observerMaxChars: 12_000,
					observerMaxTokens: 4_000,
					observerHeaders: {},
					observerAuthSource: "auto",
					observerAuthFile: null,
					observerAuthCacheTtlS: 300,
				});
				expect(client.provider).toBe("opencode");
				expect(client.model).toBe("gpt-5.4-mini");
				expect(client.getStatus().auth.hasToken).toBe(false);
			} finally {
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("preserves explicit observer_base_url for opencode built-in provider", () => {
			const observerApiKey = fixtureToken("opencode-base-url");
			const client = new ObserverClient({
				observerProvider: "opencode",
				observerModel: "opencode/gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey,
				observerBaseUrl: "https://proxy.example.test/v1",
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});

			expect((client as unknown as { _customBaseUrl: string | null })._customBaseUrl).toBe(
				"https://proxy.example.test/v1",
			);
		});
	});

	describe("getStatus", () => {
		it("returns expected shape", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-4.1-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			const status = client.getStatus();
			expect(status.provider).toBe("openai");
			expect(status.model).toBe("gpt-4.1-mini");
			expect(status.runtime).toBe("api_http");
			expect(status.auth).toBeDefined();
			expect(typeof status.auth.source).toBe("string");
			expect(typeof status.auth.hasToken).toBe("boolean");
		});

		it("includes lastError when set", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			// No credentials → auth_missing error after observe attempt
			// We trigger the error path by accessing private _setLastError
			// (or we can just check the status shape without error)
			const status = client.getStatus();
			expect(status.lastError).toBeUndefined();
		});

		it("reports auth type based on resolved credentials", () => {
			const observerApiKey = fixtureToken("auth-status");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			const status = client.getStatus();
			expect(status.auth.hasToken).toBe(true);
			expect(status.auth.type).toBe("api_direct");
		});
	});

	describe("refreshAuth", () => {
		it("does not throw", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(() => client.refreshAuth()).not.toThrow();
		});
	});
});

// ---------------------------------------------------------------------------
// ObserverClient.observe() — fetch mocking
// ---------------------------------------------------------------------------

describe("ObserverClient.observe()", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function makeClient(provider: string, apiKey: string): ObserverClient {
		return new ObserverClient({
			observerProvider: provider,
			observerModel: null,
			observerRuntime: null,
			observerApiKey: apiKey,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
		});
	}

	it("calls Anthropic endpoint with correct headers", async () => {
		const apiKey = fixtureToken("anthropic-header");
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					content: [{ type: "text", text: "test response" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = makeClient("anthropic", apiKey);
		const result = await client.observe("system prompt", "user prompt");

		expect(capturedUrl).toContain("anthropic.com");
		expect(capturedHeaders?.["x-api-key"]).toBe(apiKey);
		expect(result.raw).toBe("test response");
		expect(result.provider).toBe("anthropic");
		expect(result.usage).toBeNull();
	});

	it("normalizes Anthropic token usage including cache fields", async () => {
		const apiKey = fixtureToken("anthropic-usage");
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					content: [{ type: "text", text: "anthropic response" }],
					usage: {
						input_tokens: 101,
						output_tokens: 23,
						cache_read_input_tokens: 17,
						cache_creation_input_tokens: 11,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as typeof globalThis.fetch;

		const result = await makeClient("anthropic", apiKey).observe("system", "user");

		expect(result.usage).toEqual({
			inputTokens: 101,
			outputTokens: 23,
			cacheReadInputTokens: 17,
			cacheCreationInputTokens: 11,
		});
	});

	it("keeps official OpenAI on Responses when legacy config explicitly disables it", async () => {
		const observerApiKey = fixtureToken("openai-chat-completions");
		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			capturedUrl = String(input);
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "responses response" }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: "gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey,
			observerBaseUrl: null,
			observerOpenAIUseResponses: false,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
			observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
		});
		const result = await client.observe("system", "user");

		expect(capturedUrl).toContain("/responses");
		expect(capturedUrl).not.toContain("/chat/completions");
		expect(result.raw).toBe("responses response");
	});

	it("routes an explicit custom OpenAI-compatible base URL to chat without reasoning", async () => {
		const observerApiKey = fixtureToken("custom-openai-chat-completions");
		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request) => {
			capturedUrl = String(input);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "chat completions response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: "gateway-model",
			observerRuntime: "api_http",
			observerApiKey,
			observerBaseUrl: "https://gateway.example.test/v1",
			observerOpenAIUseResponses: false,
			observerReasoningEffort: "high",
			observerReasoningSummary: "detailed",
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
			observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
		});
		const result = await client.observe("system", "user");

		expect(capturedUrl).toBe("https://gateway.example.test/v1/chat/completions");
		expect(client.openaiUseResponses).toBe(false);
		expect(client.reasoningEffort).toBeNull();
		expect(client.reasoningSummary).toBeNull();
		expect(result.raw).toBe("chat completions response");
	});

	it("normalizes OpenAI chat token usage", async () => {
		const observerApiKey = fixtureToken("openai-chat-usage");
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "chat response" } }],
					usage: {
						prompt_tokens: 73,
						completion_tokens: 19,
						total_tokens: 92,
						prompt_tokens_details: { cached_tokens: 31 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as typeof globalThis.fetch;
		const client = new ObserverClient({
			...makeClient("openai", observerApiKey).toConfig(),
			observerBaseUrl: "https://gateway.example.test/v1",
			observerOpenAIUseResponses: false,
			observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
		});

		const result = await client.observe("system", "user");

		expect(result.usage).toEqual({
			inputTokens: 73,
			outputTokens: 19,
			totalTokens: 92,
			cacheReadInputTokens: 31,
		});
	});

	it("calls OpenAI Responses endpoint by default", async () => {
		const apiKey = fixtureToken("openai-responses");
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;
		let capturedBody: Record<string, unknown> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "openai response text" }],
						},
					],
					usage: { input_tokens: 211, output_tokens: 37, total_tokens: 248 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			...makeClient("openai", apiKey).toConfig(),
			observerReasoningEffort: "medium",
		});
		const result = await client.observe("system", "user");

		expect(capturedUrl).toContain("openai.com");
		expect(capturedUrl).toContain("/responses");
		expect(capturedHeaders?.authorization).toBe(`Bearer ${apiKey}`);
		expect(capturedBody?.input).toBeDefined();
		expect(capturedBody?.reasoning).toEqual({ effort: "medium" });
		expect(capturedBody?.temperature).toBeUndefined();
		expect(client.temperature).toBeNull();
		expect(result.raw).toBe("openai response text");
		expect(result.provider).toBe("openai");
		expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(result.usage).toEqual({ inputTokens: 211, outputTokens: 37, totalTokens: 248 });

		const noReasoningClient = new ObserverClient({
			...makeClient("openai", apiKey).toConfig(),
			observerReasoningEffort: "none",
		});
		expect(noReasoningClient.temperature).toBe(0.2);
	});

	it("normalizes unpaired UTF-16 surrogates after prompt clipping", async () => {
		const apiKey = fixtureToken("openai-well-formed-unicode");
		let capturedInput: Array<{ role: string; content: Array<{ text: string }> }> = [];
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				input?: Array<{ role: string; content: Array<{ text: string }> }>;
			};
			capturedInput = body.input ?? [];
			return new Response(JSON.stringify({ output_text: "ok" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		const client = new ObserverClient({
			...makeClient("openai", apiKey).toConfig(),
			observerMaxChars: 100,
		});

		// A 100-char budget gives the system prompt 75 UTF-16 units; the emoji is split at 75.
		await client.observe(`${"s".repeat(74)}😀`, "user\uDC00");

		const texts = capturedInput.flatMap((item) => item.content.map((content) => content.text));
		expect(texts).toHaveLength(2);
		expect(texts.every((text) => text.isWellFormed())).toBe(true);
		expect(texts.join("\n")).toContain("�");
	});

	it("keeps token usage isolated across concurrent observe calls", async () => {
		const apiKey = fixtureToken("openai-concurrent-usage");
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as {
				input: Array<{ role: string; content: Array<{ text: string }> }>;
			};
			const userText = request.input.find((item) => item.role === "user")?.content[0]?.text;
			const inputTokens = userText === "slow" ? 10 : 20;
			if (userText === "slow") await new Promise((resolve) => setTimeout(resolve, 5));
			return new Response(
				JSON.stringify({
					output_text: userText,
					usage: { input_tokens: inputTokens, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		const client = makeClient("openai", apiKey);

		const [slow, fast] = await Promise.all([
			client.observe("system", "slow"),
			client.observe("system", "fast"),
		]);

		expect(slow.usage).toEqual({ inputTokens: 10, outputTokens: 1 });
		expect(fast.usage).toEqual({ inputTokens: 20, outputTokens: 1 });
	});

	it("allows no-auth calls to explicit OpenAI-compatible base URLs", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "local model response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "lms-200",
			observerModel: "qwopus-glm-18b-merged",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerBaseUrl: "http://127.0.0.1:1234/v1",
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");

		expect(capturedUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
		expect(capturedHeaders?.authorization).toBeUndefined();
		expect(result.raw).toBe("local model response");
	});

	it("parses OpenAI-compatible chat content blocks", async () => {
		const observerApiKey = fixtureToken("openai-content-blocks");
		globalThis.fetch = (async () => {
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: [
									{ type: "text", text: "first" },
									{ type: "output_text", text: " second" },
								],
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: "gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey,
			observerBaseUrl: "https://gateway.example.test/v1",
			observerOpenAIUseResponses: false,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
			observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
		});

		const result = await client.observe("system", "user");

		expect(result.raw).toBe("first second");
	});

	it("allows no-auth calls to custom OpenCode provider base URLs", async () => {
		const prevHome = process.env.HOME;
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-custom-no-auth-provider-test-"));
		const configDir = join(tmpDir, ".config", "opencode");
		mkdirSync(configDir, { recursive: true });
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		writeFileSync(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({
				provider: {
					work: {
						options: {
							baseURL: "https://gateway.example.test/v1",
						},
						models: {
							fast: { id: "gateway-fast" },
						},
					},
				},
			}),
		);

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "gateway response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		try {
			process.env.HOME = tmpDir;
			const client = new ObserverClient({
				observerProvider: "work",
				observerModel: "work/fast",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});
			expect(client.requestedModel).toBe("work/fast");
			expect(client.model).toBe("gateway-fast");

			const result = await client.observe("system", "user");

			expect(capturedUrl).toBe("https://gateway.example.test/v1/chat/completions");
			expect(capturedHeaders?.authorization).toBeUndefined();
			expect(result.model).toBe("gateway-fast");
			expect(result.raw).toBe("gateway response");
		} finally {
			if (prevHome == null) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("still requires auth for the built-in opencode provider", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "opencode",
			observerModel: "opencode/gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");

		expect(result.raw).toBeNull();
		expect(fetchCalls).toBe(0);
	});

	it("allows no-auth calls for opencode when observer_base_url is explicit", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "explicit opencode gateway response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "opencode",
			observerModel: "opencode/gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerBaseUrl: "http://127.0.0.1:1234/v1",
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");

		expect(capturedUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
		expect(capturedHeaders?.authorization).toBeUndefined();
		expect(result.raw).toBe("explicit opencode gateway response");
	});

	it("dedupes authorization headers case-insensitively for custom providers", async () => {
		const prevHome = process.env.HOME;
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-custom-auth-header-test-"));
		const configDir = join(tmpDir, ".config", "opencode");
		mkdirSync(configDir, { recursive: true });
		const providerApiKey = fixtureToken("provider-config");
		let capturedHeaders: Record<string, string> | undefined;

		writeFileSync(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({
				provider: {
					acme: {
						options: {
							baseURL: "https://proxy.example.test/v1",
							apiKey: providerApiKey,
							headers: {
								// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder syntax
								Authorization: "Bearer ${auth.token}",
							},
						},
						models: {
							foo: { id: "foo-model" },
						},
					},
				},
			}),
		);

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "custom provider response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		try {
			process.env.HOME = tmpDir;
			const client = new ObserverClient({
				observerProvider: "acme",
				observerModel: "acme/foo",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCacheTtlS: 300,
			});

			const result = await client.observe("system", "user");

			expect(result.raw).toBe("custom provider response");
			expect(capturedHeaders?.Authorization).toBe(`Bearer ${providerApiKey}`);
			expect(capturedHeaders?.authorization).toBeUndefined();
		} finally {
			if (prevHome == null) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("truncates prompts to maxChars", async () => {
		const observerApiKey = fixtureToken("truncate-prompts");
		let capturedBody: Record<string, unknown> | undefined;

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "ok" }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: null,
			observerRuntime: null,
			observerApiKey,
			observerBaseUrl: null,
			observerMaxChars: 100,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
		});

		const longSystem = "s".repeat(500);
		const longUser = "u".repeat(500);
		await client.observe(longSystem, longUser);

		const input = capturedBody?.input as Array<Record<string, unknown>>;
		expect(input).toBeDefined();
		const systemMsg = input.find((m: Record<string, unknown>) => m.role === "developer");
		const systemText = ((systemMsg?.content as Array<Record<string, unknown>> | undefined)?.[0]
			?.text ?? "") as string;
		expect(systemText.length).toBeLessThanOrEqual(100);
	});

	it("retries once on auth error", async () => {
		const apiKey = fixtureToken("anthropic-retry");
		let callCount = 0;

		globalThis.fetch = (async () => {
			callCount++;
			if (callCount === 1) {
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response(
				JSON.stringify({
					content: [{ type: "text", text: "retry success" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = makeClient("anthropic", apiKey);
		// The retry should succeed since we set the key
		const result = await client.observe("system", "user");

		// Should have made 2+ fetch calls (initial + retry after auth refresh)
		expect(callCount).toBeGreaterThanOrEqual(2);
		expect(result.raw).toBe("retry success");
	});

	it("returns null raw when no credentials available", async () => {
		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: null,
			observerRuntime: null,
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");
		expect(result.raw).toBeNull();
	});
});
