#!/usr/bin/env bash
#
# Disposable-systemd rehearsal for the managed Linux installer.
#
# This exercises the real lifecycle end to end on a throwaway Linux systemd
# environment: a dedicated account with its own user manager (a VM/container or
# a salted login session), real git fixture releases, the real Node download and
# checksum, real pnpm dependency and native-module installation, a real Next.js
# build, real generated user units, HTTP health, scheduled collection, a failed
# candidate update with database recovery, a SIGKILL interruption, Claude
# composition, uninstall, and reinstall.
#
# It refuses to run anywhere that is not explicitly disposable:
#   * AUD_INSTALL_SYSTEMD_REHEARSAL=1 must be set;
#   * it must not run as root;
#   * it must run inside a user systemd session whose XDG_RUNTIME_DIR is owned
#     by the current user;
#   * the account must have no pre-existing dashboard units, launcher, install
#     root, or application data.
#
# Usage:
#   AUD_INSTALL_SYSTEMD_REHEARSAL=1 bash scripts/test-installation-systemd.sh
#
# Optional environment:
#   AUD_INSTALL_REHEARSAL_SOURCE=<checkout>  source to build fixture releases from
#   AUD_INSTALL_REHEARSAL_KEEP=1             keep the work directory for inspection
#   AUD_INSTALL_REHEARSAL_HEALTH_TIMEOUT=15  seconds for the candidate health wait
#
set -euo pipefail

SOURCE="${AUD_INSTALL_REHEARSAL_SOURCE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

die() { printf 'REHEARSAL REFUSED: %s\n' "$*" >&2; exit 2; }

# --- isolation guard --------------------------------------------------------

[[ "${AUD_INSTALL_SYSTEMD_REHEARSAL:-}" == "1" ]] \
  || die "set AUD_INSTALL_SYSTEMD_REHEARSAL=1 to acknowledge this runs a full disposable lifecycle"
[[ "$(id -u)" -ne 0 ]] || die "run as the disposable account, never as root"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required"
[[ -n "${XDG_RUNTIME_DIR:-}" && -d "$XDG_RUNTIME_DIR" && -O "$XDG_RUNTIME_DIR" ]] \
  || die "XDG_RUNTIME_DIR must name this account's own user-manager runtime directory"
systemctl --user show-environment >/dev/null 2>&1 \
  || die "no usable user systemd manager in this session"
for tool in git curl tar xz sha256sum flock python3 systemd-analyze; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

DEFAULT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ai-usage-dashboard-install"
LAUNCHER="$HOME/.local/bin/ai-usage-dashboard"
for unit in ai-usage-dashboard-collector.service ai-usage-dashboard-collector.timer ai-usage-dashboard-web.service; do
  if [[ -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit" ]]; then
    die "the account already has $unit installed; this is not a disposable environment"
  fi
done
[[ -e "$LAUNCHER" ]] && die "the account already has $LAUNCHER"
[[ -e "$DEFAULT_ROOT" ]] && die "the account already has $DEFAULT_ROOT"
[[ -e "${XDG_DATA_HOME:-$HOME/.local/share}/ai-usage-dashboard" ]] \
  && die "the account already has application data"
[[ -n "$(systemctl --user list-units --all --no-legend 'ai-usage-dashboard-*' 2>/dev/null)" ]] \
  && die "the user manager already knows ai-usage-dashboard units"

# --- fixture releases -------------------------------------------------------

WORK="$(mktemp -d "$HOME/aud-install-rehearsal.XXXXXX")"
KEEP="${AUD_INSTALL_REHEARSAL_KEEP:-0}"
cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    printf 'Rehearsal work directory kept: %s\n' "$WORK"
    return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

FIXTURE="$WORK/fixture"
PORT="$(python3 -c 'import random; print(random.randint(40000, 49999))')"
DATA_DIR="$WORK/data"
ENV_FILE="$WORK/collector.env"
PASS_STEPS=()
FAIL_STEPS=()
CURRENT_STEP="startup"

pass() { PASS_STEPS+=("$1"); printf '  PASS: %s\n' "$1"; }
step() { CURRENT_STEP="$1"; printf '\n== %s\n' "$1"; }
check() { # check <description> <command...>
  local description="$1"; shift
  if "$@"; then pass "$description"; else
    FAIL_STEPS+=("$description")
    printf '  FAIL: %s\n' "$description" >&2
    fail_dump
    exit 1
  fi
}

fail_dump() {
  printf '\nREHEARSAL FAILURE during: %s\n' "$CURRENT_STEP" >&2
  systemctl --user list-units 'ai-usage-dashboard-*' --all --no-pager >&2 2>/dev/null || true
  systemctl --user status ai-usage-dashboard-web.service ai-usage-dashboard-collector.timer \
    --no-pager >&2 2>/dev/null || true
  journalctl --user -u ai-usage-dashboard-web.service -n 60 --no-pager >&2 2>/dev/null || true
  journalctl --user -u ai-usage-dashboard-collector.service -n 60 --no-pager >&2 2>/dev/null || true
  for unit in ai-usage-dashboard-web.service ai-usage-dashboard-collector.service; do
    file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
    [[ -f "$file" ]] && { printf -- '--- %s\n' "$file" >&2; cat "$file" >&2; }
  done
  for file in "$DEFAULT_ROOT/state.json" "$DEFAULT_ROOT/operation.json"; do
    [[ -f "$file" ]] && { printf -- '--- %s\n' "$file" >&2; cat "$file" >&2; }
  done
}

copy_source() {
  mkdir -p "$FIXTURE"
  tar -C "$SOURCE" \
    --exclude=./node_modules --exclude=./.next --exclude=./.git --exclude=./coverage \
    --exclude=./test-results --exclude=./playwright-report --exclude=./.code-review-graph \
    --exclude=./.playwright -cf - . | tar -C "$FIXTURE" -xf -
  git -C "$FIXTURE" init -q -b main
}

git_fixture() {
  git -C "$FIXTURE" -c user.name=rehearsal -c user.email=rehearsal@example.test "$@"
}

commit_fixture() { # commit_fixture <tag>
  git_fixture add -A
  git_fixture commit -q -m "rehearsal $1"
  git_fixture tag "$1"
}

fixture_version() {
  python3 - "$FIXTURE/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
}

set_version() { # set_version <version>
  python3 - "$FIXTURE/package.json" "$1" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data["version"] = version
open(path, "w").write(json.dumps(data, indent=2) + "\n")
PY
}

add_rehearsal_migration() {
  cat >"$FIXTURE/drizzle/0005_rehearsal.sql" <<'SQL'
-- Rehearsal-only migration: proves a failed candidate crosses the database
-- boundary and that the previous release's restore executable recovers it.
CREATE TABLE rehearsal_marker (id INTEGER PRIMARY KEY) STRICT;
SQL
  python3 - "$FIXTURE/src/lib/db/migrations.generated.ts" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
entry = '''  {
    version: 5,
    name: "0005_rehearsal.sql",
    sql: "CREATE TABLE rehearsal_marker (id INTEGER PRIMARY KEY) STRICT;\\n",
  },
'''
marker = "];"
index = text.rfind(marker)
if index == -1 or "version: 5" in text:
    raise SystemExit("cannot append rehearsal migration")
open(path, "w").write(text[:index] + entry + text[index:])
PY
}

break_candidate_web() {
  cp "$FIXTURE/scripts/next.ts" "$WORK/next.ts.orig"
  printf '#!/usr/bin/env tsx\nprocess.exit(1);\n' >"$FIXTURE/scripts/next.ts"
}

unbreak_candidate_web() {
  cp "$WORK/next.ts.orig" "$FIXTURE/scripts/next.ts"
}

state_value() { # state_value <key>
  python3 - "$DEFAULT_ROOT/state.json" "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))[sys.argv[2]])
PY
}

runs_count() {
  local release_dir
  release_dir="$DEFAULT_ROOT/releases/$(state_value sha)"
  local runtime_dir
  runtime_dir="$(python3 - "$DEFAULT_ROOT/state.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["runtime"]["path"])
PY
)"
  "$runtime_dir/bin/node" -e "
    const Database = require('$release_dir/node_modules/better-sqlite3');
    const db = new Database('$DATA_DIR/usage.db', { readonly: true });
    console.log(db.prepare('SELECT COUNT(*) AS n FROM collector_runs').get().n);
    db.close();
  "
}

wait_for_runs() { # wait_for_runs <minimum> <seconds>
  local minimum="$1" deadline=$((SECONDS + $2))
  while (( SECONDS < deadline )); do
    if [[ "$(runs_count)" -ge "$minimum" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

has_rehearsal_marker() {
  local release_dir runtime_dir
  release_dir="$DEFAULT_ROOT/releases/$(state_value sha)"
  runtime_dir="$(python3 - "$DEFAULT_ROOT/state.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["runtime"]["path"])
PY
)"
  "$runtime_dir/bin/node" -e "
    const Database = require('$release_dir/node_modules/better-sqlite3');
    const db = new Database('$DATA_DIR/usage.db', { readonly: true });
    const row = db.prepare(\"SELECT name FROM sqlite_master WHERE name = 'rehearsal_marker'\").get();
    console.log(row ? 'yes' : 'no');
    db.close();
  "
}

json_status() { # json_status <file> <key...>
  python3 - "$@" <<'PY'
import json, sys
current = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    current = current[key]
print(current)
PY
}

# --- environment for the rehearsal ------------------------------------------

export AUD_DATA_DIR="$DATA_DIR"
export AUD_ENV_FILE="$ENV_FILE"
export AUD_HOST=127.0.0.1
export AUD_PORT="$PORT"
export AUD_COLLECT_INTERVAL_MINUTES=1
export AUD_INSTALL_REPO_URL="$FIXTURE"
export AUD_INSTALL_HEALTH_TIMEOUT_SECONDS="${AUD_INSTALL_REHEARSAL_HEALTH_TIMEOUT:-15}"
NEXT_TELEMETRY_DISABLED=1
export NEXT_TELEMETRY_DISABLED
mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"

printf 'Rehearsal work directory: %s\n' "$WORK"
printf 'Install root: %s\nData directory: %s\nPort: %s\n' "$DEFAULT_ROOT" "$DATA_DIR" "$PORT"

# --- fixture v0.1.0 ---------------------------------------------------------

step "Building fixture release v0.1.0 from $SOURCE"
copy_source
commit_fixture v0.1.0
check "fixture v0.1.0 is tagged" test "$(git_fixture rev-parse 'v0.1.0^{commit}')" = "$(git_fixture rev-parse HEAD)"

# --- cold install, real toolchain, real systemd -----------------------------

step "Prepare a foreign Claude status line; installation must leave it unchanged"
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
cat >"$SETTINGS" <<'JSON'
{
  "statusLine": { "type": "command", "command": "my-wrapped-status --fancy", "padding": 2 },
  "keep": true
}
JSON

step "Cold install of v0.1.0 (real Node download, pnpm, native module, Next build, units, health, collection)"
if ! bash "$SOURCE/scripts/install.sh" --version v0.1.0 --install-dir "$DEFAULT_ROOT" --enable-linger; then
  fail_dump
  exit 1
fi
check "installer exited successfully" test -f "$DEFAULT_ROOT/state.json"
check "active release recorded" test "$(state_value tag)" = "v0.1.0"
check "launcher installed" test -x "$LAUNCHER"
check "web unit is active" systemctl --user is-active --quiet ai-usage-dashboard-web.service
check "web unit is enabled" systemctl --user is-enabled --quiet ai-usage-dashboard-web.service
check "timer is enabled" systemctl --user is-enabled --quiet ai-usage-dashboard-collector.timer
check "dashboard answers over HTTP" curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"
check "launcher status exits 0" "$LAUNCHER" status
check "linger is enabled" test "$(loginctl show-user "$USER" -p Linger --value)" = "yes"
check "Claude settings were left unchanged by installation" grep -q '"command": "my-wrapped-status --fancy"' "$SETTINGS"
check "no bridge command was installed implicitly" bash -c "! grep -q claude-statusline-bridge \"$SETTINGS\""
check "database was created" test -f "$DATA_DIR/usage.db"
check "ownership record names the database" python3 - "$DEFAULT_ROOT/data-ownership.json" "$DATA_DIR/usage.db" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
paths = [entry["databasePath"] for entry in record["entries"]]
sys.exit(0 if sys.argv[2] in paths else 1)
PY
step "Waiting for the scheduled timer to collect at least once"
check "scheduled collection persisted a run" wait_for_runs 1 240
printf '  OBSERVED: collector_runs=%s\n' "$(runs_count)"

# --- Claude composition -----------------------------------------------------

step "Claude status-line composition"
"$LAUNCHER" claude-statusline --apply --wrap-existing >/dev/null
check "bridge installed and wraps the previous command" python3 - "$SETTINGS" <<'PY'
import json, sys
status = json.load(open(sys.argv[1]))["statusLine"]
sys.exit(0 if "claude-statusline-bridge.mjs" in status["command"] and "my-wrapped-status" in status["command"] and status.get("padding") == 2 else 1)
PY
check "status reports the bridge as owned" bash -c "\"$LAUNCHER\" status | grep -q 'bridge    : owned'"

# --- failed candidate update and database recovery --------------------------

step "Candidate v0.1.1 crosses the database boundary then fails health; recovery must restore v0.1.0"
set_version 0.1.1
add_rehearsal_migration
break_candidate_web
commit_fixture v0.1.1
check "fixture v0.1.1 is intentionally broken" grep -q "process.exit(1)" "$FIXTURE/scripts/next.ts"
if "$LAUNCHER" update --version v0.1.1; then
  FAIL_STEPS+=("broken candidate update failed the rehearsal by succeeding")
  printf '  FAIL: the broken candidate update unexpectedly succeeded\n' >&2
  fail_dump
  exit 1
fi
pass "broken candidate update failed as expected"
check "active release is still v0.1.0" test "$(state_value tag)" = "v0.1.0"
check "recovered database has no candidate migration" test "$(has_rehearsal_marker)" = "no"
check "pre-cutover backup exists" bash -c "ls \"$DATA_DIR\"/backups/installation-*.db >/dev/null"
check "failed database copy was retained" bash -c "ls \"$DATA_DIR\"/usage.db.pre-restore-* >/dev/null"
check "recovered web answers again" curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"
check "recovery journal was cleared" test ! -e "$DEFAULT_ROOT/operation.json"

# --- successful update ------------------------------------------------------

step "Candidate v0.1.2 succeeds and the Claude bridge follows it"
unbreak_candidate_web
set_version 0.1.2
commit_fixture v0.1.2
"$LAUNCHER" update --version v0.1.2
check "active release is v0.1.2" test "$(state_value tag)" = "v0.1.2"
check "previous release is recorded" test "$(json_status "$DEFAULT_ROOT/state.json" previous tag)" = "v0.1.0"
check "updated web answers" curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"
V012_SHA="$(state_value sha)"
check "bridge points at the new release" bash -c "grep -q '$V012_SHA' \"$SETTINGS\""
check "bridge still wraps the original command" grep -q "my-wrapped-status" "$SETTINGS"

# --- SIGKILL at the database boundary ---------------------------------------

step "SIGKILL during an update to v0.1.3, then recovery on the next invocation"
set_version 0.1.3
commit_fixture v0.1.3
setsid "$LAUNCHER" update --version v0.1.3 >"$WORK/crash-update.log" 2>&1 &
update_pid=$!
killed=0
for _ in $(seq 1 600); do
  if [[ -f "$DEFAULT_ROOT/operation.json" ]]; then
    phase="$(python3 - "$DEFAULT_ROOT/operation.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["phase"])
PY
)"
    case "$phase" in
      db-changing|candidate-units|candidate-web|bridge-refreshed)
        kill -9 "-$update_pid" 2>/dev/null || true
        killed=1
        break
        ;;
    esac
  fi
  sleep 0.5
done
wait "$update_pid" 2>/dev/null || true
check "the update process was killed at the database boundary" test "$killed" = "1"
"$LAUNCHER" update --version v0.1.3
check "recovery completed the v0.1.3 update" test "$(state_value tag)" = "v0.1.3"
check "web answers after the interrupted update" curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"
check "journal is clear after recovery" test ! -e "$DEFAULT_ROOT/operation.json"

# --- uninstall and reinstall ------------------------------------------------

step "Uninstall preserves data, credentials, ownership, and linger"
RUNS_BEFORE="$(runs_count)"
printf 'credential-sentinel' >"$DATA_DIR/credential-sentinel"
"$LAUNCHER" uninstall
check "units are gone" bash -c 'for u in ai-usage-dashboard-collector.service ai-usage-dashboard-collector.timer ai-usage-dashboard-web.service; do [[ -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$u" ]] && exit 1; done; exit 0'
check "launcher is gone" test ! -e "$LAUNCHER"
check "releases are gone" test ! -d "$DEFAULT_ROOT/releases"
check "runtime is gone" test ! -d "$DEFAULT_ROOT/runtime"
check "data directory survives" test -f "$DATA_DIR/credential-sentinel"
check "database survives" test -f "$DATA_DIR/usage.db"
check "ownership record survives" test -f "$DEFAULT_ROOT/data-ownership.json"
check "linger is unchanged" test "$(loginctl show-user "$USER" -p Linger --value)" = "yes"
check "wrapped status line was handed back" grep -q "my-wrapped-status" "$SETTINGS"
check "bridge command removed" bash -c "! grep -q claude-statusline-bridge \"$SETTINGS\""
if bash "$SOURCE/scripts/install.sh" uninstall --install-dir "$DEFAULT_ROOT"; then
  pass "repeated uninstall through the bootstrap recovery entry point is a clean no-op"
else
  FAIL_STEPS+=("repeated uninstall")
  printf '  FAIL: repeated uninstall did not succeed\n' >&2
  fail_dump
  exit 1
fi

step "Reinstall from the same root and configuration reuses the retained database"
bash "$SOURCE/scripts/install.sh" --version v0.1.3 --install-dir "$DEFAULT_ROOT"
check "state is back" test "$(state_value tag)" = "v0.1.3"
check "reinstall took a verified backup" bash -c "ls \"$DATA_DIR\"/backups/installation-*.db >/dev/null"
check "history was preserved" test "$(runs_count)" -ge "$RUNS_BEFORE"
check "reinstalled web answers" curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"

# --- summary ----------------------------------------------------------------

printf '\nRehearsal complete: %d checks passed, 0 failed.\n' "${#PASS_STEPS[@]}"
printf 'Install root: %s\nData directory: %s\nPort: %s\n' "$DEFAULT_ROOT" "$DATA_DIR" "$PORT"
printf 'This run exercised real systemd services, timer execution, and database recovery.\n'
