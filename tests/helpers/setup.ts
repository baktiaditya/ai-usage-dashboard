import { installTypeOfServiceGuard } from '@/lib/socket-compat';

// Tests must never pick up the developer's real data directory. Every suite
// that needs configuration builds it explicitly via `loadConfig`.
delete process.env['AUD_DATA_DIR'];
// `getConfig` merges the collector environment file; point it at a path that
// cannot exist so a provisioned ~/.config/ai-usage-dashboard/collector.env
// never leaks real settings into a suite.
process.env['AUD_ENV_FILE'] = '/nonexistent/ai-usage-dashboard-tests/collector.env';

// The product installs this before its first fetch (src/instrumentation.ts and
// src/lib/collector/cli.ts); tests fetch too, so they install the same guard.
installTypeOfServiceGuard();

// `@testing-library/jest-dom` needs a DOM and is imported by the component
// suites themselves, which opt into the jsdom environment per file.
