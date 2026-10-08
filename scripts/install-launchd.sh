#!/usr/bin/env bash
#
# Generate and (optionally) install the per-user LaunchAgents that run the
# collector every AUD_COLLECT_INTERVAL_MINUTES and, with --with-web, keep the
# loopback dashboard running. macOS only; the Linux path stays systemd.
#
# Nothing is installed or enabled without an explicit flag. The default run
# only renders the agents into launchd/generated/ so they can be read before
# anything touches ~/Library/LaunchAgents.
#
#   scripts/install-launchd.sh                 # render only (default)
#   scripts/install-launchd.sh --install       # render + copy into ~/Library/LaunchAgents
#   scripts/install-launchd.sh --install --enable
#   scripts/install-launchd.sh --install --enable --with-web   # also serve the dashboard
#   scripts/install-launchd.sh --status
#   scripts/install-launchd.sh --disable [--with-web]
#
# --label-prefix <prefix>  default io.github.baktiaditya.ai-usage-dashboard;
#                          derives <prefix>.collector and <prefix>.web
# --log-dir <absolute>     default ~/Library/Logs/ai-usage-dashboard
#
set -euo pipefail
# Case patterns and byte checks stay byte-exact regardless of the user's locale.
export LC_ALL=C

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
GEN_DIR="$WORKDIR/launchd/generated"
# Keep in step with src/lib/launchd-labels.ts; the shell cannot import TypeScript.
DEFAULT_LABEL_PREFIX="io.github.baktiaditya.ai-usage-dashboard"

LABEL_PREFIX=""
LABEL_PREFIX_SET=0
LOG_DIR=""
LOG_DIR_SET=0
do_install=0
do_enable=0
do_disable=0
do_status=0
do_web=0

usage() {
  cat <<'EOF'
usage: scripts/install-launchd.sh [--install] [--enable] [--disable [--with-web]]
                                   [--status] [--with-web]
                                   [--label-prefix <prefix>] [--log-dir <absolute-path>]

  (default)        render the LaunchAgents into launchd/generated/ and stop
  --install        copy them into ~/Library/LaunchAgents (0600), not enabled
  --enable         install, enable and start the agent(s)
  --disable        bootout then disable the agent(s); the plists stay in place
  --status         launchctl state, disabled override, and recent logs
  --with-web       include the dashboard web agent (requires `pnpm run build`)
  --label-prefix   default io.github.baktiaditya.ai-usage-dashboard
  --log-dir        absolute path; default ~/Library/Logs/ai-usage-dashboard
EOF
}

has_control_char() {
  [ "$(printf '%s' "$1" | tr -d '[:cntrl:]')" != "$1" ]
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install) do_install=1; shift ;;
    --enable)  do_install=1; do_enable=1; shift ;;
    --disable) do_disable=1; shift ;;
    --status)  do_status=1; shift ;;
    --with-web) do_web=1; shift ;;
    --label-prefix)
      if [ $# -lt 2 ]; then echo "--label-prefix requires a value" >&2; exit 2; fi
      LABEL_PREFIX="$2"; LABEL_PREFIX_SET=1; shift 2 ;;
    --log-dir)
      if [ $# -lt 2 ]; then echo "--log-dir requires a value" >&2; exit 2; fi
      LOG_DIR="$2"; LOG_DIR_SET=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- validate options before any filesystem or launchctl side effect ---------
if [ "$LABEL_PREFIX_SET" -eq 1 ]; then
  if [ -z "$LABEL_PREFIX" ]; then
    echo "--label-prefix must not be empty" >&2
    exit 2
  fi
  if has_control_char "$LABEL_PREFIX"; then
    echo "--label-prefix must not contain a control character" >&2
    exit 2
  fi
  case "$LABEL_PREFIX" in
    [A-Za-z0-9]*) ;;
    *) echo "--label-prefix must start with a letter or digit: $LABEL_PREFIX" >&2; exit 2 ;;
  esac
  case "$LABEL_PREFIX" in
    *[!A-Za-z0-9._-]*)
      echo "--label-prefix may only contain letters, digits, '.', '_' and '-': $LABEL_PREFIX" >&2
      exit 2 ;;
  esac
else
  LABEL_PREFIX="$DEFAULT_LABEL_PREFIX"
fi

if [ "$LOG_DIR_SET" -eq 1 ]; then
  if [ -z "$LOG_DIR" ]; then
    echo "--log-dir must not be empty" >&2
    exit 2
  fi
  case "$LOG_DIR" in
    /*) ;;
    *) echo "--log-dir must be an absolute path, since launchd does not expand '~': $LOG_DIR" >&2; exit 2 ;;
  esac
  if has_control_char "$LOG_DIR"; then
    echo "--log-dir must not contain a control character" >&2
    exit 2
  fi
else
  LOG_DIR="$HOME/Library/Logs/ai-usage-dashboard"
fi

# Derived once, then used for rendering, filenames, every lifecycle target and
# cleanup. No later step falls back to the production labels.
COLLECTOR_LABEL="${LABEL_PREFIX}.collector"
WEB_LABEL="${LABEL_PREFIX}.web"
COLLECTOR_FILE="${COLLECTOR_LABEL}.plist"
WEB_FILE="${WEB_LABEL}.plist"

# Resolved once from the invoking PATH, separately from the application PATH
# baked into the plists, so the integration tests can drive this script with a
# recording stub.
LAUNCHCTL="$(command -v launchctl 2>/dev/null || true)"
if [ -z "$LAUNCHCTL" ]; then
  echo "launchctl not found on PATH; this installer is macOS-only" >&2
  exit 1
fi
DOMAIN="gui/$(id -u)"

tail_agent_logs() {
  label="$1"
  if [ -f "$LOG_DIR/$label.out.log" ] || [ -f "$LOG_DIR/$label.err.log" ]; then
    tail -n 20 "$LOG_DIR/$label.out.log" "$LOG_DIR/$label.err.log" 2>/dev/null || true
  else
    echo "(no log files in $LOG_DIR yet)"
  fi
}

print_agent_status() {
  label="$1"
  echo "== $label =="
  echo "-- launchctl print $DOMAIN/$label"
  "$LAUNCHCTL" print "$DOMAIN/$label" 2>&1 || echo "(not loaded)"
  echo
  echo "-- disabled override"
  "$LAUNCHCTL" print-disabled "$DOMAIN" 2>/dev/null | grep -F "\"$label\"" || echo "(none recorded)"
  echo
  echo "-- recent logs"
  tail_agent_logs "$label"
  echo
  echo "If $label is not loaded, check System Settings > General > Login Items (& Extensions) > Allow in the Background, where macOS lists it and any user can switch it off. A switched-off agent does not run."
}

if [ "$do_status" -eq 1 ]; then
  print_agent_status "$COLLECTOR_LABEL"
  if [ -f "$AGENT_DIR/$WEB_FILE" ] || [ "$do_web" -eq 1 ]; then
    echo
    print_agent_status "$WEB_LABEL"
  fi
  exit 0
fi

disable_agent() {
  label="$1"
  # Stop it now; bootout fails harmlessly when the label is not loaded.
  "$LAUNCHCTL" bootout "$DOMAIN/$label" 2>/dev/null || true
  # Keep it unloaded across logins and reboots: the disabled state persists.
  "$LAUNCHCTL" disable "$DOMAIN/$label"
  echo "Disabled and stopped $label."
}

if [ "$do_disable" -eq 1 ]; then
  disable_agent "$COLLECTOR_LABEL"
  if [ "$do_web" -eq 1 ]; then
    disable_agent "$WEB_LABEL"
  fi
  echo "Plist files remain in $AGENT_DIR; delete them by hand to remove completely."
  exit 0
fi

# --- resolve absolute interpreter paths -------------------------------------
# A LaunchAgent inherits no shell PATH, so nvm-managed binaries must be baked in
# as absolute paths or the job fails to spawn.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
TSX_BIN="$WORKDIR/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX_BIN" ]; then
  echo "tsx not found at $TSX_BIN — run 'pnpm install' first" >&2
  exit 1
fi
# The web agent serves an existing production build and never builds at login.
if [ "$do_web" -eq 1 ] && [ "$do_install" -eq 1 ] && [ ! -f "$WORKDIR/.next/BUILD_ID" ]; then
  echo "no production build in $WORKDIR/.next — run 'pnpm run build' first; nothing was installed" >&2
  exit 1
fi

# Absolute interpreter paths are not sufficient on their own: the Codex adapter
# spawns `codex` by name, and an nvm-installed codex is a `#!/usr/bin/env node`
# script. Bake a PATH that reaches both, with Homebrew's prefix before the
# Intel/`/usr/local` one so the same architecture's runtime wins.
SERVICE_PATH="$(dirname "$NODE_BIN")"
CODEX_BIN="$(command -v codex 2>/dev/null || true)"
if [ -n "$CODEX_BIN" ]; then
  CODEX_DIR="$(dirname "$CODEX_BIN")"
  case ":$SERVICE_PATH:" in
    *":$CODEX_DIR:"*) ;;
    *) SERVICE_PATH="$SERVICE_PATH:$CODEX_DIR" ;;
  esac
else
  echo "warning: codex not found on PATH; the Codex card will read unavailable under the LaunchAgent until you install it and re-run this script" >&2
fi
SERVICE_PATH="$SERVICE_PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

# --- render -------------------------------------------------------------------
# The data directory, interval, environment file, host and port come from the
# collector's own configuration (shell exports, then collector.env, then
# defaults), and the renderer refuses protected locations before writing.
# Rendering both before installing either keeps the two agents consistent.
mkdir -p "$GEN_DIR"
if ! RESOLVED="$(
  AUD_UNIT_WORKDIR="$WORKDIR" \
  AUD_UNIT_PATH="$SERVICE_PATH" \
  AUD_UNIT_CODEXHOME="$CODEX_HOME_DIR" \
  AUD_UNIT_NODE="$NODE_BIN" \
  AUD_UNIT_TSX="$TSX_BIN" \
    "$NODE_BIN" "$TSX_BIN" "$WORKDIR/scripts/render-launchd-agents.ts" "$GEN_DIR" \
      --label-prefix "$LABEL_PREFIX" --log-dir "$LOG_DIR"
)"; then
  echo "nothing was installed" >&2
  exit 1
fi

{
  read -r ENV_FILE
  read -r DATA_DIR
  read -r INTERVAL
  read -r HOST
  read -r PORT
  read -r COLLECTOR_LABEL_RENDERED
  read -r COLLECTOR_FILE_RENDERED
  read -r WEB_LABEL_RENDERED
  read -r WEB_FILE_RENDERED
} <<<"$RESOLVED"

if [ "$COLLECTOR_LABEL_RENDERED" != "$COLLECTOR_LABEL" ] \
  || [ "$COLLECTOR_FILE_RENDERED" != "$COLLECTOR_FILE" ] \
  || [ "$WEB_LABEL_RENDERED" != "$WEB_LABEL" ] \
  || [ "$WEB_FILE_RENDERED" != "$WEB_FILE" ] \
  || [ ! -f "$GEN_DIR/$COLLECTOR_FILE" ] \
  || [ ! -f "$GEN_DIR/$WEB_FILE" ]; then
  echo "the renderer did not produce the agents this installer derived; nothing was installed" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"

echo "Rendered LaunchAgents into $GEN_DIR:"
echo "  $GEN_DIR/$COLLECTOR_FILE"
echo "  $GEN_DIR/$WEB_FILE"

if [ "$do_install" -eq 0 ]; then
  cat <<EOF

Nothing was installed (render-only is the default).
Data directory: $DATA_DIR (every ${INTERVAL}m)

Review the files above, then:
  scripts/install-launchd.sh --install          # copy into $AGENT_DIR
  scripts/install-launchd.sh --install --enable # copy, enable and start the collector agent
  add --with-web to also serve the dashboard on http://$HOST:$PORT/ at login
EOF
  exit 0
fi

# launchd creates a missing log file but not a missing directory: a job whose
# StandardOutPath directory is missing fails to spawn with last exit code 78
# (EX_CONFIG) and writes no log to explain it.
mkdir -p "$LOG_DIR"
chmod 0700 "$LOG_DIR"

mkdir -p "$AGENT_DIR"
install -m 0600 "$GEN_DIR/$COLLECTOR_FILE" "$AGENT_DIR/$COLLECTOR_FILE"
if [ "$do_web" -eq 1 ]; then
  install -m 0600 "$GEN_DIR/$WEB_FILE" "$AGENT_DIR/$WEB_FILE"
fi
echo "Installed into $AGENT_DIR."

if [ ! -f "$ENV_FILE" ]; then
  cat <<EOF

Note: $ENV_FILE does not exist yet, and that is fine.
DeepSeek and OpenRouter keys are saved in dashboard Settings, not in this file;
the file holds only optional AUD_* overrides. To add some:

  mkdir -p "\$(dirname "$ENV_FILE")"
  install -m 0600 /dev/null "$ENV_FILE"
  \$EDITOR "$ENV_FILE"     # AUD_TIMEZONE=..., AUD_LOG_LEVEL=...
EOF
fi

enable_agent() {
  label="$1"
  plist="$2"

  # A disabled service cannot be bootstrapped, and launchd reports that only as
  # "Bootstrap failed: 5: Input/output error"; enable first.
  "$LAUNCHCTL" enable "$DOMAIN/$label"

  if "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
    # bootout returns once launchd accepts the request, not once the label is
    # gone. Bootstrapping mid-teardown fails with the same error 5 and can
    # leave nothing loaded, so wait, bounded, for print to stop finding it.
    "$LAUNCHCTL" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    waited=0
    while [ "$waited" -lt 6 ]; do
      if ! "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
      waited=$((waited + 1))
    done
    if "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
      echo "$label is still loaded after bootout; launchd did not release it" >&2
      exit 1
    fi
  fi

  attempt=1
  while :; do
    if err="$("$LAUNCHCTL" bootstrap "$DOMAIN" "$plist" 2>&1)"; then
      break
    fi
    case "$err" in
      *"Bootstrap failed: 5:"*)
        if [ "$attempt" -ge 5 ]; then
          echo "bootstrap of $label failed: $err" >&2
          exit 1
        fi
        attempt=$((attempt + 1))
        sleep 0.5
        ;;
      *)
        echo "bootstrap of $label failed: $err" >&2
        exit 1
        ;;
    esac
  done

  if ! "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
    echo "$label is not loaded after bootstrap" >&2
    exit 1
  fi
  echo "Enabled and started $label."
}

if [ "$do_enable" -eq 0 ]; then
  # launchd loads every plist in ~/Library/LaunchAgents at the next login unless
  # its label is disabled. Disabling each installed label keeps the systemd
  # meaning of "installed but not enabled".
  "$LAUNCHCTL" disable "$DOMAIN/$COLLECTOR_LABEL"
  if [ "$do_web" -eq 1 ]; then
    "$LAUNCHCTL" disable "$DOMAIN/$WEB_LABEL"
  fi
  cat <<EOF

Not enabled. The installed labels were disabled so launchd will not load them
at the next login. To start collecting now:

  scripts/install-launchd.sh --enable [--with-web]

To check on it later:
  scripts/install-launchd.sh --status
EOF
  exit 0
fi

enable_agent "$COLLECTOR_LABEL" "$AGENT_DIR/$COLLECTOR_FILE"

if [ "$do_web" -eq 1 ]; then
  enable_agent "$WEB_LABEL" "$AGENT_DIR/$WEB_FILE"
  # Restart, not just load: a re-install must pick up the new build.
  "$LAUNCHCTL" kickstart -k "$DOMAIN/$WEB_LABEL"
  echo
  echo "Enabled and started $WEB_LABEL on http://$HOST:$PORT/."
  echo "After pulling changes: pnpm run build && scripts/install-launchd.sh --enable --with-web"
fi

echo
echo "launchd starts the next interval run after wake; a firing that fell while the Mac was asleep is missed, not coalesced."
echo "launchd has no restart cap for the web agent: if it crashes on every start it is respawned indefinitely."
