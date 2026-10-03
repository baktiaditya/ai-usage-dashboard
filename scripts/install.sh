#!/usr/bin/env bash
#
# AI Usage Dashboard — managed Linux installation bootstrap.
#
#   bash scripts/install.sh [--version vX.Y.Z] [--install-dir ABSOLUTE_PATH]
#                          [--enable-linger] [--dry-run]
#   bash scripts/install.sh status    [--install-dir ABSOLUTE_PATH]
#   bash scripts/install.sh uninstall [--install-dir ABSOLUTE_PATH] [--dry-run]
#
# The bootstrap preflights the machine, resolves a stable release tag to an
# exact detached commit, provisions the checksum-verified private Node/Corepack
# runtime, fetches the release checkout, and hands off to that checkout's
# scripts/manage-installation.ts. Every lifecycle step runs from the selected
# release, so a bootstrap downloaded from one tag can install another.
#
# Piped execution (`curl … | bash`) is supported: no prompt or TTY is used, and
# every child runs with stdin connected to /dev/null so the rest of this script
# on stdin is never consumed.
#
# Exit codes:
#   0  success
#   1  preflight, resolution, runtime, or lifecycle failure
#   2  usage error (unknown/unsupported arguments)
#
set -euo pipefail

MANAGER_API_VERSION=1
DEFAULT_REPO_URL="https://github.com/baktiaditya/ai-usage-dashboard.git"
DEFAULT_NODE_DIST_BASE="https://nodejs.org/dist"

REPO_URL="${AUD_INSTALL_REPO_URL:-$DEFAULT_REPO_URL}"
NODE_DIST_BASE="${AUD_INSTALL_NODE_DIST_BASE:-$DEFAULT_NODE_DIST_BASE}"

usage() {
  cat <<'EOF'
AI Usage Dashboard — managed Linux installation bootstrap.

  bash scripts/install.sh [--version vX.Y.Z] [--install-dir ABSOLUTE_PATH]
                         [--enable-linger] [--dry-run]
  bash scripts/install.sh status    [--install-dir ABSOLUTE_PATH]
  bash scripts/install.sh uninstall [--install-dir ABSOLUTE_PATH] [--dry-run]

The bootstrap preflights the machine, resolves a stable release tag to an
exact detached commit, provisions the checksum-verified private Node/Corepack
runtime, fetches the release checkout, and hands off to that checkout's
scripts/manage-installation.ts.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

# --- arguments --------------------------------------------------------------

command_name="install"
version=""
install_dir=""
enable_linger=0
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      version="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      install_dir="$2"
      shift 2
      ;;
    --enable-linger)
      enable_linger=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    status|uninstall)
      command_name="$1"
      shift
      ;;
    *)
      printf 'error: unknown argument %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$version" && "$command_name" != "install" ]]; then
  printf 'error: --version is not valid for %s\n' "$command_name" >&2
  exit 2
fi
if [[ $enable_linger -eq 1 && "$command_name" != "install" ]]; then
  printf 'error: --enable-linger is only valid for install\n' >&2
  exit 2
fi

# --- install root -----------------------------------------------------------

default_root() {
  if [[ -n "${XDG_DATA_HOME:-}" && "$XDG_DATA_HOME" == /* ]]; then
    printf '%s/ai-usage-dashboard-install' "$XDG_DATA_HOME"
  else
    printf '%s/.local/share/ai-usage-dashboard-install' "$HOME"
  fi
}

ROOT="${install_dir:-$(default_root)}"
[[ "$ROOT" == /* ]] || die "--install-dir must be an absolute path (got $ROOT)"
if [[ "$ROOT" =~ [[:space:]\"\'\\] ]]; then
  die "the install root cannot contain whitespace, quotes, or backslashes: $ROOT"
fi

# --- recovery entry points (status, uninstall) ------------------------------

run_manager_if_available() {
  local node_bin="$ROOT/runtime/current/bin/node"
  local manager="$ROOT/current/scripts/manage-installation.ts"
  if [[ -x "$node_bin" && -f "$manager" ]]; then
    local args=("$@")
    exec "$node_bin" --disable-warning=ExperimentalWarning "$manager" "${args[@]}" </dev/null
  fi
  return 1
}

remove_owned_remnants() {
  # Used only when the runtime is gone: remove execution surfaces whose unit
  # files were demonstrably written by this managed root. Application data,
  # backups, credentials, and the ownership record are never touched.
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local units=(
    ai-usage-dashboard-collector.service
    ai-usage-dashboard-collector.timer
    ai-usage-dashboard-web.service
  )
  local collector_service="$unit_dir/ai-usage-dashboard-collector.service"
  local removed=0
  local -a owned_units=()
  # Decide ownership for every unit before removing any: the timer is owned
  # through the collector service file, which the removal below would delete.
  for unit in "${units[@]}"; do
    local file="$unit_dir/$unit"
    [[ -f "$file" ]] || continue
    # The service units carry WorkingDirectory under this root's releases. The
    # timer carries no such line; mirror the manager and call it owned when it
    # activates this root's collector service.
    local owned=0
    if [[ "$unit" == *.timer ]]; then
      if grep -qF 'Unit=ai-usage-dashboard-collector.service' "$file" \
        && [[ -f "$collector_service" ]] \
        && grep -qF "WorkingDirectory=$ROOT/releases/" "$collector_service"; then
        owned=1
      fi
    elif grep -qF "WorkingDirectory=$ROOT/releases/" "$file"; then
      owned=1
    fi
    if [[ $owned -eq 1 ]]; then
      owned_units+=("$unit")
    else
      printf 'warning: leaving foreign unit %s untouched\n' "$file" >&2
    fi
  done
  for unit in ${owned_units[@]+"${owned_units[@]}"}; do
    local file="$unit_dir/$unit"
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
    systemctl --user disable "$unit" >/dev/null 2>&1 || true
    rm -f "$file"
    removed=1
  done
  [[ $removed -eq 1 ]] && systemctl --user daemon-reload >/dev/null 2>&1 || true
  local launcher="$HOME/.local/bin/ai-usage-dashboard"
  if [[ -f "$launcher" ]] \
    && grep -qF "managed by the ai-usage-dashboard installer" "$launcher" \
    && grep -qF "AUD_INSTALL_ROOT='$ROOT'" "$launcher"; then
    rm -f "$launcher"
    removed=1
  fi
  return 0
}

if [[ "$command_name" == "status" || "$command_name" == "uninstall" ]]; then
  if [[ "$command_name" == "uninstall" ]]; then
    extra=()
    if [[ $dry_run -eq 1 ]]; then extra=(--dry-run); fi
    if run_manager_if_available uninstall --install-dir "$ROOT" "${extra[@]}"; then
      :
    fi
  else
    if run_manager_if_available status --install-dir "$ROOT"; then
      :
    fi
  fi
  if [[ -f "$ROOT/state.json" ]]; then
    die "the managed installation at $ROOT is incomplete: its runtime or active release is missing. Re-run the installer to repair it, or remove the root by hand after inspecting it."
  fi
  if [[ "$command_name" == "status" ]]; then
    log "No managed installation at $ROOT."
    exit 1
  fi
  if [[ $dry_run -eq 1 ]]; then
    log "DRY RUN — no managed installation at $ROOT; nothing to remove."
    exit 0
  fi
  remove_owned_remnants
  log "No managed installation at $ROOT; any owned remnants were removed and application data was left untouched."
  exit 0
fi

# --- preflight --------------------------------------------------------------

[[ "$(uname -s)" == "Linux" ]] || die "the managed installer currently targets Linux only (got $(uname -s))"
[[ "$(uname -m)" == "x86_64" ]] || die "the managed installer currently targets x86_64 only (got $(uname -m))"
[[ "$(id -u)" -ne 0 ]] || die "do not run the installer as root; it installs for the current user"

glibc_version=""
if command -v getconf >/dev/null 2>&1; then
  glibc_version="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
fi
if [[ -z "$glibc_version" ]]; then
  die "a glibc-based system is required (musl or a missing getconf is not supported); Node v24's official linux-x64 build needs glibc 2.28 or later"
fi
glibc_number="${glibc_version##* }"
glibc_major="${glibc_number%%.*}"
glibc_minor="${glibc_number#*.}"
glibc_minor="${glibc_minor%%.*}"
if (( glibc_major < 2 || (glibc_major == 2 && glibc_minor < 28) )); then
  die "glibc $glibc_number is too old; Node v24's official linux-x64 build needs glibc 2.28 or later (checking before downloading)"
fi

missing=()
for tool in git curl tar xz sha256sum flock systemctl journalctl ss; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'error: missing required tools: %s\n' "${missing[*]}" >&2
  printf 'Install them with your distribution package manager and retry.\n' >&2
  exit 1
fi

# --- release resolution -----------------------------------------------------

RELEASE_TAG=""
RELEASE_SHA=""

resolve_release() {
  local want="$1"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  git -C "$tmp" init -q
  git -C "$tmp" remote add origin "$REPO_URL"
  git -C "$tmp" fetch -q origin main </dev/null
  local main_sha
  main_sha="$(git -C "$tmp" rev-parse FETCH_HEAD)"
  git -C "$tmp" fetch -q origin '+refs/tags/v*:refs/tags/v*' </dev/null

  local candidates
  if [[ -n "$want" ]]; then
    [[ "$want" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "--version must be a stable vX.Y.Z tag (got $want)"
    git -C "$tmp" rev-parse --verify --quiet "refs/tags/$want^{commit}" >/dev/null \
      || die "release $want does not exist as a tag in $REPO_URL"
    candidates="$want"
  else
    candidates="$(git -C "$tmp" tag --list | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -Vr || true)"
    [[ -n "$candidates" ]] || die "no stable release tag exists in $REPO_URL; publish a tagged release first"
  fi

  local tag sha pkg_version
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    sha="$(git -C "$tmp" rev-parse "refs/tags/$tag^{commit}")"
    git -C "$tmp" merge-base --is-ancestor "$sha" "$main_sha" || continue
    git -C "$tmp" cat-file -e "$sha:scripts/install-runtime.env" 2>/dev/null || continue
    git -C "$tmp" cat-file -e "$sha:scripts/manage-installation.ts" 2>/dev/null || continue
    pkg_version="$(git -C "$tmp" show "$sha:package.json" | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -n1)"
    [[ "v$pkg_version" == "$tag" ]] || die "tag $tag does not agree with package.json version ${pkg_version:-unknown}"
    RELEASE_TAG="$tag"
    RELEASE_SHA="$sha"
    return 0
  done <<<"$candidates"

  if [[ -n "$want" ]]; then
    die "release $want is not reachable from $REPO_URL main, or does not carry the managed installer"
  fi
  die "no stable release of $REPO_URL is reachable from main and carries the managed installer; publish one first"
}

resolve_release "$version"
log "Release: $RELEASE_TAG ($RELEASE_SHA)"

# A remembered tag that resolves to a different commit is an error, not an
# upgrade: deploying the new commit silently would break the recorded mapping.
if [[ -f "$ROOT/state.json" ]]; then
  recorded_tag="$(grep -m1 '"tag":' "$ROOT/state.json" | sed 's/.*"tag": "\([^"]*\)".*/\1/')"
  recorded_sha="$(grep -m1 '"sha":' "$ROOT/state.json" | sed 's/.*"sha": "\([^"]*\)".*/\1/')"
  if [[ -n "$recorded_tag" && "$recorded_tag" == "$RELEASE_TAG" && -n "$recorded_sha" && "$recorded_sha" != "$RELEASE_SHA" ]]; then
    die "tag $RELEASE_TAG moved: it was recorded as $recorded_sha but now resolves to $RELEASE_SHA; refusing to redeploy it"
  fi
fi

# --- dry run ----------------------------------------------------------------

if [[ $dry_run -eq 1 ]]; then
  log "DRY RUN — nothing was written, downloaded, or started."
  log "  install root : $ROOT"
  log "  release      : $RELEASE_TAG ($RELEASE_SHA)"
  log "  would provision a private Node runtime under $ROOT/runtime, fetch the release"
  log "  checkout under $ROOT/releases, install dependencies, build, install and start"
  log "  the user units, run one collection, and write the launcher."
  exit 0
fi

# --- lifecycle lock ---------------------------------------------------------

# Take the same lock the manager uses before touching the root, so a bootstrap
# racing another operation changes nothing and fails fast. The descriptor stays
# open across the final exec, and AUD_INSTALL_LOCK_HELD tells the manager the
# lock is already held.
(umask 077; mkdir -p "$ROOT")
exec 9>"$ROOT/lifecycle.lock"
if ! flock --nonblock 9; then
  die "another managed installation operation is already running for $ROOT; wait for it to finish, then retry"
fi
export AUD_INSTALL_LOCK_HELD=1

# --- release checkout fetch -------------------------------------------------

RELEASE_DIR="$ROOT/releases/$RELEASE_SHA"
mkdir -p "$ROOT/releases" "$ROOT/runtime" "$ROOT/cache"
chmod 0700 "$ROOT" "$ROOT/releases" "$ROOT/runtime" "$ROOT/cache"

if [[ ! -d "$RELEASE_DIR" ]]; then
  staging="$ROOT/cache/.staging-$RELEASE_SHA-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  git -C "$staging" init -q
  git -C "$staging" remote add origin "$REPO_URL"
  if ! git -C "$staging" fetch -q --depth=1 origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG" </dev/null; then
    git -C "$staging" fetch -q --depth=1 origin "$RELEASE_SHA" </dev/null \
      || die "could not fetch $RELEASE_TAG ($RELEASE_SHA) from $REPO_URL"
  fi
  fetched_sha="$(git -C "$staging" rev-parse 'FETCH_HEAD^{commit}')"
  if [[ "$fetched_sha" != "$RELEASE_SHA" ]]; then
    rm -rf "$staging"
    die "tag $RELEASE_TAG moved while fetching: recorded $RELEASE_SHA, fetched $fetched_sha"
  fi
  git -C "$staging" checkout -q --detach "$fetched_sha"
  mv "$staging" "$RELEASE_DIR"
elif [[ "$(git -C "$RELEASE_DIR" rev-parse HEAD 2>/dev/null || true)" != "$RELEASE_SHA" ]]; then
  die "$RELEASE_DIR exists but is not the $RELEASE_SHA checkout; remove it and retry"
fi

# --- runtime manifest -------------------------------------------------------

NODE_VERSION=""
NODE_SHA=""
manifest="$RELEASE_DIR/scripts/install-runtime.env"
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    NODE_VERSION)
      [[ -z "$NODE_VERSION" ]] || die "NODE_VERSION is repeated in the runtime manifest"
      NODE_VERSION="$value"
      ;;
    NODE_SHA256_LINUX_X64)
      [[ -z "$NODE_SHA" ]] || die "NODE_SHA256_LINUX_X64 is repeated in the runtime manifest"
      NODE_SHA="$value"
      ;;
    *)
      die "unknown runtime manifest key '$key'; the manifest is data, not shell"
      ;;
  esac
done <"$manifest"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "NODE_VERSION must be X.Y.Z (got ${NODE_VERSION:-empty})"
[[ "$NODE_SHA" =~ ^[0-9a-f]{64}$ ]] || die "NODE_SHA256_LINUX_X64 must be 64 lowercase hex characters"

# The manifest must stay on the Node 24 line the repository requires; Node 25
# and later no longer ship Corepack.
nvmrc="$(tr -d '[:space:]' <"$RELEASE_DIR/.nvmrc" 2>/dev/null || true)"
node_major="${NODE_VERSION%%.*}"
if [[ -n "$nvmrc" && "$nvmrc" != "$node_major" && "$nvmrc" != "$NODE_VERSION" ]]; then
  case "$nvmrc" in
    "$node_major".*) ;;
    *) die ".nvmrc ($nvmrc) and the runtime manifest (Node $NODE_VERSION) disagree" ;;
  esac
fi

# --- private runtime --------------------------------------------------------

RUNTIME_DIR="$ROOT/runtime/node-v$NODE_VERSION"
runtime_ok=0
if [[ -x "$RUNTIME_DIR/bin/node" && -x "$RUNTIME_DIR/bin/corepack" ]]; then
  if [[ "$("$RUNTIME_DIR/bin/node" --version 2>/dev/null || true)" == "v$NODE_VERSION" ]]; then
    runtime_ok=1
  else
    rm -rf "$RUNTIME_DIR"
  fi
fi

if [[ $runtime_ok -eq 0 ]]; then
  log "Provisioning Node v$NODE_VERSION into $RUNTIME_DIR"
  staging="$ROOT/runtime/.staging-$NODE_VERSION-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  archive_name="node-v$NODE_VERSION-linux-x64.tar.xz"
  archive="$staging/$archive_name"
  curl -fSL --retry 3 --retry-delay 2 -o "$archive" "$NODE_DIST_BASE/v$NODE_VERSION/$archive_name" </dev/null \
    || { rm -rf "$staging"; die "downloading Node v$NODE_VERSION failed"; }
  digest="$(sha256sum "$archive" | awk '{print $1}')"
  if [[ "$digest" != "$NODE_SHA" ]]; then
    rm -rf "$staging"
    die "Node v$NODE_VERSION archive checksum mismatch: expected $NODE_SHA, got $digest"
  fi
  if tar -tJf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    rm -rf "$staging"
    die "the Node archive contains an unsafe path entry; refusing to extract"
  fi
  mkdir -p "$staging/extracted"
  tar -xJf "$archive" -C "$staging/extracted" --strip-components=1 \
    || { rm -rf "$staging"; die "extracting Node v$NODE_VERSION failed"; }
  [[ "$("$staging/extracted/bin/node" --version 2>/dev/null || true)" == "v$NODE_VERSION" ]] \
    || { rm -rf "$staging"; die "the extracted Node does not report v$NODE_VERSION"; }
  [[ "$("$staging/extracted/bin/node" -p process.platform 2>/dev/null || true)" == "linux" ]] \
    || { rm -rf "$staging"; die "the extracted Node is not a linux build"; }
  [[ -x "$staging/extracted/bin/corepack" ]] \
    || { rm -rf "$staging"; die "the extracted runtime ships no Corepack (Node 25 and later do not)"; }
  rm -f "$archive"
  mv "$staging/extracted" "$RUNTIME_DIR"
  rm -rf "$staging"
  log "Runtime ready: $RUNTIME_DIR"
fi

NODE_BIN="$RUNTIME_DIR/bin/node"
MANAGER="$RELEASE_DIR/scripts/manage-installation.ts"
[[ -f "$MANAGER" ]] || die "$MANAGER is missing from the release"

# --- hand off to the selected release ---------------------------------------

manager_args=(install --install-dir "$ROOT")
if [[ -n "$version" ]]; then manager_args+=(--version "$version"); fi
if [[ $enable_linger -eq 1 ]]; then manager_args+=(--enable-linger); fi

log "Starting the managed installation from $RELEASE_TAG"
export AUD_INSTALL_MANAGER_API="$MANAGER_API_VERSION"
export AUD_INSTALL_ROOT="$ROOT"
export AUD_INSTALL_TAG="$RELEASE_TAG"
export AUD_INSTALL_SHA="$RELEASE_SHA"
export AUD_INSTALL_REPO_URL="$REPO_URL"

exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$MANAGER" "${manager_args[@]}" </dev/null
