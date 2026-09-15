// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '@/components/settings-dialog';
import type { CredentialProvider, CredentialStatus } from '@/lib/domain';

// Fake key only.
const KEY = 'sk-fake-dialog-00000000wxyz';
const INVALID_MESSAGE = 'Enter the key exactly as issued: printable characters, no spaces.';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const unsaved = (provider: CredentialProvider): CredentialStatus => ({
  provider,
  configured: false,
  hint: null,
  updatedAt: null,
});

const savedNow = (provider: CredentialProvider, hint: string | null): CredentialStatus => ({
  provider,
  configured: true,
  hint,
  updatedAt: new Date().toISOString(),
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function stubApi({
  statuses = [unsaved('deepseek'), unsaved('openrouter')],
  list = async () => json({ credentials: statuses }),
  save = async (provider: CredentialProvider) => json({ credential: savedNow(provider, 'wxyz') }),
}: {
  statuses?: CredentialStatus[];
  list?: () => Promise<Response>;
  save?: (provider: CredentialProvider, secret: string) => Promise<Response>;
} = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, method, body });
      const provider = url.split('/').pop() as CredentialProvider;
      if (method === 'PUT') return save(provider, (body as { secret: string }).secret);
      if (method === 'DELETE') return json({ credential: unsaved(provider) });
      return list();
    }),
  );
  return calls;
}

async function openDialog() {
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open settings' });
  await user.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  await waitFor(() => expect(screen.queryByTestId('settings-loading')).not.toBeInTheDocument());
  return { user, opener, dialog };
}

describe('opening and closing', () => {
  it('moves focus to the DeepSeek input and returns it to the opener on Escape', async () => {
    stubApi();
    const { user, opener, dialog } = await openDialog();

    expect(within(dialog).getByLabelText('OpenRouter Management Key')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText('DeepSeek API Key')).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('closes on Cancel and returns focus to the opener', async () => {
    stubApi();
    const { user, opener } = await openDialog();

    await user.click(screen.getByTestId('settings-close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('shows the intro and a loading line until the statuses arrive', async () => {
    let answer: (res: Response) => void = () => {};
    stubApi({ list: () => new Promise<Response>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(await screen.findByTestId('settings-loading')).toHaveTextContent('Loading saved keys…');
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Keys are stored in the local dashboard database and used from the next collection. Use Refresh on a card to collect now.',
    );

    answer(json({ credentials: [unsaved('deepseek'), unsaved('openrouter')] }));
    await waitFor(() => expect(screen.queryByTestId('settings-loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('settings-status-deepseek')).toHaveTextContent('Not set');
  });
});

describe('statuses', () => {
  it('renders statuses from GET with inputs that always start empty', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString();
    const calls = stubApi({
      statuses: [
        { provider: 'deepseek', configured: true, hint: '1234', updatedAt: fiveMinutesAgo },
        { provider: 'openrouter', configured: true, hint: null, updatedAt: fiveMinutesAgo },
      ],
    });
    await openDialog();

    expect(calls[0]).toMatchObject({ url: '/api/settings/credentials', method: 'GET' });
    expect(screen.getByTestId('settings-status-deepseek')).toHaveTextContent(
      /^Saved ••••1234 · updated 5m ago$/,
    );
    expect(screen.getByTestId('settings-status-openrouter')).toHaveTextContent(
      /^Saved · updated 5m ago$/,
    );
    for (const provider of ['deepseek', 'openrouter']) {
      const input = screen.getByTestId(`settings-input-${provider}`);
      expect(input).toHaveValue('');
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('spellcheck', 'false');
    }
    expect(screen.getByTestId('settings-remove-deepseek')).toBeInTheDocument();
  });

  it('explains the OpenRouter Management key and links to where it is created', async () => {
    stubApi();
    const { dialog } = await openDialog();

    expect(dialog).toHaveTextContent(
      'Must be a Management key; ordinary inference keys are rejected.',
    );
    const link = within(dialog).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://openrouter.ai/settings/management-keys');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(screen.queryByTestId('settings-remove-deepseek')).not.toBeInTheDocument();
  });
});

describe('saving', () => {
  it('sends a PUT only for filled fields, clears it, and stays open', async () => {
    const calls = stubApi();
    const { user } = await openDialog();

    expect(screen.getByTestId('settings-save')).toBeDisabled();
    await user.type(screen.getByTestId('settings-input-openrouter'), KEY);
    await user.click(screen.getByTestId('settings-save'));

    expect(await screen.findByTestId('settings-success')).toHaveTextContent('Saved.');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      { url: '/api/settings/credentials/openrouter', method: 'PUT', body: { secret: KEY } },
    ]);
    expect(screen.getByTestId('settings-input-openrouter')).toHaveValue('');
    expect(screen.getByTestId('settings-status-openrouter')).toHaveTextContent('Saved ••••wxyz');
    expect(screen.getByTestId('settings-status-deepseek')).toHaveTextContent('Not set');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByTestId('settings-save')).toBeDisabled();
  });

  it('keeps the value of a failed PUT and shows the server message in an alert', async () => {
    const calls = stubApi({
      save: async (provider) =>
        provider === 'deepseek'
          ? json({ error: { code: 'invalid_secret', message: INVALID_MESSAGE } }, 400)
          : json({ credential: savedNow(provider, 'wxyz') }),
    });
    const { user } = await openDialog();

    await user.type(screen.getByTestId('settings-input-deepseek'), 'sk-bad key');
    await user.type(screen.getByTestId('settings-input-openrouter'), KEY);
    await user.click(screen.getByTestId('settings-save'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'settings-error');
    expect(alert).toHaveTextContent(INVALID_MESSAGE);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual([
      '/api/settings/credentials/deepseek',
      '/api/settings/credentials/openrouter',
    ]);
    expect(screen.getByTestId('settings-input-deepseek')).toHaveValue('sk-bad key');
    expect(screen.getByTestId('settings-status-deepseek')).toHaveTextContent('Not set');
    expect(screen.getByTestId('settings-input-openrouter')).toHaveValue('');
    expect(screen.getByTestId('settings-status-openrouter')).toHaveTextContent('Saved ••••wxyz');
  });

  it('never writes a key to the console, browser storage, or the URL', async () => {
    stubApi();
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m)),
      vi.spyOn(Storage.prototype, 'setItem'),
    ];
    const { user } = await openDialog();

    await user.type(screen.getByTestId('settings-input-deepseek'), KEY);
    await user.click(screen.getByTestId('settings-save'));
    await screen.findByTestId('settings-success');

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY.slice(0, -4));
    }
    expect(window.location.href).not.toContain(KEY.slice(0, -4));
  });
});

describe('removing', () => {
  it('sends DELETE immediately, without a confirm prompt', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const calls = stubApi({ statuses: [savedNow('deepseek', '1234'), unsaved('openrouter')] });
    const { user } = await openDialog();

    await user.click(screen.getByTestId('settings-remove-deepseek'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-status-deepseek')).toHaveTextContent('Not set'),
    );
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      { url: '/api/settings/credentials/deepseek', method: 'DELETE', body: undefined },
    ]);
    expect(screen.queryByTestId('settings-remove-deepseek')).not.toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });
});
