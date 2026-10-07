/**
 * The value set both scheduler renderers share.
 *
 * The systemd units and the launchd agents must name the same checkout,
 * interpreter, `PATH`, `CODEX_HOME`, environment file, data directory,
 * interval, host and port. Resolving those reads twice would let the two
 * schedulers drift, so both renderers call `resolveUnitValues()`. The
 * installer supplies the interpreter paths it resolved; the data directory,
 * interval, environment file, host and port come from the collector's own
 * configuration (shell exports, then `collector.env`, then defaults).
 */
import { getConfig } from './config';
import type { AppConfig, EnvLike } from './config';
import { collectorEnvFilePath } from './env-file';
import type { UnitValues } from './systemd-unit';

export interface UnitValueInputs {
  readonly env: EnvLike;
  readonly workdir: string;
  readonly path: string;
  readonly codexHome: string;
  readonly node: string;
  readonly tsx: string;
}

export interface ResolvedUnitValues {
  readonly values: UnitValues;
  readonly envFile: string;
  readonly config: AppConfig;
}

/**
 * Read the interpreter paths an installer resolved from its `AUD_UNIT_*`
 * exports. A missing value means the renderer was run by hand, so the error
 * names the `installer` that sets them.
 */
export function unitInputsFromEnv(env: EnvLike, installer: string): UnitValueInputs {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set; run ${installer} instead`);
    return value;
  };
  return {
    env,
    workdir: required('AUD_UNIT_WORKDIR'),
    path: required('AUD_UNIT_PATH'),
    codexHome: required('AUD_UNIT_CODEXHOME'),
    node: required('AUD_UNIT_NODE'),
    tsx: required('AUD_UNIT_TSX'),
  };
}

export function resolveUnitValues(inputs: UnitValueInputs): ResolvedUnitValues {
  const envFile = collectorEnvFilePath(inputs.env);
  const config = getConfig();
  return {
    envFile,
    config,
    values: {
      WORKDIR: inputs.workdir,
      PATH: inputs.path,
      CODEXHOME: inputs.codexHome,
      NODE: inputs.node,
      TSX: inputs.tsx,
      DATADIR: config.dataDir,
      ENVFILE: envFile,
      INTERVAL: String(config.collectIntervalMinutes),
      HOST: config.host,
      PORT: String(config.port),
    },
  };
}
