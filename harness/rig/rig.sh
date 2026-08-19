#!/usr/bin/env bash
# Phase 0B capture rig — 実 CLI (claude / codex) をユーザー実環境から隔離して起動し、
# hook lifecycle を JSONL で捕捉する。v6.1 §29 Phase 0B / §13.6 (internal run marker)。
#
# 隔離の内容:
#   - scratch HOME / CLAUDE_CONFIG_DIR / CODEX_HOME (実環境の plugin/hook/設定を継承しない)
#   - capture 専用 hook のみを配線
#   - 使い捨て git workspace (実 repo に触れない)
#   - AGENT_MEMORY_INTERNAL_RUN=1 (§13.6 marker; 将来の adapter は capture 対象外にする)
#   - 資格情報ファイルのみ scratch へコピー (子 CLI の認証に必要)。コピーは 1 回の実行中だけ
#     置かれ、EXIT/INT/TERM の trap で必ず消える (teardown 待ちで /tmp に残さない)
#
# 使い方:
#   rig.sh setup                     # RIG_BASE を作る (env RIG_BASE で場所指定可)
#   rig.sh claude-run <label> <prompt> [claude 追加引数...]
#   rig.sh codex-run  <label> <prompt> [codex exec 追加引数...]
#   rig.sh import <cli> <label> <scenario-id>   # 証拠置き場へ持ち込み manifest を書く
#   rig.sh teardown                  # RIG_BASE を完全削除 (資格情報コピー含む)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RIG_BASE="${RIG_BASE:-/tmp/free-mem-rig-$USER}"
HOOK="$DIR/capture-hook.sh"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH — refusing to run (PATH に '.' が混ざる事故を防ぐ)" >&2; exit 3; }
NODE_DIR="$(dirname "$NODE_BIN")"

# 資格情報コピーは必ず消す。teardown を呼び忘れても、異常終了しても残さない。
purge_credentials() {
  rm -f "$RIG_BASE/claude-config/.credentials.json" "$RIG_BASE/codex-home/auth.json" 2>/dev/null || true
}
trap purge_credentials EXIT INT TERM

# 資格情報は「その 1 回の子 CLI 実行の間だけ」置く（trap で必ず消える）。
stage_credentials() { # $1 = claude | codex
  # 置く前に必ず消す。SIGKILL で trap が走らなかった前回の残りと、もう一方の provider の
  # 分がここに残っていると、測定対象の tool から同じ UID で読める
  purge_credentials
  # **実行する CLI の分だけ**置く。両方置くと、測定対象の CLI が動かす tool から
  # もう一方の資格情報を同じ UID で読める（read-only sandbox は読み取りを防がない）
  case "$1" in
    claude) [ -f "$HOME/.claude/.credentials.json" ] && install -m 600 "$HOME/.claude/.credentials.json" "$RIG_BASE/claude-config/.credentials.json" ;;
    codex)  [ -f "$HOME/.codex/auth.json" ] && install -m 600 "$HOME/.codex/auth.json" "$RIG_BASE/codex-home/auth.json" ;;
    *) echo "stage_credentials: unknown cli $1" >&2; return 1 ;;
  esac
  return 0
}

setup() {
  mkdir -p "$RIG_BASE"; chmod 700 "$RIG_BASE"
  mkdir -p "$RIG_BASE"/{home,claude-config,codex-home,workspace,capture}
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

run_env() { # 最小環境で子 CLI を起動する共通部。$1 = claude | codex
  local cli="$1" capture="$2"; shift 2
  # 対象 provider の設定だけ渡す。両方渡すと、測定対象がもう一方の config directory を
  # 辿れる（資格情報を消していても、設定そのものが観測の対象外の情報になる）
  local cfg=()
  case "$cli" in
    claude) cfg=(CLAUDE_CONFIG_DIR="$RIG_BASE/claude-config") ;;
    codex)  cfg=(CODEX_HOME="$RIG_BASE/codex-home") ;;
  esac
  env -i \
    PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
    HOME="$RIG_BASE/home" \
    TERM=dumb \
    "${cfg[@]}" \
    AGENT_MEMORY_INTERNAL_RUN=1 \
    CAPTURE_FILE="$capture" \
    ${INJECT_MARKER:+INJECT_MARKER="$INJECT_MARKER"} \
    ${HOOK_SLEEP:+HOOK_SLEEP="$HOOK_SLEEP"} \
    "$@"
}

with_lock() { # 並行 run を禁止する。同じ RIG_BASE を共有すると、片方の credential を
  # もう片方の測定対象が同じ UID で読める
  exec 9>"$RIG_BASE/.lock"
  flock -n 9 || { echo "another rig run holds $RIG_BASE" >&2; exit 4; }
}

# 測定対象を独自の process group で起動し、終わったら group ごと畳む。
#
# lock の fd を子へ渡さない形（`9>&-`）は採らない。渡さないと、CLI が残した process が
# 生きているうちに次の run が始まり、その run が置いた**別 provider の資格情報**を、
# 残った process が同じ UID で読める。fd を渡しておけば残骸が lock を握り続け、次の run は
# 止まる。一方で握らせたままだと daemon 1 つで rig が使えなくなるので、run の終わりに
# group ごと畳んで普通の残骸は片付ける。
#
# ここで成り立つのは 2 つまで。事故で残った daemon は畳める。group を抜けたが fd を握った
# ままの process がいれば次の run は止まる（fail closed）。**抜けたうえで自分で fd 9 を
# 閉じた process には効かない** —— lock は協調的な仕組みなので、協調しない相手は止められない。
# 同一 UID で走らせる限りこれは閉じない（#95）。#90 と同じで、rig は敵対的な測定対象に
# 対する信頼境界ではない
# `timeout` は既定で対象を**自分の** process group へ移すので、そのままだと下の
# `kill -- -<pid>` が測定対象へ届かない。`--foreground` で group を作らせず、畳むのは
# こちらの group 1 つに統一する（timeout 自身の group kill を失うが、後段で group ごと
# 畳むので取りこぼしは増えない）
reap_group() { kill -- "-$1" 2>/dev/null || true; }

claude_run() {
  local label="$1" prompt="$2" rc=0; shift 2
  with_lock
  [ -n "$CLAUDE_BIN" ] || { echo "claude not found" >&2; exit 1; }
  # 付属物は import-evidence.mjs と同じ stem で並べる。記録だけ拡張子付きの別名にすると、
  # 「消す名前」と「書く名前」がずれても誰も気づかない（.exit が実際にずれていた）
  local stem="$RIG_BASE/capture/claude-$label"
  local capture="$stem.jsonl"
  # 記録失敗の痕跡も run ごとに消す。残すと前回の失敗が今回の manifest の
  # recorderErrors に載り、正しい証拠が棄却される。終了コードも同じ理由で先に消す:
  # run が SIGKILL で落ちると前回の成功が残り、途中で切れた記録に exitStatus=0 が付く。
  # .errors だけは hook が $CAPTURE_FILE から作るので記録側の名前になる
  : > "$capture"; rm -f "$capture.errors" "$stem.exit"
  stage_credentials claude
  # --version も測定対象の起動なので、本実行と同じ扱いにする（ここだけ残骸が残ると
  # 次の run が lock で止まる。実際にこの経路だけ監督から漏れていた）
  local ver_pid=0 run_pid=0 ver_rc=0
  # 版の問い合わせも測定対象の起動なので、本実行と同じ隔離で行う。ここだけ素で起動していると、
  # その 1 回だけ実 HOME・実設定・実 plugin を見た状態で測定対象が動く。作業場所も分ける:
  # claude は cwd から上へ設定を探すので、呼び出し元の repository に居るだけで実設定に届く。
  # 記録先も分ける。問い合わせが hook を起こしたとき、その event が scenario の記録に
  # 混ざって同じ manifest と digest に入るのを防ぐ
  local ver_capture="$stem.version-probe.jsonl"
  set -m
  ( cd "$RIG_BASE/workspace" && run_env claude "$ver_capture" "$CLAUDE_BIN" --version ) > "$stem.version" 2>&1 & ver_pid=$!
  set +m
  # 失敗した問い合わせの出力を版として扱わない。1 行だけ吐いて非ゼロで終える測定対象は、
  # そのエラー行がそのまま cliVersion として証拠に載り「この版で測った」と読めてしまう。
  # 畳むのが先。ここで抜けるときも残骸を置いていかない
  wait "$ver_pid" || ver_rc=$?
  reap_group "$ver_pid"
  # 問い合わせの記録は持ち込みの対象にしない。中身も残さない
  rm -f "$ver_capture" "$ver_capture.errors"
  [ "$ver_rc" -eq 0 ] || { echo "claude --version failed (exit=$ver_rc)" >&2; exit 1; }
  set -m
  ( cd "$RIG_BASE/workspace" && \
    run_env claude "$capture" timeout --foreground ${RUN_SIGNAL:+--signal=$RUN_SIGNAL} "${RUN_TIMEOUT:-300}" "$CLAUDE_BIN" -p "$prompt" \
      --model haiku --output-format json --max-turns 4 "$@" \
      > "$stem.stdout" 2> "$stem.stderr" ) & run_pid=$!
  set +m
  wait "$run_pid" || rc=$?
  reap_group "$run_pid"
  # 終了コードは数値で別に残す。manifest の exitStatus はここから読む
  printf '%s\n' "$rc" > "$stem.exit"
  [ "$rc" -eq 0 ] || echo "exit=$rc (recorded)" >> "$stem.stderr"
  echo "captured: $capture ($(wc -l < "$capture") events)"
}

codex_run() {
  local label="$1" prompt="$2" rc=0; shift 2
  with_lock
  [ -n "$CODEX_BIN" ] || { echo "codex not found" >&2; exit 1; }
  local stem="$RIG_BASE/capture/codex-$label"
  local capture="$stem.jsonl"
  : > "$capture"; rm -f "$capture.errors" "$stem.exit"
  stage_credentials codex
  local ver_pid=0 run_pid=0 ver_rc=0
  # 版の問い合わせも測定対象の起動なので、本実行と同じ隔離で行う。ここだけ素で起動していると、
  # その 1 回だけ実 HOME・実設定・実 plugin を見た状態で測定対象が動く。作業場所も分ける:
  # codex は cwd から上へ設定を探すので、呼び出し元の repository に居るだけで実設定に届く。
  # 記録先も分ける。問い合わせが hook を起こしたとき、その event が scenario の記録に
  # 混ざって同じ manifest と digest に入るのを防ぐ
  local ver_capture="$stem.version-probe.jsonl"
  set -m
  ( cd "$RIG_BASE/workspace" && run_env codex "$ver_capture" "$CODEX_BIN" --version ) > "$stem.version" 2>&1 & ver_pid=$!
  set +m
  # 失敗した問い合わせの出力を版として扱わない。1 行だけ吐いて非ゼロで終える測定対象は、
  # そのエラー行がそのまま cliVersion として証拠に載り「この版で測った」と読めてしまう。
  # 畳むのが先。ここで抜けるときも残骸を置いていかない
  wait "$ver_pid" || ver_rc=$?
  reap_group "$ver_pid"
  # 問い合わせの記録は持ち込みの対象にしない。中身も残さない
  rm -f "$ver_capture" "$ver_capture.errors"
  [ "$ver_rc" -eq 0 ] || { echo "codex --version failed (exit=$ver_rc)" >&2; exit 1; }
  set -m
  ( cd "$RIG_BASE/workspace" && \
    run_env codex "$capture" timeout --foreground ${RUN_SIGNAL:+--signal=$RUN_SIGNAL} "${RUN_TIMEOUT:-300}" "$CODEX_BIN" exec --json --skip-git-repo-check \
      --dangerously-bypass-hook-trust "$@" "$prompt" \
      > "$stem.stdout" 2> "$stem.stderr" ) & run_pid=$!
  set +m
  wait "$run_pid" || rc=$?
  reap_group "$run_pid"
  # 終了コードは数値で別に残す。manifest の exitStatus はここから読む
  printf '%s\n' "$rc" > "$stem.exit"
  [ "$rc" -eq 0 ] || echo "exit=$rc (recorded)" >> "$stem.stderr"
  echo "captured: $capture ($(wc -l < "$capture") events)"
}

# 証拠置き場へ byte 同一で持ち込んでから digest を取る。持ち込む前に取ると、
# 持ち込みで内容が変わっても気づけない
import_evidence() {
  local cli="$1" label="$2" scenario="$3"
  # 記録中に読むと、途中までで一貫した prefix を掴んで正しく見える manifest を作る
  with_lock
  node --experimental-strip-types "$DIR/import-evidence.mjs" \
    --cli "$cli" --label "$label" --scenario-id "$scenario" --from "$RIG_BASE/capture"
}

case "${1:-}" in
  setup) setup ;;
  claude-run) shift; claude_run "$@" ;;
  codex-run) shift; codex_run "$@" ;;
  import) shift; import_evidence "$@" ;;
  teardown) rm -f "$RIG_BASE/claude-config/.credentials.json" "$RIG_BASE/codex-home/auth.json"; rm -rf "$RIG_BASE"; echo "rig removed" ;;
  *) echo "usage: rig.sh setup|claude-run <label> <prompt>|codex-run <label> <prompt>|import <cli> <label> <scenario-id>|teardown" >&2; exit 2 ;;
esac
