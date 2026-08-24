#!/usr/bin/env bash
# Bound the only service-interrupting part of a prepared GBrain maintenance.

set -euo pipefail

readonly POSTGRES_SERVICE='gbrain-postgres.service'
readonly HTTP_SERVICE='gbrain-http.service'
readonly AUTOPILOT_SERVICE='gbrain-autopilot.service'
readonly HEALTH_URL='http://127.0.0.1:3131/health'
readonly HEALTH_ATTEMPTS=30

timeout_seconds=60
restoration_required=0

usage() {
  cat >&2 <<'EOF'
Usage: scripts/gbrain-cutover.sh [--timeout-seconds SECONDS] -- COMMAND [ARG...]

COMMAND must be a prepared transactional cutover or provide its own rollback.
SECONDS must be an integer from 1 through 3600 (default: 60).
EOF
}

fail_usage() {
  echo "gbrain-cutover: $1" >&2
  usage
  exit 64
}

while (( $# > 0 )); do
  case "$1" in
    --timeout-seconds)
      (( $# >= 2 )) || fail_usage '--timeout-seconds requires a value'
      timeout_seconds="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      fail_usage 'command must follow --'
      ;;
  esac
done

(( $# > 0 )) || fail_usage 'command must follow --'
[[ "$timeout_seconds" =~ ^[1-9][0-9]{0,3}$ ]] || fail_usage 'timeout must be an integer from 1 through 3600'
(( timeout_seconds <= 3600 )) || fail_usage 'timeout must be an integer from 1 through 3600'

for dependency in systemctl curl timeout; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "gbrain-cutover: required command not found: $dependency" >&2
    exit 1
  }
done

require_active() {
  local service="$1"
  if ! systemctl --user is-active --quiet "$service"; then
    echo "gbrain-cutover: preflight failed: $service is not active" >&2
    exit 1
  fi
}

require_active "$POSTGRES_SERVICE"
require_active "$HTTP_SERVICE"
require_active "$AUTOPILOT_SERVICE"
if ! curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null; then
  echo "gbrain-cutover: preflight failed: local health is not ready at $HEALTH_URL" >&2
  exit 1
fi

restore_services() {
  local original_status="$1"
  local restore_status=0
  local health_ready=0

  trap - EXIT INT TERM
  set +e

  if (( restoration_required == 1 )); then
    systemctl --user start "$HTTP_SERVICE" || restore_status=1
    systemctl --user start "$AUTOPILOT_SERVICE" || restore_status=1

    for (( attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++ )); do
      if curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null; then
        health_ready=1
        break
      fi
      sleep 1
    done

    if (( health_ready == 0 )); then
      echo "gbrain-cutover: restoration failed: local health did not recover" >&2
      restore_status=1
    fi
    if ! systemctl --user is-active --quiet "$AUTOPILOT_SERVICE"; then
      echo "gbrain-cutover: restoration failed: $AUTOPILOT_SERVICE is not active" >&2
      restore_status=1
    fi
  fi

  if (( original_status == 0 && restore_status != 0 )); then
    original_status=1
  fi
  if (( original_status == 0 )); then
    echo 'gbrain-cutover: cutover complete; HTTP, autopilot, and local health restored'
  fi
  exit "$original_status"
}

trap 'restore_services $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

restoration_required=1
if ! systemctl --user stop "$AUTOPILOT_SERVICE"; then
  echo "gbrain-cutover: failed to stop $AUTOPILOT_SERVICE" >&2
  exit 1
fi
if ! systemctl --user stop "$HTTP_SERVICE"; then
  echo "gbrain-cutover: failed to stop $HTTP_SERVICE" >&2
  exit 1
fi

set +e
timeout --foreground --kill-after=5s "${timeout_seconds}s" "$@"
command_status=$?
set -e

if (( command_status == 124 )); then
  echo "gbrain-cutover: cutover command timed out after $timeout_seconds seconds" >&2
elif (( command_status != 0 )); then
  echo "gbrain-cutover: cutover command failed with exit $command_status" >&2
fi

exit "$command_status"
