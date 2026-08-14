#!/usr/bin/env bash
set -u

print_continue() {
  printf '%s\n' '{"continue":true}'
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v node >/dev/null 2>&1 && [ -r "${SCRIPT_DIR}/hook-runtime.mjs" ]; then
  exec node "${SCRIPT_DIR}/hook-runtime.mjs" claude-hook-file-context
fi

payload="$(cat)"
if [ -z "${payload}" ]; then
  print_continue
  exit 0
fi

case "${CODEMEM_PLUGIN_IGNORE:-}" in
  "1"|"true"|"yes"|"on")
    print_continue
    exit 0
    ;;
esac

if command -v codemem >/dev/null 2>&1; then
  if printf '%s' "${payload}" | codemem claude-hook-file-context; then
    exit 0
  fi
fi

if command -v npx >/dev/null 2>&1; then
  if printf '%s' "${payload}" | npx -y codemem claude-hook-file-context; then
    exit 0
  fi
fi

print_continue
