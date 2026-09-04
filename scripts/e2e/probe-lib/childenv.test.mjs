import assert from "node:assert/strict";
import test from "node:test";

import { childEnv } from "./agents.mjs";

/** The variables a developer's shell carries when they run a probe, put back afterwards. */
function withCredentialsInEnvironment(fn) {
  const credentials = {
    OBOETE_CF_API_TOKEN: "cf-token",
    OBOETE_CF_ACCOUNT_ID: "cf-account",
    OBOETE_OPENROUTER_API_KEY: "openrouter-key",
  };
  const previous = {};
  for (const [name, value] of Object.entries(credentials)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    fn(credentials);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// FR-016: a probe launcher hands the agent CLI the developer's shell, so the filter belongs to the
// environment builder every launcher goes through, not to one launcher.
test("childEnv keeps oboete credentials from every agent CLI and hands them over only on request", () => {
  withCredentialsInEnvironment((credentials) => {
    const isolation = {
      OBOETE_HOME: "/nonexistent/oboete-home",
      CODEX_HOME: "/nonexistent/codex-home",
      GROK_HOME: "/nonexistent/grok-home",
      PI_CODING_AGENT_DIR: "/nonexistent/pi-home",
      GROK_CLAUDE_HOOKS_ENABLED: "0",
    };

    const agent = childEnv(isolation);
    // The names are written out rather than tested with the predicate the filter itself uses: a
    // predicate that stopped recognising a variable would otherwise agree with the leak.
    for (const name of Object.keys(credentials)) assert.equal(agent[name], undefined, name);
    for (const name of Object.keys(agent)) assert.ok(!name.startsWith("OBOETE_") || name === "OBOETE_HOME", name);
    for (const [name, value] of Object.entries(isolation)) assert.equal(agent[name], value, name);
    assert.ok(agent.PATH);

    const observer = childEnv(isolation, { credentials: true });
    for (const [name, value] of Object.entries(credentials)) assert.equal(observer[name], value, name);
    for (const [name, value] of Object.entries(isolation)) assert.equal(observer[name], value, name);
  });
});

test("childEnv drops a credential passed to it explicitly unless credentials were asked for", () => {
  const agent = childEnv({ OBOETE_NIM_API_KEY: "nim-key" });
  assert.equal(agent.OBOETE_NIM_API_KEY, undefined);
  assert.equal(childEnv({ OBOETE_NIM_API_KEY: "nim-key" }, { credentials: true }).OBOETE_NIM_API_KEY, "nim-key");
});

// The account id carries no key material but names the Cloudflare account the developer pays for,
// and it is the one credential variable whose name does not end in _API_KEY or _API_TOKEN, so it is
// the one a narrowed rule would drop first.
test("the Cloudflare account id is a credential the agent CLI never sees", () => {
  const previous = process.env.OBOETE_CF_ACCOUNT_ID;
  process.env.OBOETE_CF_ACCOUNT_ID = "cf-account";
  try {
    assert.equal(childEnv({}).OBOETE_CF_ACCOUNT_ID, undefined);
    assert.equal(childEnv({}, { credentials: true }).OBOETE_CF_ACCOUNT_ID, "cf-account");
  } finally {
    if (previous === undefined) delete process.env.OBOETE_CF_ACCOUNT_ID;
    else process.env.OBOETE_CF_ACCOUNT_ID = previous;
  }
});
