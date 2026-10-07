#!/usr/bin/env bash
#
# Recording launchctl stub for tests/integration/install-launchd.test.ts.
#
# It is not a launchctl implementation. Every invocation is appended to
# $AUD_LAUNCHCTL_STUB_DIR/calls.log, and the lifecycle state tests care about is
# held in marker files in the same directory:
#
#   loaded.<label>              the label is loaded (print succeeds)
#   disabled.<label>            the label has a disabled override
#   bootstrap-failures          remaining error-5 failures for bootstrap
#   bootstrap-initialised       the counter above was seeded from the environment
#
# Controllable behavior, all optional:
#
#   AUD_LAUNCHCTL_STUB_BOOTSTRAP_FAILURES=<n>  fail the first n bootstraps with
#                                              error 5, then succeed
#   AUD_LAUNCHCTL_STUB_BOOTSTRAP_ALWAYS_FAILS=1 exit 5 on every bootstrap
#   AUD_LAUNCHCTL_STUB_BOOTSTRAP_IGNORES=1     bootstrap "succeeds" but loads nothing
#   AUD_LAUNCHCTL_STUB_BOOTOUT_STICKS=1        bootout exits 0 but never unloads
#
set -euo pipefail

STUB_DIR="${AUD_LAUNCHCTL_STUB_DIR:?AUD_LAUNCHCTL_STUB_DIR is required}"
mkdir -p "$STUB_DIR"
printf '%s\n' "$*" >>"$STUB_DIR/calls.log"

label_of_target() {
  printf '%s' "${1##*/}"
}

loaded_path() {
  printf '%s/loaded.%s' "$STUB_DIR" "$1"
}

disabled_path() {
  printf '%s/disabled.%s' "$STUB_DIR" "$1"
}

label_from_plist() {
  awk '/<key>Label<\/key>/{getline; sub(/.*<string>/,""); sub(/<\/string>.*/,""); print; exit}' "$1"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  print)
    target="${1:-}"
    label="$(label_of_target "$target")"
    if [ -f "$(loaded_path "$label")" ]; then
      printf '%s = {\n\tstate = running\n}\n' "$target"
      exit 0
    fi
    printf 'Could not find service "%s" in domain for user gui\n' "$label" >&2
    exit 113
    ;;

  print-disabled)
    for marker in "$STUB_DIR"/disabled.*; do
      [ -f "$marker" ] || continue
      label="${marker##*/disabled.}"
      printf '\t"%s" => disabled\n' "$label"
    done
    for marker in "$STUB_DIR"/loaded.*; do
      [ -f "$marker" ] || continue
      label="${marker##*/loaded.}"
      if [ ! -f "$(disabled_path "$label")" ]; then
        printf '\t"%s" => enabled\n' "$label"
      fi
    done
    exit 0
    ;;

  enable)
    label="$(label_of_target "${1:-}")"
    rm -f "$(disabled_path "$label")"
    exit 0
    ;;

  disable)
    label="$(label_of_target "${1:-}")"
    : >"$(disabled_path "$label")"
    exit 0
    ;;

  bootstrap)
    plist="${2:-}"
    label="$(label_from_plist "$plist")"

    remaining=0
    if [ -f "$STUB_DIR/bootstrap-failures" ]; then
      remaining="$(cat "$STUB_DIR/bootstrap-failures")"
    fi
    if [ -n "${AUD_LAUNCHCTL_STUB_BOOTSTRAP_FAILURES:-}" ] && [ ! -f "$STUB_DIR/bootstrap-initialised" ]; then
      remaining="$AUD_LAUNCHCTL_STUB_BOOTSTRAP_FAILURES"
      : >"$STUB_DIR/bootstrap-initialised"
    fi

    if [ "${AUD_LAUNCHCTL_STUB_BOOTSTRAP_ALWAYS_FAILS:-0}" = "1" ]; then
      printf 'Bootstrap failed: 5: Input/output error\n' >&2
      exit 5
    fi
    if [ "$remaining" -gt 0 ] 2>/dev/null; then
      printf '%s' "$((remaining - 1))" >"$STUB_DIR/bootstrap-failures"
      printf 'Bootstrap failed: 5: Input/output error\n' >&2
      exit 5
    fi
    if [ "${AUD_LAUNCHCTL_STUB_BOOTSTRAP_IGNORES:-0}" = "1" ]; then
      exit 0
    fi
    : >"$(loaded_path "$label")"
    exit 0
    ;;

  bootout)
    target="${1:-}"
    label="$(label_of_target "$target")"
    if [ "${AUD_LAUNCHCTL_STUB_BOOTOUT_STICKS:-0}" = "1" ]; then
      exit 0
    fi
    if [ -f "$(loaded_path "$label")" ]; then
      rm -f "$(loaded_path "$label")"
      exit 0
    fi
    printf 'Boot-out failed: 3: No such process\n' >&2
    exit 3
    ;;

  kickstart)
    # kickstart [-k] <service>
    target=""
    for arg in "$@"; do
      target="$arg"
    done
    label="$(label_of_target "$target")"
    if [ -f "$(loaded_path "$label")" ]; then
      exit 0
    fi
    printf 'Could not find service "%s" in domain for user gui\n' "$label" >&2
    exit 113
    ;;

  *)
    printf 'launchctl-stub: unsupported command: %s\n' "$cmd" >&2
    exit 64
    ;;
esac
