// Tests must never pick up the developer's real credentials or data directory.
// Every suite that needs configuration builds it explicitly via `loadConfig`.
delete process.env['DEEPSEEK_API_KEY'];
delete process.env['OPENROUTER_MANAGEMENT_KEY'];
delete process.env['AUD_DATA_DIR'];

// `@testing-library/jest-dom` needs a DOM and is imported by the component
// suites themselves, which opt into the jsdom environment per file.
