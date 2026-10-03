/**
 * Release resolution and detached checkout for the managed installer.
 *
 * The installer deploys exact commits, never a floating branch. A release is a
 * stable `vX.Y.Z` tag whose commit is reachable from upstream `main` and whose
 * tree carries the runtime manifest and lifecycle entry point. The tag is
 * resolved once to a commit SHA, fetched detached, and recorded; a remembered
 * tag that later resolves to a different SHA is an error, not an upgrade.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exists, errorText } from './atomic.ts';
import { run, runOrThrow } from './exec.ts';
import { compareTagStrings, parseStableTag } from './semver.ts';

export class ReleaseError extends Error {
  override readonly name = 'ReleaseError';
}

export interface ResolvedRelease {
  readonly tag: string;
  readonly sha: string;
}

export const DEFAULT_REPO_URL = 'https://github.com/baktiaditya/ai-usage-dashboard.git';

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function tempGitDir(): string {
  return mkdtempSync(join(tmpdir(), 'aud-install-'));
}

function runGit(args: readonly string[], cwd?: string): ReturnType<typeof run> {
  return run('git', args, { cwd, env: gitEnv(), timeoutMs: 10 * 60 * 1000 });
}

function gitOrThrow(args: readonly string[], cwd?: string): ReturnType<typeof run> {
  return runOrThrow('git', args, { cwd, env: gitEnv(), timeoutMs: 10 * 60 * 1000 });
}

/** All `v*` tag names advertised by the remote. */
function remoteTags(repoUrl: string, dir: string): string[] {
  const result = runGit(['ls-remote', '--tags', repoUrl], dir);
  if (result.error) {
    throw new ReleaseError(`could not reach ${repoUrl}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ReleaseError(`could not list tags from ${repoUrl}: ${result.stderr.trim()}`);
  }
  const names = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    if (ref === undefined) continue;
    if (!ref.startsWith('refs/tags/')) continue;
    let name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) name = name.slice(0, -3);
    names.add(name);
  }
  return [...names];
}

/** Fetch `main` and every tag into `dir`; return the `main` commit SHA. */
function fetchRefs(repoUrl: string, dir: string): string {
  gitOrThrow(['init', '--quiet'], dir);
  gitOrThrow(['remote', 'add', 'origin', repoUrl], dir);
  gitOrThrow(['fetch', '--quiet', 'origin', 'main'], dir);
  const mainSha = gitOrThrow(['rev-parse', 'FETCH_HEAD'], dir).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new ReleaseError(`upstream main did not resolve to a commit in ${repoUrl}`);
  }
  const fetchTags = runGit(['fetch', '--quiet', 'origin', '+refs/tags/v*:refs/tags/v*'], dir);
  if (fetchTags.status !== 0) {
    throw new ReleaseError(`could not fetch tags from ${repoUrl}: ${fetchTags.stderr.trim()}`);
  }
  return mainSha;
}

function commitOfTag(dir: string, tag: string): string | null {
  const result = runGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], dir);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function isAncestor(dir: string, sha: string, mainSha: string): boolean {
  const result = runGit(['merge-base', '--is-ancestor', sha, mainSha], dir);
  return result.status === 0;
}

/** Validate that a commit's tree carries the installer's required files. */
export function verifyReleaseCommit(dir: string, sha: string, tag?: string): void {
  for (const path of ['scripts/install-runtime.env', 'scripts/manage-installation.ts']) {
    const result = runGit(['cat-file', '-e', `${sha}:${path}`], dir);
    if (result.status !== 0) {
      throw new ReleaseError(
        `${tag ?? sha} does not contain ${path}; it predates or is not a managed release`,
      );
    }
  }
  const pkg = runGit(['show', `${sha}:package.json`], dir);
  if (pkg.status !== 0) {
    throw new ReleaseError(`${tag ?? sha} has no package.json`);
  }
  let version: unknown;
  try {
    version = (JSON.parse(pkg.stdout) as { version?: unknown }).version;
  } catch {
    throw new ReleaseError(`${tag ?? sha} has an unreadable package.json`);
  }
  if (tag !== undefined && version !== tag.slice(1)) {
    throw new ReleaseError(
      `tag ${tag} does not agree with package.json version ${JSON.stringify(version)}`,
    );
  }
}

export interface ResolveOptions {
  /** Test/rehearsal override; defaults to the public repository. */
  readonly repoUrl?: string;
}

/**
 * Resolve one release to an exact commit.
 *
 * With `explicitTag`, that tag must exist, be stable, be reachable from
 * upstream `main`, and carry the installer's files. Without one, the highest
 * stable eligible tag is selected by numeric comparison.
 */
export function resolveRelease(
  explicitTag: string | null,
  options: ResolveOptions = {},
): ResolvedRelease {
  const repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
  if (explicitTag !== null && parseStableTag(explicitTag) === null) {
    throw new ReleaseError(
      `--version must be a stable vX.Y.Z tag, got ${JSON.stringify(explicitTag)}`,
    );
  }
  const dir = tempGitDir();
  try {
    const mainSha = fetchRefs(repoUrl, dir);
    const tags = remoteTags(repoUrl, dir);
    const stable = tags.filter((tag) => parseStableTag(tag) !== null);

    let chosenTag: string | null = null;
    if (explicitTag !== null) {
      if (!stable.includes(explicitTag)) {
        throw new ReleaseError(
          `release ${explicitTag} does not exist as a stable vX.Y.Z tag in ${repoUrl}`,
        );
      }
      chosenTag = explicitTag;
    } else {
      const ordered = [...stable].sort((a, b) => -compareTagStrings(a, b));
      for (const tag of ordered) {
        const sha = commitOfTag(dir, tag);
        if (sha !== null && isAncestor(dir, sha, mainSha)) {
          chosenTag = tag;
          break;
        }
      }
    }
    if (chosenTag === null) {
      throw new ReleaseError(
        `no stable release tag of ${repoUrl} is reachable from main; publish a tagged release first`,
      );
    }
    const sha = commitOfTag(dir, chosenTag);
    if (sha === null) throw new ReleaseError(`tag ${chosenTag} vanished while resolving`);
    if (!isAncestor(dir, sha, mainSha)) {
      throw new ReleaseError(
        `release ${chosenTag} is not reachable from ${repoUrl} main; refusing to deploy it`,
      );
    }
    verifyReleaseCommit(dir, sha, chosenTag);
    return { tag: chosenTag, sha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fetch `release` into `dest` as a detached checkout of the exact commit.
 *
 * The work happens in a staging directory that is renamed only after the
 * fetched commit is verified, so an interrupted fetch never leaves something
 * that looks like a finished release.
 */
export function fetchReleaseCheckout(
  repoUrl: string,
  release: ResolvedRelease,
  dest: string,
  stagingRoot: string,
): void {
  if (exists(dest)) {
    const head = runGit(['rev-parse', 'HEAD'], dest);
    if (head.status === 0 && head.stdout.trim() === release.sha) return;
    throw new ReleaseError(
      `${dest} already exists but is not the ${release.sha} checkout; remove it and retry`,
    );
  }
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const staging = join(stagingRoot, `staging-${release.sha}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    runGit(['init', '--quiet'], staging);
    runGit(['remote', 'add', 'origin', repoUrl], staging);
    let fetched = runGit(
      [
        'fetch',
        '--quiet',
        '--depth=1',
        'origin',
        `+refs/tags/${release.tag}:refs/tags/${release.tag}`,
      ],
      staging,
    );
    if (fetched.status !== 0) {
      fetched = runGit(['fetch', '--quiet', '--depth=1', 'origin', release.sha], staging);
    }
    if (fetched.status !== 0) {
      throw new ReleaseError(
        `could not fetch ${release.tag} (${release.sha}) from ${repoUrl}: ${fetched.stderr.trim()}`,
      );
    }
    const fetchedSha = gitOrThrow(
      ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
      staging,
    ).stdout.trim();
    if (fetchedSha !== release.sha) {
      throw new ReleaseError(
        `tag ${release.tag} moved: it resolved to ${release.sha} but now points at ${fetchedSha}`,
      );
    }
    gitOrThrow(['checkout', '--quiet', '--detach', fetchedSha], staging);
    const checkedOut = gitOrThrow(['rev-parse', 'HEAD'], staging).stdout.trim();
    if (checkedOut !== release.sha) {
      throw new ReleaseError(
        `checkout of ${release.tag} produced ${checkedOut}, not ${release.sha}`,
      );
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Read a file from a release checkout with a labelled error. */
export function readReleaseFile(releasePath: string, relative: string): string {
  try {
    return readFileSync(join(releasePath, relative), 'utf8');
  } catch (err) {
    throw new ReleaseError(`could not read ${relative} from ${releasePath}: ${errorText(err)}`);
  }
}
