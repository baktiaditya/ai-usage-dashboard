#!/usr/bin/env bash
#
# Generate and (optionally) install the user-level collector service + timer.
#
# Nothing is installed or enabled without an explicit flag. The default run only
# renders the units into systemd/generated/ so they can be read before anything
# touches ~/.config/systemd/user.
#
#   scripts/install-systemd.sh                 # render only (default)
#   scripts/install-systemd.sh --install       # render + copy into ~/.config/systemd/user
#   scripts/install-systemd.sh --install --enable
#   scripts/install-systemd.sh --status
#   scripts/install-systemd.sh --disable
#
set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
GEN_DIR="$WORKDIR/systemd/generated"
DATA_DIR="${AUD_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ai-usage-dashboard}"
ENV_FILE="${AUD_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-usage-dashboard/collector.env}"
INTERVAL="${AUD_COLLECT_INTERVAL_MINUTES:-5}"

SERVICE="ai-usage-dashboard-collector.service"
TIMER="ai-usage-dashboard-collector.timer"

do_install=0
do_enable=0
do_disable=0
do_status=0

for arg in "$@"; do
  case "$arg" in
    --install) do_install=1 ;;
    --enable)  do_install=1; do_enable=1 ;;
    --disable) do_disable=1 ;;
    --status)  do_status=1 ;;
    -h|--help)
      sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ $do_status -eq 1 ]]; then
  systemctl --user status "$TIMER" --no-pager || true
  echo
  systemctl --user list-timers "$TIMER" --no-pager || true
  echo
  echo "Recent collector logs:"
  journalctl --user -u "$SERVICE" -n 20 --no-pager || true
  exit 0
fi

if [[ $do_disable -eq 1 ]]; then
  systemctl --user disable --now "$TIMER" 2>/dev/null || true
  echo "Disabled and stopped $TIMER."
  echo "Unit files remain in $UNIT_DIR; delete them by hand to remove completely."
  exit 0
fi

# --- resolve absolute interpreter paths -------------------------------------
# A user service does not inherit the shell's PATH, so nvm-managed binaries must
# be baked in as absolute paths or ExecStart fails with status=203/EXEC.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi
TSX_BIN="$WORKDIR/node_modules/tsx/dist/cli.mjs"
if [[ ! -f "$TSX_BIN" ]]; then
  echo "tsx not found at $TSX_BIN — run 'npm install' first" >&2
  exit 1
fi

# Absolute interpreter paths are not sufficient on their own: the Codex adapter
# spawns `codex` by name, and an nvm-installed codex is a `#!/usr/bin/env node`
# script. Bake a PATH that reaches both into the unit.
SERVICE_PATH="$(dirname "$NODE_BIN")"
CODEX_BIN="$(command -v codex || true)"
if [[ -n "$CODEX_BIN" ]]; then
  CODEX_DIR="$(dirname "$CODEX_BIN")"
  [[ ":$SERVICE_PATH:" == *":$CODEX_DIR:"* ]] || SERVICE_PATH="$SERVICE_PATH:$CODEX_DIR"
else
  echo "warning: codex not found on PATH; the Codex card will report an error under the timer" >&2
fi
SERVICE_PATH="$SERVICE_PATH:/usr/local/bin:/usr/bin:/bin"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

mkdir -p "$GEN_DIR" "$DATA_DIR"
chmod 0700 "$DATA_DIR"

render() {
  sed \
    -e "s|__WORKDIR__|$WORKDIR|g" \
    -e "s|__PATH__|$SERVICE_PATH|g" \
    -e "s|__CODEXHOME__|$CODEX_HOME_DIR|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__TSX__|$TSX_BIN|g" \
    -e "s|__DATADIR__|$DATA_DIR|g" \
    -e "s|__ENVFILE__|$ENV_FILE|g" \
    -e "s|__INTERVAL__|$INTERVAL|g" \
    "$1"
}

render "$WORKDIR/systemd/$SERVICE.template" > "$GEN_DIR/$SERVICE"
render "$WORKDIR/systemd/$TIMER.template"   > "$GEN_DIR/$TIMER"
chmod 0600 "$GEN_DIR/$SERVICE" "$GEN_DIR/$TIMER"

echo "Rendered units into $GEN_DIR:"
echo "  $GEN_DIR/$SERVICE"
echo "  $GEN_DIR/$TIMER"

if [[ $do_install -eq 0 ]]; then
  cat <<EOF

Nothing was installed (render-only is the default).

Review the files above, then:
  scripts/install-systemd.sh --install          # copy into $UNIT_DIR
  scripts/install-systemd.sh --install --enable # copy, enable and start the timer
EOF
  exit 0
fi

mkdir -p "$UNIT_DIR"
install -m 0600 "$GEN_DIR/$SERVICE" "$UNIT_DIR/$SERVICE"
install -m 0600 "$GEN_DIR/$TIMER"   "$UNIT_DIR/$TIMER"
systemctl --user daemon-reload
echo "Installed into $UNIT_DIR."

if [[ ! -f "$ENV_FILE" ]]; then
  cat <<EOF

Note: $ENV_FILE does not exist yet.
The collector will still run; DeepSeek and OpenRouter will report "unavailable"
until you create it:

  mkdir -p "\$(dirname "$ENV_FILE")"
  install -m 0600 /dev/null "$ENV_FILE"
  \$EDITOR "$ENV_FILE"     # DEEPSEEK_API_KEY=... / OPENROUTER_MANAGEMENT_KEY=...
EOF
fi

if [[ $do_enable -eq 1 ]]; then
  systemctl --user enable --now "$TIMER"
  echo
  echo "Enabled and started $TIMER (every ${INTERVAL}m)."
  echo "Linger keeps it running after logout: loginctl enable-linger \$USER"
  systemctl --user list-timers "$TIMER" --no-pager || true
else
  cat <<EOF

Not enabled. To start collecting:
  systemctl --user enable --now $TIMER

To check on it later:
  scripts/install-systemd.sh --status
EOF
fi
