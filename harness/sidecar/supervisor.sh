#!/usr/bin/env bash
# §13.6 external supervisor — sidecar subprocess を隔離実行する。
#   - hard deadline (DEADLINE 秒、既定 20)
#   - 専用 process group で起動し、期限超過/終了後に group 全体へ TERM → KILL
#   - stdout は上限 (CAP bytes、既定 1MiB) まで取り込み、pipe close
#   - wait/reap + 残存 descendant 検査 (結果を stdout 最終行 SUPERVISOR: で報告)
# 使い方: supervisor.sh <out-file> <cmd...>   (stdin は /dev/null)
set -u
OUT="${1:?out-file}"; shift
DEADLINE="${DEADLINE:-20}"
CAP="${CAP:-1048576}"

setsid "$@" < /dev/null > >(head -c "$CAP" > "$OUT") 2> "$OUT.err" &
PID=$!
PGID="$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')"

end=$(( $(date +%s) + DEADLINE ))
while kill -0 "$PID" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 0.2; done

TIMED_OUT=0
if kill -0 "$PID" 2>/dev/null; then
  TIMED_OUT=1
  kill -TERM -- "-$PGID" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
  kill -KILL -- "-$PGID" 2>/dev/null
fi
wait "$PID" 2>/dev/null; RC=$?

# reap 後の残存 descendant 検査 (同一 PGID の生存プロセス)
sleep 0.3
SURV="$(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$PGID" '$2==g{print $1}' | tr '\n' ' ')"
if [ -n "${SURV// /}" ]; then
  kill -KILL -- "-$PGID" 2>/dev/null   # fail-closed: 検出したら必ず刈る
  echo "SUPERVISOR: rc=$RC timedOut=$TIMED_OUT survivors=[${SURV% }] (killed)"
  exit 70
fi
echo "SUPERVISOR: rc=$RC timedOut=$TIMED_OUT survivors=[]"
[ "$TIMED_OUT" -eq 1 ] && exit 71
exit "$RC"
