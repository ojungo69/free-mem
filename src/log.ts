import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function isCredentialVariable(name: string): boolean {
  if (name === 'OBOETE_CF_ACCOUNT_ID') return true;
  return name.startsWith('OBOETE_') && (name.endsWith('_API_KEY') || name.endsWith('_API_TOKEN'));
}

/**
 * Replaces the value of every oboete credential variable with `[credential]`.
 * FR-016 and contracts/cli.md: logs and diagnostics never contain a credential value.
 */
export function scrubCredentials(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const values = Object.entries(env)
    .filter(([name]) => isCredentialVariable(name))
    .map(([, value]) => value?.trim() ?? '')
    .filter((value) => value !== '')
    // Longest first, so a value that contains another one is replaced whole.
    .sort((a, b) => b.length - a.length);

  let scrubbed = text;
  for (const value of values) scrubbed = scrubbed.split(value).join('[credential]');
  return scrubbed;
}

function formatValue(value: string | number | boolean): string {
  const text = String(value);
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

/** Appends one line `<ISO time> <level> <message> key=value ...` (conventions, "CLI and processes"). */
export function appendLog(
  file: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  const parts = [new Date().toISOString(), level, /[\r\n]/.test(message) ? JSON.stringify(message) : message];
  for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${formatValue(value)}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${scrubCredentials(parts.join(' '))}\n`, { mode: 0o600 });
}

/** Appends a line, or nothing: an agent-facing hook exits 0 even with an unwritable data directory. */
export function appendLogQuietly(
  file: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  try {
    appendLog(file, level, message, fields);
  } catch {
    // FR-002: the diagnostic surface being unavailable must not change the exit code.
  }
}
