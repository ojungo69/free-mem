import { Hono } from "hono";
import {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	getCodememConfigPath,
	getCodememEnvOverrides,
	listObserverProviderOptions,
	readCodememConfigFile,
} from "../observer-config.js";

type ConfigData = Record<string, unknown>;

const DEFAULTS: ConfigData = {
	observer_runtime: "api_http",
	observer_auth_source: "auto",
	observer_tier_routing_enabled: false,
	observer_auth_cache_ttl_s: 300,
	observer_headers: {},
	observer_max_chars: 12000,
	pack_observation_limit: 50,
	pack_session_limit: 10,
	raw_events_sweeper_interval_s: 30,
};
const PROTECTED_KEYS = [
	"observer_api_key",
	"observer_auth_file",
	"observer_base_url",
	"observer_headers",
];
const SECRET_KEYS = new Set(["observer_api_key", "observer_auth_file", "observer_headers"]);
const REMOVED_KEYS = new Set([
	"claude_command",
	"codex_command",
	"observer_auth_command",
	"observer_auth_timeout_ms",
	"observer_rich_openai_use_responses",
]);

function sanitized(config: ConfigData): ConfigData {
	const result: ConfigData = {};
	for (const [key, value] of Object.entries(config)) {
		if (REMOVED_KEYS.has(key) || key.startsWith("sync_")) continue;
		if (!SECRET_KEYS.has(key) || value == null) {
			result[key] = value;
		} else if (Array.isArray(value)) {
			result[key] = value.length > 0 ? "[redacted]" : [];
		} else if (typeof value === "object") {
			result[key] = Object.keys(value).length > 0 ? "[redacted]" : {};
		} else {
			result[key] = typeof value === "string" && value.trim() === "" ? "" : "[redacted]";
		}
	}
	return result;
}

export function configReadRoutes() {
	const app = new Hono();
	app.get("/api/config", (c) => {
		const config = sanitized(readCodememConfigFile());
		const effective: ConfigData = { ...DEFAULTS, ...config };
		for (const [key, envName] of Object.entries(CODEMEM_CONFIG_ENV_OVERRIDES)) {
			const value = process.env[envName];
			if (value) effective[key] = value;
		}
		return c.json({
			path: getCodememConfigPath(),
			config,
			defaults: DEFAULTS,
			effective: sanitized(effective),
			env_overrides: getCodememEnvOverrides(),
			protected_keys: PROTECTED_KEYS,
			providers: listObserverProviderOptions(),
		});
	});
	return app;
}
