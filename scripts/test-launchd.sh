#!/usr/bin/env bash
#
# Live macOS harness for the launchd agents: drives the real
# scripts/install-launchd.sh against real launchctl with a disposable,
# uniquely-named fixture, and inspects the result.
#
#   scripts/test-launchd.sh                 # full technical checks, then cleanup
#   scripts/test-launchd.sh --keep-fixture  # same checks; retain the fixture and
#                                           # print the manual session checklist
#
# It never touches the production labels or the production database. Every
# lifecycle operation goes through the installer with the same isolation
# options; direct `launchctl print` calls only inspect evidence. Requires a
# production build (`pnpm run build`) for the with-web agent.
#
# The manual session checklist (sleep/wake, logout/login, Login Items, Codex
# credential store) is user-assisted and printed by --keep-fixture.
set -euo pipefail

KEEP_FIXTURE=0
for arg in "$@"; do
  case "$arg" in
    --keep-fixture) KEEP_FIXTURE=1 ;;
    -h|--help)
      sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "scripts/test-launchd.sh drives real launchd and runs on macOS only (got $(uname -s))" >&2
  exit 1
fi

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$WORKDIR/scripts/install-launchd.sh"
GEN_DIR="$WORKDIR/launchd/generated"
AGENT_DIR="$HOME/Library/LaunchAgents"

if [ ! -f "$WORKDIR/.next/BUILD_ID" ]; then
  echo "no production build in $WORKDIR/.next — run 'pnpm run build' first" >&2
  exit 1
fi

RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
PREFIX="io.github.baktiaditya.ai-usage-dashboard.test.$RUN_ID"
COLLECTOR_LABEL="$PREFIX.collector"
WEB_LABEL="$PREFIX.web"
COLLECTOR_PLIST="$COLLECTOR_LABEL.plist"
WEB_PLIST="$WEB_LABEL.plist"

FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/aud-launchd-test.XXXXXX")"
DATA_DIR="$FIXTURE/data"
ENV_FILE="$FIXTURE/collector.env"
LOG_DIR="$FIXTURE/logs"
BACKUP="$FIXTURE/usage-backup.db"
CURRENT_UID="$(id -u)"
DOMAIN="gui/$CURRENT_UID"
PORT="$(node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')"

mkdir -p "$DATA_DIR" "$LOG_DIR"
chmod 0700 "$FIXTURE" "$DATA_DIR"
: >"$ENV_FILE"
chmod 0600 "$ENV_FILE"

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
note() { printf 'ok: %s\n' "$1"; }

# Every installer invocation carries the same isolation options and environment.
run_installer() {
  AUD_DATA_DIR="$DATA_DIR" AUD_ENV_FILE="$ENV_FILE" AUD_PORT="$PORT" \
    bash "$INSTALLER" --label-prefix "$PREFIX" --log-dir "$LOG_DIR" "$@"
}

run_db() {
  AUD_DATA_DIR="$DATA_DIR" AUD_ENV_FILE="$ENV_FILE" pnpm run "$@"
}

assert_loaded() {
  if ! launchctl print "$DOMAIN/$1" >/dev/null 2>&1; then fail "$1 is not loaded"; fi
  note "$1 is loaded"
}

assert_not_loaded() {
  if launchctl print "$DOMAIN/$1" >/dev/null 2>&1; then fail "$1 is unexpectedly loaded"; fi
  note "$1 is not loaded"
}

# bootout returns once launchd accepts the request, not once the label is gone;
# poll briefly to observe the eventual state.
wait_until_not_loaded() {
  i=0
  while [ "$i" -lt 20 ]; do
    if ! launchctl print "$DOMAIN/$1" >/dev/null 2>&1; then
      note "$1 unloaded"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  fail "$1 is still loaded after --disable"
}

assert_file_mode() {
  actual="$(stat -f '%Lp' "$1")"
  if [ "$actual" != "$2" ]; then fail "$1 has mode $actual, expected $2"; fi
  note "$1 is mode $2"
}

count_runs() {
  node -e 'const Database = require(process.argv[1]); const db = new Database(process.argv[2], { readonly: true, fileMustExist: true }); try { console.log(db.prepare("SELECT COUNT(*) AS c FROM collector_runs").get().c); } finally { db.close(); }' \
    "$WORKDIR/node_modules/better-sqlite3" "$DATA_DIR/usage.db"
}

wait_for_runs() {
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -f "$DATA_DIR/usage.db" ]; then
      runs="$(count_runs 2>/dev/null || echo 0)"
      case "$runs" in
        ''|0|*[!0-9]*) ;;
        *) note "$runs collector run(s) recorded in the disposable database"; return 0 ;;
      esac
    fi
    sleep 1
    i=$((i + 1))
  done
  fail "no collector run appeared within 60s; see $LOG_DIR"
}

wait_for_web() {
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
      note "dashboard answered on http://127.0.0.1:$PORT/"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  fail "dashboard did not answer on 127.0.0.1:$PORT within 60s; see $LOG_DIR"
}

cleanup() {
  if [ "$KEEP_FIXTURE" -eq 1 ]; then
    return 0
  fi
  # Disable only this run's labels, through the installer.
  run_installer --disable --with-web >/dev/null 2>&1 || true
  # Remove only harness-owned files.
  rm -f "$AGENT_DIR/$COLLECTOR_PLIST" "$AGENT_DIR/$WEB_PLIST"
  rm -f "$GEN_DIR/$COLLECTOR_PLIST" "$GEN_DIR/$WEB_PLIST"
  rm -rf "$FIXTURE"
  # Clear the disabled overrides this run created, so the user's launchd
  # database does not accumulate entries for labels that no longer exist.
  launchctl enable "$DOMAIN/$COLLECTOR_LABEL" >/dev/null 2>&1 || true
  launchctl enable "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Test prefix:    $PREFIX"
echo "Fixture:        $FIXTURE"
echo "Loopback port:  $PORT"

step "render and install without enabling"
run_installer --install --with-web
assert_file_mode "$AGENT_DIR/$COLLECTOR_PLIST" 600
assert_file_mode "$AGENT_DIR/$WEB_PLIST" 600
assert_file_mode "$LOG_DIR" 700
assert_not_loaded "$COLLECTOR_LABEL"
assert_not_loaded "$WEB_LABEL"

step "plutil -lint on both rendered plists"
plutil -lint "$GEN_DIR/$COLLECTOR_PLIST" "$GEN_DIR/$WEB_PLIST"
note "both plists lint clean"

step "enable and load both agents"
run_installer --enable --with-web
assert_loaded "$COLLECTOR_LABEL"
assert_loaded "$WEB_LABEL"

step "web health on the free loopback port"
wait_for_web

step "collection evidence in the disposable database"
wait_for_runs

step "repeated enable leaves both loaded (the bootout race)"
run_installer --enable --with-web
assert_loaded "$COLLECTOR_LABEL"
assert_loaded "$WEB_LABEL"
# The restart loaded a fresh web process; the web server opens the database on
# its first request, so hit it before asserting the restore refusal below.
wait_for_web

step "--status names both labels and a running state"
STATUS="$(run_installer --status)"
case "$STATUS" in
  *"$COLLECTOR_LABEL"*) ;;
  *) fail "--status did not mention $COLLECTOR_LABEL" ;;
esac
case "$STATUS" in
  *"$WEB_LABEL"*) ;;
  *) fail "--status did not mention $WEB_LABEL" ;;
esac
case "$STATUS" in
  *"state = running"*) ;;
  *) fail "--status did not show a running job" ;;
esac
note "--status reported both labels"

step "restore refuses while the agents hold the database"
run_db db:backup -- "$BACKUP" >/dev/null
if run_db db:restore -- "$BACKUP" >"$FIXTURE/restore-refusal.log" 2>&1; then
  fail "db:restore succeeded while the web agent held the database open"
fi
if ! grep -q "open in process" "$FIXTURE/restore-refusal.log"; then
  fail "db:restore refusal did not name the holding process"
fi
note "db:restore refused, naming the holding process"

step "disable both, then the restore succeeds"
run_installer --disable --with-web
wait_until_not_loaded "$COLLECTOR_LABEL"
wait_until_not_loaded "$WEB_LABEL"
i=0
restored=0
while [ "$i" -lt 10 ]; do
  if run_db db:restore -- "$BACKUP" >/dev/null 2>&1; then
    restored=1
    break
  fi
  sleep 0.5
  i=$((i + 1))
done
if [ "$restored" -ne 1 ]; then
  fail "db:restore still refused after the agents were disabled"
fi
note "db:restore succeeded after --disable --with-web"

step "technical checks complete"

if [ "$KEEP_FIXTURE" -eq 1 ]; then
  cat <<EOF

Fixture retained. The user-assisted session checklist follows; do not run the
cleanup at the end until every check you intend to perform is done.

Every installer step below carries the same isolation settings. Define it once:

  aud_install() {
    AUD_DATA_DIR="$DATA_DIR" AUD_ENV_FILE="$ENV_FILE" AUD_PORT="$PORT" \\
      bash scripts/install-launchd.sh --label-prefix "$PREFIX" --log-dir "$LOG_DIR" "\$@"
  }

Manual checks:

  # 1. Install and enable both agents.
  aud_install --install --enable --with-web

  # 2. Inspect the loaded jobs.
  launchctl print $DOMAIN/$COLLECTOR_LABEL
  launchctl print $DOMAIN/$WEB_LABEL

  # 3. User action: put the Mac to sleep, wake it, and record when the first
  #    run after wake appears. launchd misses a firing that fell asleep; the
  #    next interval run is the first evidence.
  ls -l "$LOG_DIR"
  node -e 'const D=require("$WORKDIR/node_modules/better-sqlite3");const db=new D("$DATA_DIR/usage.db",{readonly:true});console.log(db.prepare("SELECT COUNT(*) AS runs FROM collector_runs").get());db.close()'

  # 4. User action: check System Settings > General > Login Items (& Extensions)
  #    > "Allow in the Background". Note the name shown ("Background Items
  #    Added" notification) and whether switching it off leaves the label
  #    unloaded; --status should say so.
  aud_install --status

  # 5. Disable, then log out and back in; neither label may be loaded.
  aud_install --disable --with-web
  #    ... after logging out and back in:
  launchctl print $DOMAIN/$COLLECTOR_LABEL   # expected to fail: not loaded
  launchctl print $DOMAIN/$WEB_LABEL         # expected to fail: not loaded

  # 6. Install without enabling, then log out and back in; neither label may
  #    be loaded either (the installer disabled them at install time).
  aud_install --install --with-web
  #    ... after logging out and back in:
  launchctl print $DOMAIN/$COLLECTOR_LABEL   # expected to fail: not loaded
  launchctl print $DOMAIN/$WEB_LABEL         # expected to fail: not loaded

  # 7. Enable again; both labels load, and a second enable in a row leaves
  #    them loaded (the bootout race).
  aud_install --enable --with-web
  launchctl print $DOMAIN/$COLLECTOR_LABEL   # expected to succeed
  launchctl print $DOMAIN/$WEB_LABEL         # expected to succeed
  aud_install --enable --with-web
  launchctl print $DOMAIN/$COLLECTOR_LABEL   # expected to succeed
  launchctl print $DOMAIN/$WEB_LABEL         # expected to succeed

  # 8. User action (optional): confirm a Codex reading with the default file
  #    credential store. Keyring storage is untested until exercised.

Cleanup after the manual checks:

  AUD_DATA_DIR="$DATA_DIR" AUD_ENV_FILE="$ENV_FILE" AUD_PORT="$PORT" \\
    bash scripts/install-launchd.sh --label-prefix "$PREFIX" --log-dir "$LOG_DIR" --disable --with-web
  rm -f "$AGENT_DIR/$COLLECTOR_PLIST" "$AGENT_DIR/$WEB_PLIST"
  rm -f "$GEN_DIR/$COLLECTOR_PLIST" "$GEN_DIR/$WEB_PLIST"
  rm -rf "$FIXTURE"
EOF
fi
