#!/usr/bin/env bash
# Inert crontab substitute for scheduler tests. Never invokes the OS scheduler.
set -euo pipefail
: "${GBRAIN_TEST_CRONTAB_DIR:?isolated test scheduler state required}"
mkdir -p "$GBRAIN_TEST_CRONTAB_DIR"
key=$(printf '%s' "${HOME:?test HOME required}" | cksum | awk '{print $1}')
file="$GBRAIN_TEST_CRONTAB_DIR/$key"
case "${1:-}" in
  -l) [[ -f "$file" ]] || exit 1; cat "$file" ;;
  -) cat > "$file" ;;
  -r) if [[ -f "$file" ]]; then mv "$file" "$file.removed"; fi ;;
  *) echo 'test crontab: unsupported arguments' >&2; exit 64 ;;
esac
