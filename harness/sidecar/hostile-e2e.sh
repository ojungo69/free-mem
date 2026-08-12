#!/usr/bin/env bash
# §13.6 hostile fixture E2E — 悪意ある設定下で sidecar 起動形が side effect ゼロかを実証する。
#
# Codex sidecar: `codex exec --ephemeral --ignore-user-config` を hostile CODEX_HOME 上で起動し、
#   偽 hook が発火しない（marker 不在）ことを確認する。認証は ChatGPT サブスク資格情報を使う
#   ため、**ToS 確認が済むまで実行しない**（RUN_CODEX=1 を明示した場合のみ実行）。
# Claude sidecar: `--bare` は ANTHROPIC_API_KEY / apiKeyHelper のみを認証に使う（OAuth・keychain
#   を読まない）。API key が無い環境では起動できないため E2E は不能 = 未認定。
#   ここでは「key 不在で --bare が subscription にフォールバックしないこと」を確認する。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${HOSTILE_BASE:-/tmp/free-mem-hostile-$USER}"
SUP="$DIR/supervisor.sh"
NODE_DIR="$(dirname "$(command -v node)")"
fails=0
chk(){ if [ "$1" = ok ]; then echo "PASS: $2"; else echo "FAIL: $2"; fails=$((fails+1)); fi }

"$DIR/hostile-fixture.sh" build > /dev/null

hostile_env() {
  env -i PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
    HOME="$BASE/home" TERM=dumb \
    CLAUDE_CONFIG_DIR="$BASE/claude-config" CODEX_HOME="$BASE/codex-home" \
    AGENT_MEMORY_INTERNAL_RUN=1 "$@"
}
export -f hostile_env 2>/dev/null || true

# --- Claude: --bare は API key 不在時に subscription へフォールバックしない ---
out="$BASE/claude-bare.out"
( cd "$BASE/workspace" && DEADLINE=60 "$SUP" "$out" \
  $(command -v claude) --bare -p "Reply OK" --model haiku > "$BASE/claude-bare.sup" 2>&1 ) || true
if grep -qiE "api.?key|ANTHROPIC_API_KEY|credit balance|authentication" "$out" "$BASE/claude-bare.sup" 2>/dev/null; then
  chk ok "claude --bare refuses without ANTHROPIC_API_KEY (no subscription fallback)"
elif grep -q "OK" "$out" 2>/dev/null; then
  chk no "claude --bare produced output WITHOUT an API key — investigate credential source"
else
  chk ok "claude --bare did not complete without API key"
fi
[ -z "$(ls "$BASE/markers" 2>/dev/null)" ] && chk ok "claude --bare fired no hostile hooks" \
  || chk no "claude --bare fired hostile hooks: $(ls "$BASE/markers" | tr '\n' ' ')"

# --- Codex: hostile config 下で --ephemeral --ignore-user-config が hook を無視するか ---
if [ "${RUN_CODEX:-0}" = "1" ]; then
  rm -f "$BASE"/markers/* 2>/dev/null
  # 認証だけは hostile CODEX_HOME へ持ち込む（持ち込まないと 401 になり、
  # hostile 設定が効いていない実 CODEX_HOME での空振り検査になる）
  [ -f "$HOME/.codex/auth.json" ] && install -m 600 "$HOME/.codex/auth.json" "$BASE/codex-home/auth.json"
  out="$BASE/codex-iso.out"
  ( cd "$BASE/workspace" && DEADLINE=120 hostile_env "$SUP" "$out" \
    $(command -v codex) exec --json --ephemeral --ignore-user-config --skip-git-repo-check \
      "Reply with exactly: OK" > "$BASE/codex-iso.sup" 2>&1 ) || true
  [ -z "$(ls "$BASE/markers" 2>/dev/null)" ] && chk ok "codex --ephemeral --ignore-user-config fired no hostile hooks" \
    || chk no "codex isolation FAILED, markers: $(ls "$BASE/markers" | tr '\n' ' ')"
  grep -q "PWNED" "$out" 2>/dev/null && chk no "codex obeyed hostile AGENTS.md" || chk ok "codex ignored hostile AGENTS.md instructions"
  grep -q 'survivors=\[\]' "$BASE/codex-iso.sup" && chk ok "codex run left no surviving descendants" || chk no "codex run left survivors"
else
  echo "SKIP: codex hostile E2E (RUN_CODEX=1 で実行。ChatGPT サブスク資格情報を使うため §13.6 の ToS 確認が前提)"
fi

echo "---"
if [ $fails -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
