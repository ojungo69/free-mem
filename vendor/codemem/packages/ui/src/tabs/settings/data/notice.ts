/* Build the user-facing notice (message + severity) from a settings-save
 * response payload. Interprets the `effects` block — hot-reloaded keys,
 * live-applied keys, restart requirements, warnings, and manual
 * follow-up actions — into one joined status line. */

import { formatSettingsKey, joinPhrases } from "./format";

interface SettingsSaveEffects {
	hot_reloaded_keys?: unknown;
	live_applied_keys?: unknown;
	restart_required_keys?: unknown;
	warnings?: unknown;
	manual_actions?: unknown;
}

export function buildSettingsNotice(payload: unknown): {
	message: string;
	type: "success" | "warning";
} {
	const raw = (payload as { effects?: SettingsSaveEffects } | null | undefined)?.effects;
	const effects: SettingsSaveEffects =
		raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const hotReloaded = Array.isArray(effects.hot_reloaded_keys)
		? effects.hot_reloaded_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const liveApplied = Array.isArray(effects.live_applied_keys)
		? effects.live_applied_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const restartRequired = Array.isArray(effects.restart_required_keys)
		? effects.restart_required_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const warnings = Array.isArray(effects.warnings)
		? effects.warnings.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: [];
	const manualActions: Array<{ command?: string }> = Array.isArray(effects.manual_actions)
		? (effects.manual_actions as Array<{ command?: string }>)
		: [];
	const lines: string[] = [];

	if (hotReloaded.length) {
		lines.push(`Applied now: ${joinPhrases(hotReloaded)}.`);
	}
	if (liveApplied.length) {
		lines.push(`Live settings updated: ${joinPhrases(liveApplied)}.`);
	}
	if (restartRequired.length) {
		lines.push(`Restart required for ${joinPhrases(restartRequired)}. Run: codemem serve restart`);
	}
	warnings.forEach((warning) => {
		lines.push(warning);
	});
	manualActions.forEach((action) => {
		if (action && typeof action.command === "string" && action.command.trim()) {
			lines.push(`If needed: ${action.command}.`);
		}
	});
	if (!lines.length) {
		lines.push("Saved.");
	}

	const hasWarning = restartRequired.length > 0 || warnings.length > 0;
	return { message: lines.join(" "), type: hasWarning ? "warning" : "success" };
}
