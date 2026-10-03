/**
 * The constrained runtime manifest, `scripts/install-runtime.env`.
 *
 * The manifest is data, never shell: two exact keys, parsed line by line, with
 * no `eval` and no command substitution. It pins the Node release the managed
 * installer provisions and the SHA-256 of that release's official Linux x64
 * archive.
 *
 * Compatibility with the repository's own requirements is validated rather
 * than assumed. Node 25 and later no longer distribute Corepack, so a manifest
 * that leaves the Node 24 line the application requires fails here instead of
 * producing a runtime without pnpm.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { parseStableTag } from './semver.ts';
import type { StableVersion } from './semver.ts';

export const RUNTIME_MANIFEST_PATH = 'scripts/install-runtime.env';

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

export interface RuntimeManifest {
  readonly nodeVersion: string;
  readonly nodeSha256LinuxX64: string;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Parse the manifest with strict key/format validation. */
export function parseRuntimeManifest(text: string): RuntimeManifest {
  let nodeVersion: string | undefined;
  let nodeSha256LinuxX64: string | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new ManifestError(`malformed manifest line (expected KEY=VALUE): ${line}`);
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case 'NODE_VERSION':
        if (nodeVersion !== undefined) throw new ManifestError('NODE_VERSION is repeated');
        nodeVersion = value;
        break;
      case 'NODE_SHA256_LINUX_X64':
        if (nodeSha256LinuxX64 !== undefined) {
          throw new ManifestError('NODE_SHA256_LINUX_X64 is repeated');
        }
        nodeSha256LinuxX64 = value;
        break;
      default:
        throw new ManifestError(
          `unknown manifest key ${JSON.stringify(key)}; the manifest is data, not shell`,
        );
    }
  }

  if (nodeVersion === undefined) throw new ManifestError('NODE_VERSION is missing');
  if (nodeSha256LinuxX64 === undefined) throw new ManifestError('NODE_SHA256_LINUX_X64 is missing');
  if (!VERSION_PATTERN.test(nodeVersion)) {
    throw new ManifestError(`NODE_VERSION must be X.Y.Z, got ${JSON.stringify(nodeVersion)}`);
  }
  if (!SHA256_PATTERN.test(nodeSha256LinuxX64)) {
    throw new ManifestError('NODE_SHA256_LINUX_X64 must be 64 lowercase hex characters');
  }
  return { nodeVersion, nodeSha256LinuxX64 };
}

/** The first version mentioned by an `engines.node` range such as `^24.15.0`. */
function floorVersionOfRange(range: string): StableVersion | null {
  const match = /\d+\.\d+\.\d+/.exec(range);
  if (match === null) return null;
  return parseStableTag(`v${match[0]}`);
}

export interface EngineRequirements {
  /** The contents of `.nvmrc`, e.g. `24`. */
  readonly nvmrc: string;
  /** `engines.node` from `package.json`, e.g. `^24.15.0`. */
  readonly enginesNode: string;
}

/**
 * Require the manifest to stay on the Node 24 line and satisfy `engines.node`.
 *
 * A repository that moves past Node 24 must replace the Corepack-based pnpm
 * provisioning step first; silently accepting the manifest would produce a
 * runtime the application cannot install with.
 */
export function validateManifestForEngine(
  manifest: RuntimeManifest,
  requirements: EngineRequirements,
): void {
  const pinned = parseStableTag(`v${manifest.nodeVersion}`);
  if (pinned === null) throw new ManifestError(`NODE_VERSION ${manifest.nodeVersion} is not X.Y.Z`);

  const nvmrcMinor = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(requirements.nvmrc.trim());
  if (nvmrcMinor === null) {
    throw new ManifestError(`.nvmrc is not a version line: ${JSON.stringify(requirements.nvmrc)}`);
  }
  const nvmrcMajor = Number(nvmrcMinor[1]);
  const nvmrcFull =
    nvmrcMinor[2] === undefined
      ? null
      : {
          major: nvmrcMajor,
          minor: Number(nvmrcMinor[2]),
          patch: Number(nvmrcMinor[3] ?? '0'),
        };

  if (pinned.major !== 24 || nvmrcMajor !== 24) {
    throw new ManifestError(
      `the managed runtime is fixed to the Node 24 line that ships Corepack (manifest ${manifest.nodeVersion}, .nvmrc ${JSON.stringify(requirements.nvmrc)}). Moving past Node 24 requires replacing the pnpm provisioning step first`,
    );
  }
  if (
    nvmrcFull !== null &&
    (pinned.minor < nvmrcFull.minor ||
      (pinned.minor === nvmrcFull.minor && pinned.patch < nvmrcFull.patch))
  ) {
    throw new ManifestError(
      `manifest Node ${manifest.nodeVersion} is older than .nvmrc ${requirements.nvmrc}`,
    );
  }

  const floor = floorVersionOfRange(requirements.enginesNode);
  if (floor === null) {
    throw new ManifestError(
      `engines.node ${JSON.stringify(requirements.enginesNode)} names no parseable version`,
    );
  }
  if (floor.major !== 24) {
    throw new ManifestError(
      `engines.node requires Node ${floor.major}, but the managed runtime is on the Node 24 line; replace the pnpm provisioning step first`,
    );
  }
  if (pinned.minor < floor.minor || (pinned.minor === floor.minor && pinned.patch < floor.patch)) {
    throw new ManifestError(
      `manifest Node ${manifest.nodeVersion} does not satisfy engines.node ${requirements.enginesNode}`,
    );
  }
}
