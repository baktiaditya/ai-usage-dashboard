---
type: Operations Runbook
title: Production Checkout — Deploy and Rollback
description: Maintainer runbook for deploying a commit to the production checkout and rolling back.
---

# Production checkout — deploy and rollback

Both units run from a dedicated clone at `~/Workspace/ai-usage-dashboard-prod`,
never from the development repository. The installer renders `WorkingDirectory`,
`ExecStart` and `ReadWritePaths` from the checkout it runs in, so branch switches,
`pnpm install` and `pnpm run build` in the development repository cannot change what
production serves or collects with. Always run `scripts/install-systemd.sh` from
the production checkout: running it from any other checkout repoints both units at
that checkout. The data directory and `collector.env` live outside both checkouts
and carry across every deploy and rollback.

The Claude status line ([Setup](setup.md) §3) is not a unit, but the same rule applies:
`pnpm run claude:install-statusline --apply` records the bridge's absolute path in the checkout it
runs in. Run it from the production checkout. Run from there, it refreshes an installation made from
any other checkout.

The production checkout is a deployment surface, not a branch. It deploys only
commits reachable from `origin/main`, always as a detached `HEAD` at an exact SHA.
No commit, merge, hotfix or production-only branch originates there: fix production
on `main`, then deploy forward or roll back to an earlier known-good commit.

Create it once with a clone rather than a linked `git worktree`, so it shares no
refs, config or worktree administration with the development repository:

```bash
git clone https://github.com/baktiaditya/ai-usage-dashboard.git ~/Workspace/ai-usage-dashboard-prod
```

Then deploy, from a shell where `corepack enable pnpm` ([Setup](setup.md) §1) has put `pnpm` on
`PATH`. `pnpm install --frozen-lockfile` runs install scripts only for the exact versions listed
under `allowBuilds` in `pnpm-workspace.yaml`, and fails rather than asking when any other package
has one ([Setup](setup.md) §10).

## Deploy

Brief downtime is expected: the timer, any running collector and the web unit stop
before source, dependencies or `.next` change, so the collector never runs against
a half-installed tree and the web unit never serves a build being replaced. On this
machine a deploy took about half a minute, `pnpm run verify` included.

Run the blocks in one shell, in order. Each block after the preflight starts only
when `CANDIDATE` is set and stops at its first failing command, and a unit that does
not stop clears `CANDIDATE`. Pasting the whole procedure therefore cannot stop the
units after a failed preflight, change the checkout while a unit may still be
running, or start the timer before the new web unit answers.

```bash
cd ~/Workspace/ai-usage-dashboard-prod

# Cache the pnpm a commit pins and check that it runs, from a scratch copy of that
# commit's package.json, so the checkout does not change. Step 3 installs with
# pnpm, so a commit that does not pin pnpm with its sha512 hash fails; corepack
# checks the download against that hash.
pnpm_pinned_ready() {
  local dir pinned rc locator='^pnpm@[0-9]+\.[0-9]+\.[0-9]+\+sha512\.[0-9a-f]{128}$'
  dir=$(mktemp -d) || return 1
  git show "$1:package.json" > "$dir/package.json" \
    && pinned=$(cd "$dir" && node -p "require('./package.json').packageManager ?? ''") \
    && [[ "$pinned" =~ $locator ]] \
    && (cd "$dir" && corepack install \
      && [[ "$(pnpm --version)" == "$(echo "${pinned#pnpm@}" | cut -d+ -f1)" ]])
  rc=$?
  rm -rf "$dir"
  return $rc
}

# 1. Preflight: a clean checkout, exact SHAs, a candidate on origin/main that has
#    pnpm-lock.yaml, and the pnpm it pins cached and runnable.
PREVIOUS= CANDIDATE=
if [[ -n "$(git status --porcelain)" ]]; then
  echo "STOP: the production checkout is dirty"
elif git fetch origin \
  && PREVIOUS=$(git rev-parse HEAD) \
  && CANDIDATE=$(git rev-parse origin/main) \
  && git merge-base --is-ancestor "$CANDIDATE" origin/main \
  && git cat-file -e "$CANDIDATE:pnpm-lock.yaml" \
  && pnpm_pinned_ready "$CANDIDATE"; then
  echo "preflight ok: previous=$PREVIOUS candidate=$CANDIDATE"
else
  CANDIDATE=
  echo "STOP: preflight failed"
fi

# 2. Stop everything that reads source, dependencies or .next.
if [[ -n "$CANDIDATE" ]]; then
  if systemctl --user stop ai-usage-dashboard-collector.timer \
    && until [[ "$(systemctl --user is-active ai-usage-dashboard-collector.service)" =~ ^(inactive|failed)$ ]]; do sleep 1; done \
    && systemctl --user stop ai-usage-dashboard-web.service; then
    echo "units stopped"
  else
    CANDIDATE=
    echo "STOP: a unit did not stop; the checkout is unchanged"
  fi
fi

# 3. Stage the candidate and reinstall both units from this checkout without
#    enabling them, then start the web unit and, once it answers, the timer.
#    The host and port are read back from the rendered web unit.
if [[ -n "$CANDIDATE" ]]; then
  if git checkout --detach "$CANDIDATE" \
    && pnpm install --frozen-lockfile \
    && pnpm run verify \
    && pnpm run build \
    && scripts/install-systemd.sh --install --with-web \
    && WEB_UNIT=systemd/generated/ai-usage-dashboard-web.service \
    && WEB_HOST=$(sed -n 's/^Environment=AUD_HOST=//p' "$WEB_UNIT") \
    && WEB_PORT=$(sed -n 's/^Environment=AUD_PORT=//p' "$WEB_UNIT") \
    && [[ -n "$WEB_HOST" && "$WEB_PORT" =~ ^[0-9]+$ ]] \
    && WEB_URL="http://$([[ "$WEB_HOST" == *:* ]] && echo "[$WEB_HOST]" || echo "$WEB_HOST"):$WEB_PORT/" \
    && [[ -z "$(ss -ltnH "sport = :$WEB_PORT")" ]] \
    && systemctl --user enable ai-usage-dashboard-web.service \
    && systemctl --user restart ai-usage-dashboard-web.service \
    && curl -fsS -o /dev/null --retry 30 --retry-delay 1 --retry-connrefused "$WEB_URL" \
    && systemctl --user enable --now ai-usage-dashboard-collector.timer; then
    echo "deployed $(git rev-parse HEAD)"
  else
    echo "STOP: the deploy failed; roll back to $PREVIOUS"
  fi
fi
```

Record both SHAs from the `preflight ok` line. A `STOP` line from the preflight
leaves the units running and changes nothing; inspect a dirty checkout instead of
discarding it. The collector is a one-shot service, so step 2 waits for a run already
in progress rather than cutting it off; `systemctl --user stop ai-usage-dashboard-collector.service`
ends one that must not finish. The stopped web unit reads `failed` (Next.js exits
with status 143 on `SIGTERM`) until step 3 restarts it.

The preflight caches pnpm before anything stops. It reads the candidate's `package.json` into a
scratch directory, where `corepack install` caches the pinned pnpm and `pnpm --version` must print
that version. The first run of a new version also fetches pnpm's platform binary into corepack's
cache, so step 3 never waits on the registry for pnpm while the units are down. A candidate without
`pnpm-lock.yaml`, a `packageManager` other than `pnpm@<version>+sha512.<hash>`, a download that fails
or does not match that hash, or a different version clears `CANDIDATE`.

The first deploy after the move from npm meets a `node_modules` that `npm ci` laid out.
`pnpm install --frozen-lockfile` replaces it without prompting, even with standard input closed, so
step 3 is the same for that deploy as for any other.

Step 3 runs the installer without `--enable`, so it only renders, installs and
reloads the units; ignore its closing "Not enabled" hint. The installer's own
`--enable` would start the timer before checking the port and restarting the web
unit, leaving the timer running when either fails. Step 3 instead refuses a port
held by another process (the stopped web unit holds none), waits until the new web
unit answers, and starts the timer last.

Step 3 and the verify block below read `AUD_HOST`, `AUD_PORT` and `AUD_DATA_DIR`
back from the rendered web unit, so a non-default value needs no edits; an IPv6
host such as `::1` gets brackets in the URL. The renderer refuses values containing
whitespace, quotes or backslashes and writes `%` as `%%`, so reading the unit back
is exact.

Verify the deploy:

```bash
cd ~/Workspace/ai-usage-dashboard-prod

WEB_UNIT=systemd/generated/ai-usage-dashboard-web.service
WEB_HOST=$(sed -n 's/^Environment=AUD_HOST=//p' "$WEB_UNIT")
WEB_PORT=$(sed -n 's/^Environment=AUD_PORT=//p' "$WEB_UNIT")
WEB_URL="http://$([[ "$WEB_HOST" == *:* ]] && echo "[$WEB_HOST]" || echo "$WEB_HOST"):$WEB_PORT/"
DATA_DIR=$(sed -n 's/^Environment="AUD_DATA_DIR=\(.*\)"$/\1/p' "$WEB_UNIT" | sed 's/%%/%/g')

git status --short                  # empty
git rev-parse HEAD                  # equals $CANDIDATE
git merge-base --is-ancestor HEAD origin/main && echo "on origin/main"
systemctl --user show -p WorkingDirectory ai-usage-dashboard-web.service ai-usage-dashboard-collector.service
for u in ai-usage-dashboard-collector.service ai-usage-dashboard-collector.timer ai-usage-dashboard-web.service; do
  cmp systemd/generated/$u ~/.config/systemd/user/$u && echo "$u identical"
done
systemctl --user is-active ai-usage-dashboard-web.service ai-usage-dashboard-collector.timer
curl -fsS -o /dev/null -w '%{http_code}\n' "$WEB_URL"
echo "data directory: $DATA_DIR"
```

Both `WorkingDirectory` lines name the production checkout. The web unit and timer
are `active`; the collector service is normally `inactive` between runs. Then press
**Refresh** on a card, and after the next timer run check, in the same shell, that
both collections persisted:

```bash
sqlite3 -readonly "$DATA_DIR/usage.db" \
  "select r.id, r.trigger, a.provider, a.outcome from collector_runs r
   join collector_attempts a on a.run_id = r.id order by r.id desc limit 8"
```

## Failure

If a unit does not stop in step 2, step 3 does nothing and the checkout still holds
the previous commit. Find the cause with `scripts/install-systemd.sh --status`, then
start what was stopped:
`systemctl --user start ai-usage-dashboard-web.service ai-usage-dashboard-collector.timer`.

If any command in step 3 fails, the chain stops there. The timer stays stopped,
because starting it is the last command, and the web unit is stopped or serving a
partial candidate. Do not start units by hand; roll back to `$PREVIOUS` from the
same shell.

## Rollback

```bash
cd ~/Workspace/ai-usage-dashboard-prod

# In the shell of a failed deploy this is already the recorded previous SHA.
# In a new shell, replace "$PREVIOUS" with the recorded known-good SHA in quotes.
KNOWN_GOOD="$PREVIOUS"

# Cache the pnpm a commit pins and check that it runs, from a scratch copy of that
# commit's package.json, so the checkout does not change. A commit that pins no
# packageManager, from before the move to pnpm, passes: it installs with npm. A pin
# must name pnpm with its sha512 hash, which corepack checks the download against.
pnpm_ready() {
  local dir pinned rc locator='^pnpm@[0-9]+\.[0-9]+\.[0-9]+\+sha512\.[0-9a-f]{128}$'
  dir=$(mktemp -d) || return 1
  git show "$1:package.json" > "$dir/package.json" \
    && pinned=$(cd "$dir" && node -p "require('./package.json').packageManager ?? ''")
  rc=$?
  if [[ $rc -eq 0 && -n "$pinned" ]]; then
    [[ "$pinned" =~ $locator ]] \
      && (cd "$dir" && corepack install \
        && [[ "$(pnpm --version)" == "$(echo "${pinned#pnpm@}" | cut -d+ -f1)" ]])
    rc=$?
  fi
  rm -rf "$dir"
  return $rc
}

# 1. Preflight: a clean checkout, a known-good commit on origin/main, and the pnpm
#    it pins, if any, cached and runnable.
if [[ -z "$KNOWN_GOOD" ]]; then
  echo "STOP: KNOWN_GOOD is empty"
elif [[ -n "$(git status --porcelain)" ]]; then
  KNOWN_GOOD=
  echo "STOP: the production checkout is dirty"
elif git fetch origin \
  && git merge-base --is-ancestor "$KNOWN_GOOD" origin/main \
  && pnpm_ready "$KNOWN_GOOD"; then
  echo "rollback target ok: $KNOWN_GOOD"
else
  KNOWN_GOOD=
  echo "STOP: the rollback target is not on origin/main, or its pnpm is not ready"
fi

# 2. Stop everything that reads source, dependencies or .next.
if [[ -n "$KNOWN_GOOD" ]]; then
  if systemctl --user stop ai-usage-dashboard-collector.timer \
    && until [[ "$(systemctl --user is-active ai-usage-dashboard-collector.service)" =~ ^(inactive|failed)$ ]]; do sleep 1; done \
    && systemctl --user stop ai-usage-dashboard-web.service; then
    echo "units stopped"
  else
    KNOWN_GOOD=
    echo "STOP: a unit did not stop; the checkout is unchanged"
  fi
fi

# 3. Restore the known-good commit, install and build with the package manager its
#    lockfile belongs to, reinstall both units from it, then start the web unit
#    and, once it answers, the timer.
if [[ -n "$KNOWN_GOOD" ]]; then
  if git checkout --detach "$KNOWN_GOOD" \
    && if [[ -f pnpm-lock.yaml ]]; then
      pnpm install --frozen-lockfile && pnpm run build
    else
      npm ci && npm run build
    fi \
    && scripts/install-systemd.sh --install --with-web \
    && WEB_UNIT=systemd/generated/ai-usage-dashboard-web.service \
    && WEB_HOST=$(sed -n 's/^Environment=AUD_HOST=//p' "$WEB_UNIT") \
    && WEB_PORT=$(sed -n 's/^Environment=AUD_PORT=//p' "$WEB_UNIT") \
    && [[ -n "$WEB_HOST" && "$WEB_PORT" =~ ^[0-9]+$ ]] \
    && WEB_URL="http://$([[ "$WEB_HOST" == *:* ]] && echo "[$WEB_HOST]" || echo "$WEB_HOST"):$WEB_PORT/" \
    && [[ -z "$(ss -ltnH "sport = :$WEB_PORT")" ]] \
    && systemctl --user enable ai-usage-dashboard-web.service \
    && systemctl --user restart ai-usage-dashboard-web.service \
    && curl -fsS -o /dev/null --retry 30 --retry-delay 1 --retry-connrefused "$WEB_URL" \
    && systemctl --user enable --now ai-usage-dashboard-collector.timer; then
    echo "rolled back to $(git rev-parse HEAD)"
  else
    echo "STOP: the rollback failed; the timer stays stopped"
  fi
fi
```

A rollback `STOP` line follows the same rules as a deploy failure: after step 2,
nothing changed; after step 3, fix the reported cause and run the rollback again.
Source, dependencies, build and rendered units then all come from the same
known-good commit. Verify it as above, expecting `HEAD` to equal `$KNOWN_GOOD`.
Rollback skips the verify step because that commit passed it when it was deployed.

A known-good commit with `pnpm-lock.yaml` installs with `pnpm install --frozen-lockfile`, after the
preflight has cached the pnpm it pins. The preflight refuses a commit whose `packageManager` is set
but is not `pnpm@<version>+sha512.<hash>`. A commit from before the move to pnpm has only
`package-lock.json` and pins no pnpm, so it installs with `npm ci` and builds with `npm run build`,
both bundled with Node. `npm ci` deletes the pnpm `node_modules` before it installs.
The checkout stays detached; a later deploy repeats the normal fetch-and-detach
procedure from `origin/main`.
