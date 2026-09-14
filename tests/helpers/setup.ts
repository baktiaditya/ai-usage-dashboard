// Tests must never pick up the developer's real credentials or data directory.
// Every suite that needs configuration builds it explicitly via `loadConfig`.
delete process.env['DEEPSEEK_API_KEY'];
delete process.env['OPENROUTER_MANAGEMENT_KEY'];
delete process.env['AUD_DATA_DIR'];
// `getConfig` merges the collector environment file; point it at a path that
// cannot exist so a provisioned ~/.config/ai-usage-dashboard/collector.env
// never leaks real keys into a suite.
process.env['AUD_ENV_FILE'] = '/nonexistent/ai-usage-dashboard-tests/collector.env';

// `@testing-library/jest-dom` needs a DOM and is imported by the component
// suites themselves, which opt into the jsdom environment per file.
