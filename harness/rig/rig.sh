#!/usr/bin/env bash
# Phase 0B capture rig — 実 CLI (claude / codex) をユーザー実環境から隔離して起動し、
# hook lifecycle を JSONL で捕捉する。v6.1 §29 Phase 0B / §13.6 (internal run marker)。
#
# 隔離の内容:
#   - scratch HOME / CLAUDE_CONFIG_DIR / CODEX_HOME (実環境の plugin/hook/設定を継承しない)
#   - capture 専用 hook のみを配線
#   - 使い捨て git workspace (実 repo に触れない)
#   - AGENT_MEMORY_INTERNAL_RUN=1 (§13.6 marker; 将来の adapter は capture 対象外にする)
#   - 資格情報ファイルのみ scratch へコピー (子 CLI の認証に必要。teardown で削除)
#
# 使い方:
#   rig.sh setup                     # RIG_BASE を作る (env RIG_BASE で場所指定可)
#   rig.sh claude-run <label> <prompt> [claude 追加引数...]
#   rig.sh codex-run  <label> <prompt> [codex exec 追加引数...]
#   rig.sh events                    # 捕捉済み JSONL を表示
#   rig.sh teardown                  # RIG_BASE を完全削除 (資格情報コピー含む)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RIG_BASE="${RIG_BASE:-/tmp/free-mem-rig-$USER}"
HOOK="$DIR/capture-hook.sh"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
NODE_DIR="$(dirname "$(command -v node)")"

setup() {
  mkdir -p "$RIG_BASE"; chmod 700 "$RIG_BASE"
  mkdir -p "$RIG_BASE"/{home,claude-config,codex-home,workspace,capture}
  # 資格情報 (認証済み子 CLI に必須。他の設定は一切持ち込まない)
  if [ -f "$HOME/.claude/.credentials.json" ]; then
    install -m 600 "$HOME/.claude/.credentials.json" "$RIG_BASE/claude-config/.credentials.json"
  fi
  if [ -f "$HOME/.codex/auth.json" ]; then
    install -m 600 "$HOME/.codex/auth.json" "$RIG_BASE/codex-home/auth.json"
  fi
  sed "s|__HOOK__|$HOOK|g" "$DIR/claude-settings-template.json" > "$RIG_BASE/claude-config/settings.json"
  sed "s|__HOOK__|$HOOK|g" "$DIR/codex-config-template.toml" > "$RIG_BASE/codex-home/config.toml"
  if [ ! -d "$RIG_BASE/workspace/.git" ]; then
    git -C "$RIG_BASE/workspace" init -q
    echo "rig workspace" > "$RIG_BASE/workspace/README.md"
    git -C "$RIG_BASE/workspace" add -A
    git -C "$RIG_BASE/workspace" -c user.email=rig@local -c user.name=rig commit -qm init
  fi
  echo "rig ready: $RIG_BASE"
}

run_env() { # 最小環境で子 CLI を起動する共通部
  local capture="$1"; shift
  env -i \
    PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
    HOME="$RIG_BASE/home" \
    TERM=dumb \
    CLAUDE_CONFIG_DIR="$RIG_BASE/claude-config" \
    CODEX_HOME="$RIG_BASE/codex-home" \
    AGENT_MEMORY_INTERNAL_RUN=1 \
    CAPTURE_FILE="$capture" \
    ${INJECT_MARKER:+INJECT_MARKER="$INJECT_MARKER"} \
    ${HOOK_SLEEP:+HOOK_SLEEP="$HOOK_SLEEP"} \
    "$@"
}

claude_run() {
  local label="$1" prompt="$2"; shift 2
  [ -n "$CLAUDE_BIN" ] || { echo "claude not found" >&2; exit 1; }
  local capture="$RIG_BASE/capture/claude-$label.jsonl"
  : > "$capture"
  { "$CLAUDE_BIN" --version; } > "$RIG_BASE/capture/claude-$label.version" 2>&1
  ( cd "$RIG_BASE/workspace" && \
    run_env "$capture" timeout ${RUN_SIGNAL:+--signal=$RUN_SIGNAL} "${RUN_TIMEOUT:-300}" "$CLAUDE_BIN" -p "$prompt" \
      --model haiku --output-format json --max-turns 4 "$@" \
      > "$RIG_BASE/capture/claude-$label.stdout" 2> "$RIG_BASE/capture/claude-$label.stderr" ) || \
    echo "exit=$? (recorded)" >> "$RIG_BASE/capture/claude-$label.stderr"
  echo "captured: $capture ($(wc -l < "$capture") events)"
}

codex_run() {
  local label="$1" prompt="$2"; shift 2
  [ -n "$CODEX_BIN" ] || { echo "codex not found" >&2; exit 1; }
  local capture="$RIG_BASE/capture/codex-$label.jsonl"
  : > "$capture"
  { "$CODEX_BIN" --version; } > "$RIG_BASE/capture/codex-$label.version" 2>&1
  ( cd "$RIG_BASE/workspace" && \
    run_env "$capture" timeout ${RUN_SIGNAL:+--signal=$RUN_SIGNAL} "${RUN_TIMEOUT:-300}" "$CODEX_BIN" exec --json --skip-git-repo-check \
      --dangerously-bypass-hook-trust "$@" "$prompt" \
      > "$RIG_BASE/capture/codex-$label.stdout" 2> "$RIG_BASE/capture/codex-$label.stderr" ) || \
    echo "exit=$? (recorded)" >> "$RIG_BASE/capture/codex-$label.stderr"
  echo "captured: $capture ($(wc -l < "$capture") events)"
}

case "${1:-}" in
  setup) setup ;;
  claude-run) shift; claude_run "$@" ;;
  codex-run) shift; codex_run "$@" ;;
  events) cat "$RIG_BASE"/capture/*.jsonl 2>/dev/null ;;
  teardown) rm -f "$RIG_BASE/claude-config/.credentials.json" "$RIG_BASE/codex-home/auth.json"; rm -rf "$RIG_BASE"; echo "rig removed" ;;
  *) echo "usage: rig.sh setup|claude-run <label> <prompt>|codex-run <label> <prompt>|events|teardown" >&2; exit 2 ;;
esac
