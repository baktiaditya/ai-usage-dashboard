#!/usr/bin/env bash
#
# Generate and (optionally) install the user-level collector service + timer,
# and, with --with-web, the dashboard web server.
#
# Nothing is installed or enabled without an explicit flag. The default run only
# renders the units into systemd/generated/ so they can be read before anything
# touches ~/.config/systemd/user.
#
#   scripts/install-systemd.sh                 # render only (default)
#   scripts/install-systemd.sh --install       # render + copy into ~/.config/systemd/user
#   scripts/install-systemd.sh --install --enable
#   scripts/install-systemd.sh --install --enable --with-web   # also serve the dashboard
#   scripts/install-systemd.sh --status
#   scripts/install-systemd.sh --disable [--with-web]
#
set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
GEN_DIR="$WORKDIR/systemd/generated"

SERVICE="ai-usage-dashboard-collector.service"
TIMER="ai-usage-dashboard-collector.timer"
WEB="ai-usage-dashboard-web.service"

do_install=0
do_enable=0
do_disable=0
do_status=0
do_web=0

for arg in "$@"; do
  case "$arg" in
    --install) do_install=1 ;;
    --enable)  do_install=1; do_enable=1 ;;
    --disable) do_disable=1 ;;
    --status)  do_status=1 ;;
    --with-web) do_web=1 ;;
    -h|--help)
      sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  if [[ -f "$UNIT_DIR/$WEB" ]]; then
    echo
    systemctl --user status "$WEB" --no-pager || true
  fi
  exit 0
fi

if [[ $do_disable -eq 1 ]]; then
  systemctl --user disable --now "$TIMER" 2>/dev/null || true
  echo "Disabled and stopped $TIMER."
  if [[ $do_web -eq 1 ]]; then
    systemctl --user disable --now "$WEB" 2>/dev/null || true
    echo "Disabled and stopped $WEB."
  fi
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
# The web unit serves an existing production build and never builds at boot.
if [[ $do_web -eq 1 && $do_install -eq 1 && ! -f "$WORKDIR/.next/BUILD_ID" ]]; then
  echo "no production build in $WORKDIR/.next — run 'npm run build' first; nothing was installed" >&2
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

# --- render -------------------------------------------------------------------
# The data directory, interval and environment file come from the collector's
# own configuration (shell exports, then collector.env, then defaults), not from
# this shell alone: a value set only in collector.env would otherwise leave the
# sandbox writable at one path while the collector writes to another. Rendering
# is a literal substitution escaped for systemd, so a path containing `&`, `|`
# or `%` reaches the unit unchanged, and one systemd cannot carry is refused.
mkdir -p "$GEN_DIR"
if ! RESOLVED="$(
  AUD_UNIT_WORKDIR="$WORKDIR" \
  AUD_UNIT_PATH="$SERVICE_PATH" \
  AUD_UNIT_CODEXHOME="$CODEX_HOME_DIR" \
  AUD_UNIT_NODE="$NODE_BIN" \
  AUD_UNIT_TSX="$TSX_BIN" \
    "$NODE_BIN" "$TSX_BIN" "$WORKDIR/scripts/render-systemd-units.ts" "$GEN_DIR"
)"; then
  echo "nothing was installed" >&2
  exit 1
fi
{ read -r ENV_FILE; read -r DATA_DIR; read -r INTERVAL; read -r HOST; read -r PORT; } <<<"$RESOLVED"

mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"

echo "Rendered units into $GEN_DIR:"
echo "  $GEN_DIR/$SERVICE"
echo "  $GEN_DIR/$TIMER"
echo "  $GEN_DIR/$WEB"

if [[ $do_install -eq 0 ]]; then
  cat <<EOF

Nothing was installed (render-only is the default).
Data directory: $DATA_DIR (every ${INTERVAL}m)

Review the files above, then:
  scripts/install-systemd.sh --install          # copy into $UNIT_DIR
  scripts/install-systemd.sh --install --enable # copy, enable and start the timer
  add --with-web to also serve the dashboard on http://$HOST:$PORT/ at boot
EOF
  exit 0
fi

mkdir -p "$UNIT_DIR"
install -m 0600 "$GEN_DIR/$SERVICE" "$UNIT_DIR/$SERVICE"
install -m 0600 "$GEN_DIR/$TIMER"   "$UNIT_DIR/$TIMER"
[[ $do_web -eq 1 ]] && install -m 0600 "$GEN_DIR/$WEB" "$UNIT_DIR/$WEB"
systemctl --user daemon-reload
echo "Installed into $UNIT_DIR."

if [[ ! -f "$ENV_FILE" ]]; then
  cat <<EOF

Note: $ENV_FILE does not exist yet, and that is fine.
DeepSeek and OpenRouter keys are saved in dashboard Settings, not in this file;
the file holds only optional AUD_* overrides. To add some:

  mkdir -p "\$(dirname "$ENV_FILE")"
  install -m 0600 /dev/null "$ENV_FILE"
  \$EDITOR "$ENV_FILE"     # AUD_TIMEZONE=..., AUD_LOG_LEVEL=...
EOF
fi

if [[ $do_enable -eq 1 ]]; then
  systemctl --user enable --now "$TIMER"
  echo
  echo "Enabled and started $TIMER (every ${INTERVAL}m)."
  echo "Linger keeps it running after logout: loginctl enable-linger \$USER"
  echo "Re-run this installer after changing AUD_DATA_DIR, AUD_COLLECT_INTERVAL_MINUTES, AUD_HOST or AUD_PORT."
  systemctl --user list-timers "$TIMER" --no-pager || true

  if [[ $do_web -eq 1 ]]; then
    # Another process on the port (a `npm run dev` left running) would make the
    # service crash-loop into its start limit; say so instead.
    if ! systemctl --user is-active --quiet "$WEB" \
      && [[ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]]; then
      echo "port $PORT is already in use by another process; stop it, then run:" >&2
      echo "  systemctl --user enable --now $WEB" >&2
      exit 1
    fi
    systemctl --user enable "$WEB"
    # restart, not start: a re-install must pick up the new unit and build.
    systemctl --user restart "$WEB"
    echo
    echo "Enabled and started $WEB on http://$HOST:$PORT/."
    echo "After pulling changes: npm run build && systemctl --user restart $WEB"
  fi
else
  cat <<EOF

Not enabled. To start collecting:
  systemctl --user enable --now $TIMER
$([[ $do_web -eq 1 ]] && echo "  systemctl --user enable --now $WEB")

To check on it later:
  scripts/install-systemd.sh --status
EOF
fi
