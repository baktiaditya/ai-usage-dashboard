/**
 * Validated managed-installation metadata.
 *
 * Three owner-only JSON documents live in the install root:
 *
 * - `state.json` — the authoritative record of what this root installed:
 *   detached tag/SHA provenance, the active and previous releases and runtimes,
 *   the effective configuration, launcher and unit ownership, and the owned
 *   Claude bridge. No keys, tokens, provider values, raw payloads, or complete
 *   environments are ever stored here.
 * - `operation.json` — a durable journal whose phase is persisted *before* the
 *   guarded effect, so recovery can tell a partially applied operation from a
 *   committed one.
 * - `data-ownership.json` — the record of databases this root's managed
 *   installation created. It outlives uninstall so reinstall can reuse the
 *   retained database instead of refusing it as unowned.
 *
 * Everything here is parsed as strict data. Unknown keys, wrong types, and
 * out-of-range values are refused rather than coerced.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { isAbsolute } from 'node:path';
import { readJsonFile, removeFile, writeFileAtomic } from './atomic.ts';

export const STATE_SCHEMA_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;
export const OWNERSHIP_SCHEMA_VERSION = 1;

export const STATE_FILE = 'state.json';
export const JOURNAL_FILE = 'operation.json';
export const OWNERSHIP_FILE = 'data-ownership.json';
export const LOCK_FILE = 'lifecycle.lock';

export class StateValidationError extends Error {
  override readonly name = 'StateValidationError';
}

export interface RuntimeRecord {
  readonly nodeVersion: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ManagedRelease {
  readonly tag: string;
  readonly sha: string;
  readonly runtime: RuntimeRecord;
}

export interface InstalledConfig {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly envFile: string;
  readonly host: string;
  readonly port: number;
  readonly intervalMinutes: number;
  readonly codexHome: string;
  readonly codexDir: string | null;
}

export interface BridgeRecord {
  readonly settingsPath: string;
  readonly command: string;
  readonly releasePath: string;
  readonly runtimePath: string;
  readonly appliedAt: string;
}

export interface InstallationState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly installationId: string;
  readonly installRoot: string;
  readonly launcherPath: string;
  readonly tag: string;
  readonly sha: string;
  readonly previous: ManagedRelease | null;
  readonly runtime: RuntimeRecord;
  readonly config: InstalledConfig;
  readonly bridge: BridgeRecord | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type JournalKind = 'install' | 'update' | 'uninstall';

export const INSTALL_PHASES = [
  'starting',
  'staged',
  'db-creating',
  'db-ready',
  'units-installed',
  'web-started',
  'collecting',
  'activated',
  'committed',
] as const;

export const UPDATE_PHASES = [
  'starting',
  'staged',
  'writers-stopped',
  'backed-up',
  'db-changing',
  'candidate-units',
  'candidate-web',
  'bridge-refreshed',
  'activated',
  'committed',
] as const;

export const UNINSTALL_PHASES = [
  'starting',
  'writers-stopped',
  'bridge-removed',
  'units-removed',
  'launcher-removed',
  'committed',
] as const;

export type InstallPhase = (typeof INSTALL_PHASES)[number];
export type UpdatePhase = (typeof UPDATE_PHASES)[number];
export type UninstallPhase = (typeof UNINSTALL_PHASES)[number];
export type JournalPhase = InstallPhase | UpdatePhase | UninstallPhase;

export interface ServiceSnapshot {
  /** Installed unit file contents by unit name; null when absent. */
  readonly unitFiles: Record<string, string | null>;
  /** `systemctl --user is-enabled` output by unit name. */
  readonly enabled: Record<string, string>;
  /** `systemctl --user is-active` output by unit name. */
  readonly active: Record<string, string>;
  readonly linger: string;
}

export interface OperationJournal {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly operationId: string;
  readonly kind: JournalKind;
  readonly phase: JournalPhase;
  readonly pid: number;
  readonly root: string;
  readonly candidate: ManagedRelease | null;
  readonly previous: ManagedRelease | null;
  readonly backupPath: string | null;
  readonly snapshot: ServiceSnapshot | null;
  /** Set when this install recorded the new database in the ownership record. */
  readonly dbOwnershipRecorded: boolean;
  readonly failed: string | null;
  readonly notes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OwnershipEntry {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly installationId: string;
  readonly createdAt: string;
}

export interface OwnershipRecord {
  readonly schemaVersion: typeof OWNERSHIP_SCHEMA_VERSION;
  readonly entries: readonly OwnershipEntry[];
}

export const UNIT_NAMES = [
  'ai-usage-dashboard-collector.service',
  'ai-usage-dashboard-collector.timer',
  'ai-usage-dashboard-web.service',
] as const;
export type UnitName = (typeof UNIT_NAMES)[number];

// ---------------------------------------------------------------------------
// Primitive validation
// ---------------------------------------------------------------------------

function fail(label: string, message: string): never {
  throw new StateValidationError(`${label}: ${message}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label, 'must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(label, `unknown key ${JSON.stringify(key)}`);
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(label, 'must be a non-empty string');
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(label, 'must be a boolean');
  return value;
}

function asInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(label, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asAbsolutePath(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!isAbsolute(text)) fail(label, `must be an absolute path (got ${JSON.stringify(text)})`);
  return text;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(label, 'must be an array');
  return value;
}

function asIsoTimestamp(value: unknown, label: string): string {
  const text = asString(value, label);
  if (Number.isNaN(Date.parse(text))) fail(label, 'must be an ISO timestamp');
  return text;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function validateRuntimeRecord(value: unknown, label = 'runtime'): RuntimeRecord {
  const record = asRecord(value, label);
  assertKnownKeys(record, ['nodeVersion', 'path', 'sha256'], label);
  const nodeVersion = asString(record['nodeVersion'], `${label}.nodeVersion`);
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    fail(`${label}.nodeVersion`, 'must be X.Y.Z');
  }
  const sha256 = asString(record['sha256'], `${label}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256))
    fail(`${label}.sha256`, 'must be 64 lowercase hex characters');
  return {
    nodeVersion,
    path: asAbsolutePath(record['path'], `${label}.path`),
    sha256,
  };
}

export function validateManagedRelease(value: unknown, label = 'release'): ManagedRelease {
  const record = asRecord(value, label);
  assertKnownKeys(record, ['tag', 'sha', 'runtime'], label);
  const tag = asString(record['tag'], `${label}.tag`);
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    fail(`${label}.tag`, 'must be a stable vX.Y.Z tag');
  const sha = asString(record['sha'], `${label}.sha`);
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${label}.sha`, 'must be a 40-character commit SHA');
  return { tag, sha, runtime: validateRuntimeRecord(record['runtime'], `${label}.runtime`) };
}

export function validateInstalledConfig(value: unknown, label = 'config'): InstalledConfig {
  const record = asRecord(value, label);
  assertKnownKeys(
    record,
    [
      'dataDir',
      'databasePath',
      'envFile',
      'host',
      'port',
      'intervalMinutes',
      'codexHome',
      'codexDir',
    ],
    label,
  );
  return {
    dataDir: asAbsolutePath(record['dataDir'], `${label}.dataDir`),
    databasePath: asAbsolutePath(record['databasePath'], `${label}.databasePath`),
    envFile: asAbsolutePath(record['envFile'], `${label}.envFile`),
    host: asString(record['host'], `${label}.host`),
    port: asInteger(record['port'], `${label}.port`, 1, 65535),
    intervalMinutes: asInteger(record['intervalMinutes'], `${label}.intervalMinutes`, 1, 1440),
    codexHome: asAbsolutePath(record['codexHome'], `${label}.codexHome`),
    codexDir:
      record['codexDir'] === null ? null : asAbsolutePath(record['codexDir'], `${label}.codexDir`),
  };
}

export function validateBridgeRecord(value: unknown, label = 'bridge'): BridgeRecord {
  const record = asRecord(value, label);
  assertKnownKeys(
    record,
    ['settingsPath', 'command', 'releasePath', 'runtimePath', 'appliedAt'],
    label,
  );
  return {
    settingsPath: asAbsolutePath(record['settingsPath'], `${label}.settingsPath`),
    command: asString(record['command'], `${label}.command`),
    releasePath: asAbsolutePath(record['releasePath'], `${label}.releasePath`),
    runtimePath: asAbsolutePath(record['runtimePath'], `${label}.runtimePath`),
    appliedAt: asIsoTimestamp(record['appliedAt'], `${label}.appliedAt`),
  };
}

export function validateState(value: unknown): InstallationState {
  const record = asRecord(value, 'state');
  assertKnownKeys(
    record,
    [
      'schemaVersion',
      'installationId',
      'installRoot',
      'launcherPath',
      'tag',
      'sha',
      'previous',
      'runtime',
      'config',
      'bridge',
      'createdAt',
      'updatedAt',
    ],
    'state',
  );
  if (record['schemaVersion'] !== STATE_SCHEMA_VERSION) {
    fail('state.schemaVersion', `expected ${STATE_SCHEMA_VERSION}`);
  }
  const tag = asString(record['tag'], 'state.tag');
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    fail('state.tag', 'must be a stable vX.Y.Z tag');
  const sha = asString(record['sha'], 'state.sha');
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('state.sha', 'must be a 40-character commit SHA');
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    installationId: asString(record['installationId'], 'state.installationId'),
    installRoot: asAbsolutePath(record['installRoot'], 'state.installRoot'),
    launcherPath: asAbsolutePath(record['launcherPath'], 'state.launcherPath'),
    tag,
    sha,
    previous:
      record['previous'] === null
        ? null
        : validateManagedRelease(record['previous'], 'state.previous'),
    runtime: validateRuntimeRecord(record['runtime'], 'state.runtime'),
    config: validateInstalledConfig(record['config'], 'state.config'),
    bridge:
      record['bridge'] === null ? null : validateBridgeRecord(record['bridge'], 'state.bridge'),
    createdAt: asIsoTimestamp(record['createdAt'], 'state.createdAt'),
    updatedAt: asIsoTimestamp(record['updatedAt'], 'state.updatedAt'),
  };
}

function validateServiceSnapshot(value: unknown): ServiceSnapshot {
  const record = asRecord(value, 'journal.snapshot');
  assertKnownKeys(record, ['unitFiles', 'enabled', 'active', 'linger'], 'journal.snapshot');
  const unitMap = (raw: unknown, label: string): Record<string, string | null> => {
    const map = asRecord(raw, label);
    assertKnownKeys(map, UNIT_NAMES, label);
    const out: Record<string, string | null> = {};
    for (const unit of UNIT_NAMES) {
      const entry = map[unit];
      out[unit] = entry === null ? null : asString(entry, `${label}.${unit}`);
    }
    return out;
  };
  const stringMap = (raw: unknown, label: string): Record<string, string> => {
    const map = asRecord(raw, label);
    assertKnownKeys(map, UNIT_NAMES, label);
    const out: Record<string, string> = {};
    for (const unit of UNIT_NAMES) out[unit] = asString(map[unit], `${label}.${unit}`);
    return out;
  };
  return {
    unitFiles: unitMap(record['unitFiles'], 'journal.snapshot.unitFiles'),
    enabled: stringMap(record['enabled'], 'journal.snapshot.enabled'),
    active: stringMap(record['active'], 'journal.snapshot.active'),
    linger: asString(record['linger'], 'journal.snapshot.linger'),
  };
}

function phaseListFor(kind: JournalKind): readonly JournalPhase[] {
  switch (kind) {
    case 'install':
      return INSTALL_PHASES;
    case 'update':
      return UPDATE_PHASES;
    case 'uninstall':
      return UNINSTALL_PHASES;
  }
}

export function validateJournal(value: unknown): OperationJournal {
  const record = asRecord(value, 'journal');
  assertKnownKeys(
    record,
    [
      'schemaVersion',
      'operationId',
      'kind',
      'phase',
      'pid',
      'root',
      'candidate',
      'previous',
      'backupPath',
      'snapshot',
      'dbOwnershipRecorded',
      'failed',
      'notes',
      'createdAt',
      'updatedAt',
    ],
    'journal',
  );
  if (record['schemaVersion'] !== JOURNAL_SCHEMA_VERSION) {
    fail('journal.schemaVersion', `expected ${JOURNAL_SCHEMA_VERSION}`);
  }
  const kind = asString(record['kind'], 'journal.kind');
  if (kind !== 'install' && kind !== 'update' && kind !== 'uninstall') {
    fail('journal.kind', `unknown operation kind ${JSON.stringify(kind)}`);
  }
  const phase = asString(record['phase'], 'journal.phase');
  if (!(phaseListFor(kind) as readonly string[]).includes(phase)) {
    fail('journal.phase', `${JSON.stringify(phase)} is not a phase of a ${kind} operation`);
  }
  const notes = asArray(record['notes'], 'journal.notes').map((note, i) =>
    asString(note, `journal.notes[${i}]`),
  );
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operationId: asString(record['operationId'], 'journal.operationId'),
    kind,
    phase: phase as JournalPhase,
    pid: asInteger(record['pid'], 'journal.pid', 1, Number.MAX_SAFE_INTEGER),
    root: asAbsolutePath(record['root'], 'journal.root'),
    candidate:
      record['candidate'] === null
        ? null
        : validateManagedRelease(record['candidate'], 'journal.candidate'),
    previous:
      record['previous'] === null
        ? null
        : validateManagedRelease(record['previous'], 'journal.previous'),
    backupPath:
      record['backupPath'] === null
        ? null
        : asAbsolutePath(record['backupPath'], 'journal.backupPath'),
    snapshot: record['snapshot'] === null ? null : validateServiceSnapshot(record['snapshot']),
    dbOwnershipRecorded: asBoolean(record['dbOwnershipRecorded'], 'journal.dbOwnershipRecorded'),
    failed: record['failed'] === null ? null : asString(record['failed'], 'journal.failed'),
    notes,
    createdAt: asIsoTimestamp(record['createdAt'], 'journal.createdAt'),
    updatedAt: asIsoTimestamp(record['updatedAt'], 'journal.updatedAt'),
  };
}

export function validateOwnership(value: unknown): OwnershipRecord {
  const record = asRecord(value, 'ownership');
  assertKnownKeys(record, ['schemaVersion', 'entries'], 'ownership');
  if (record['schemaVersion'] !== OWNERSHIP_SCHEMA_VERSION) {
    fail('ownership.schemaVersion', `expected ${OWNERSHIP_SCHEMA_VERSION}`);
  }
  const entries = asArray(record['entries'], 'ownership.entries').map((entry, i) => {
    const item = asRecord(entry, `ownership.entries[${i}]`);
    assertKnownKeys(
      item,
      ['dataDir', 'databasePath', 'installationId', 'createdAt'],
      `ownership.entries[${i}]`,
    );
    return {
      dataDir: asAbsolutePath(item['dataDir'], `ownership.entries[${i}].dataDir`),
      databasePath: asAbsolutePath(item['databasePath'], `ownership.entries[${i}].databasePath`),
      installationId: asString(item['installationId'], `ownership.entries[${i}].installationId`),
      createdAt: asIsoTimestamp(item['createdAt'], `ownership.entries[${i}].createdAt`),
    };
  });
  return { schemaVersion: OWNERSHIP_SCHEMA_VERSION, entries };
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

export function readState(root: string): InstallationState | null {
  return readJsonFile(`${root}/${STATE_FILE}`, 'installation state', validateState);
}

export function writeState(root: string, state: InstallationState): void {
  writeFileAtomic(`${root}/${STATE_FILE}`, `${JSON.stringify(state, null, 2)}\n`);
}

export function readJournal(root: string): OperationJournal | null {
  return readJsonFile(`${root}/${JOURNAL_FILE}`, 'operation journal', validateJournal);
}

export function writeJournal(root: string, journal: OperationJournal): void {
  writeFileAtomic(`${root}/${JOURNAL_FILE}`, `${JSON.stringify(journal, null, 2)}\n`);
}

export function clearJournal(root: string): void {
  removeFile(`${root}/${JOURNAL_FILE}`);
}

export function readOwnership(root: string): OwnershipRecord {
  const record = readJsonFile(
    `${root}/${OWNERSHIP_FILE}`,
    'data ownership record',
    validateOwnership,
  );
  return record ?? { schemaVersion: OWNERSHIP_SCHEMA_VERSION, entries: [] };
}

export function writeOwnership(root: string, record: OwnershipRecord): void {
  writeFileAtomic(`${root}/${OWNERSHIP_FILE}`, `${JSON.stringify(record, null, 2)}\n`);
}

/** The phase ordering index; higher means further into the operation. */
export function phaseIndex(kind: JournalKind, phase: JournalPhase): number {
  return (phaseListFor(kind) as readonly string[]).indexOf(phase);
}

export function isValidPhase(kind: JournalKind, phase: string): phase is JournalPhase {
  return (phaseListFor(kind) as readonly string[]).includes(phase);
}
