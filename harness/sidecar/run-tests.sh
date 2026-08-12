#!/usr/bin/env bash
# supervisor の §13.6 要件を stub subprocess で実証する self-check (資格情報不要・不活性)。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUP="$DIR/supervisor.sh"; STUB="$DIR/stub-misbehaver.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0
chk(){ if [ "$1" = ok ]; then echo "PASS: $2"; else echo "FAIL: $2"; fails=$((fails+1)); fi }

# 1) normal: rc=0, JSON 出力, 残存なし
out="$T/normal.out"; DEADLINE=10 "$SUP" "$out" "$STUB" normal > "$T/normal.sup"; rc=$?
grep -q '"ok":true' "$out" && [ $rc -eq 0 ] && grep -q 'survivors=\[\]' "$T/normal.sup" && chk ok "normal run" || chk no "normal run"

# 2) hang: deadline で刈られ rc=71, 残存なし
out="$T/hang.out"; DEADLINE=3 "$SUP" "$out" "$STUB" hang > "$T/hang.sup"; rc=$?
[ $rc -eq 71 ] && grep -q 'timedOut=1' "$T/hang.sup" && grep -q 'survivors=\[\]' "$T/hang.sup" && chk ok "hang killed at deadline" || chk no "hang killed at deadline"

# 3) SIGTERM 無視でも KILL 昇格で死ぬ
out="$T/it.out"; DEADLINE=3 "$SUP" "$out" "$STUB" ignore-term > "$T/it.sup"; rc=$?
[ $rc -eq 71 ] && grep -q 'survivors=\[\]' "$T/it.sup" && chk ok "ignore-term killed via KILL escalation" || chk no "ignore-term killed via KILL escalation"

# 4) TERM 無視の孫プロセス込みで process-group kill が全滅させる
out="$T/od.out"; DEADLINE=3 "$SUP" "$out" "$STUB" orphan-descendants > "$T/od.sup"; rc=$?
grep -q 'survivors=\[\]' "$T/od.sup" && chk ok "descendants killed by group kill" || chk no "descendants killed by group kill"

# 5) 切断 JSON は parser がハングせずエラーとして表面化する
out="$T/tj.out"; DEADLINE=10 "$SUP" "$out" "$STUB" truncated-json > "$T/tj.sup"; rc=$?
node -e 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(1)}catch{process.exit(0)}' "$out" \
  && chk ok "truncated JSON surfaces as parse error" || chk no "truncated JSON surfaces as parse error"

echo "---"
if [ $fails -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
