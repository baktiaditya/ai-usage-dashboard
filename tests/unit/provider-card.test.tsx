// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderCardView } from '@/components/provider-card';
import type { ProviderCard } from '@/lib/queries/overview';
import type { MoneyString } from '@/lib/money';

function card(overrides: Partial<ProviderCard> = {}): ProviderCard {
  return {
    provider: 'codex',
    label: 'Codex',
    kind: 'quota',
    status: 'healthy',
    statusReason: 'collected recently',
    advisory: {
      state: 'ok',
      reasons: [
        {
          subject: 'codex',
          metric: 'quota_remaining_percent',
          observed: 'fine',
          threshold: null,
          message: 'All good.',
        },
      ],
    },
    sourceObservedAt: '2026-09-12T11:58:00.000Z',
    lastSuccessfulCollectionAt: '2026-09-12T11:58:01.000Z',
    dataAgeMs: 120_000,
    freshnessBudgetMs: 900_000,
    sourceVersion: 'codex-cli/0.154.0',
    schemaVersion: 1,
    windows: [
      {
        bucketId: 'codex',
        windowKind: 'primary',
        usedPercent: 37,
        windowDurationMinutes: 300,
        resetsAt: '2026-09-12T17:00:00.000Z',
        remainingPercent: 63,
        label: '5 hour',
        resetPassed: false,
      },
      {
        bucketId: 'codex',
        windowKind: 'secondary',
        usedPercent: 52,
        windowDurationMinutes: 10080,
        resetsAt: '2026-09-19T00:00:00.000Z',
        remainingPercent: 48,
        label: '7 day',
        resetPassed: false,
      },
    ],
    balances: [],
    usageAllowed: true,
    limitReachedCode: null,
    diagnostics: {
      errorCode: null,
      hint: null,
      safeMessage: null,
      retryCount: 0,
      lastAttemptAt: '2026-09-12T11:58:01.000Z',
    },
    showingLastKnownValues: false,
    ...overrides,
  };
}

function renderCard(data: ProviderCard) {
  return render(<ProviderCardView card={data} timezone="Asia/Jakarta" onRefreshed={vi.fn()} />);
}

describe('quota card', () => {
  it('renders every window with its own label, remaining, used and reset time', () => {
    renderCard(card());

    const five = screen.getByTestId('window-codex-primary');
    expect(within(five).getByText('5 hour')).toBeInTheDocument();
    expect(within(five).getByText(/63\.0%/)).toBeInTheDocument();
    // Source fidelity is preserved alongside the derived value.
    expect(within(five).getByText(/used 37\.0%/)).toBeInTheDocument();

    const seven = screen.getByTestId('window-codex-secondary');
    expect(within(seven).getByText('7 day')).toBeInTheDocument();
    expect(within(seven).getByText(/48\.0%/)).toBeInTheDocument();

    // One bucket: its name would only repeat what the label already says.
    expect(within(five).queryByText('codex')).not.toBeInTheDocument();
  });

  it('names the bucket only when two windows would otherwise read the same', () => {
    const base = card().windows[0]!;
    renderCard(
      card({
        windows: [
          { ...base, bucketId: 'codex', windowKind: 'primary' },
          { ...base, bucketId: 'codex_other', windowKind: 'other_primary' },
        ],
      }),
    );
    expect(
      within(screen.getByTestId('window-codex-primary')).getByText('codex'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('window-codex-other_primary')).getByText('codex_other'),
    ).toBeInTheDocument();
  });

  it('exposes each progress bar to assistive technology', () => {
    renderCard(card());
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute('aria-valuenow', '63');
    expect(bars[0]).toHaveAccessibleName(/5 hour quota remaining/);
  });

  it('says when a reset time is unknown rather than showing a blank', () => {
    renderCard(
      card({
        windows: [
          {
            bucketId: 'codex',
            windowKind: 'primary',
            usedPercent: 10,
            windowDurationMinutes: null,
            resetsAt: null,
            remainingPercent: 90,
            label: 'primary',
            resetPassed: false,
          },
        ],
      }),
    );
    expect(screen.getByText(/reset time unknown/)).toBeInTheDocument();
  });

  it('marks a reset time that has already passed', () => {
    renderCard(
      card({
        windows: [
          {
            bucketId: 'codex',
            windowKind: 'primary',
            usedPercent: 95,
            windowDurationMinutes: 300,
            resetsAt: '2026-09-12T11:00:00.000Z',
            remainingPercent: 5,
            label: '5 hour',
            resetPassed: true,
          },
        ],
      }),
    );
    expect(screen.getByText(/already passed/)).toBeInTheDocument();
  });
});

describe('heading', () => {
  const LABELS = {
    codex: 'Codex',
    claude: 'Claude Code',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
  } as const;

  it.each(Object.entries(LABELS) as [keyof typeof LABELS, string][])(
    'shows the %s mark beside the label without changing the heading name',
    (provider, label) => {
      renderCard(card({ provider, label }));

      const heading = screen.getByRole('heading', { name: label });
      const logo = within(heading).getByTestId(`logo-${provider}`);
      expect(logo).toHaveAttribute('aria-hidden', 'true');
      expect(logo.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    },
  );

  it('fills each mark with its brand color, and OpenRouter from a theme token', () => {
    const fills: Record<string, string> = {
      codex: 'url(#provider-logo-codex-gradient)',
      claude: 'var(--logo-claude)',
      deepseek: 'var(--logo-deepseek)',
      openrouter: 'var(--logo-openrouter)',
    };
    for (const [provider, label] of Object.entries(LABELS) as [keyof typeof LABELS, string][]) {
      const { unmount } = renderCard(card({ provider, label }));
      const path = screen.getByTestId(`logo-${provider}`).querySelector('path');
      expect(path?.getAttribute('style'), provider).toContain(fills[provider]);
      unmount();
    }
  });
});

describe('card states', () => {
  it.each([
    ['healthy', 'Healthy'],
    ['stale', 'Stale'],
    ['unavailable', 'Unavailable'],
    ['error', 'Error'],
  ] as const)('renders the %s state with a text label, not colour alone', (status, label) => {
    renderCard(card({ status, showingLastKnownValues: status !== 'healthy' }));
    expect(screen.getByTestId('status-codex')).toHaveTextContent(label);
  });

  it('warns that values are last known when the card is not healthy', () => {
    renderCard(card({ status: 'stale', showingLastKnownValues: true, dataAgeMs: 3_600_000 }));
    const banner = screen.getByTestId('last-known-codex');
    expect(banner).toHaveTextContent(/not current/i);
    expect(banner).toHaveTextContent(/1h ago/);
  });

  it('shows no last-known warning on a healthy card', () => {
    renderCard(card());
    expect(screen.queryByTestId('last-known-codex')).not.toBeInTheDocument();
  });

  it('shows an empty state with a setup hint when nothing was ever collected', () => {
    renderCard(
      card({
        status: 'unavailable',
        windows: [],
        sourceObservedAt: null,
        dataAgeMs: null,
        showingLastKnownValues: false,
        statusReason: 'no observation has been collected yet',
        diagnostics: {
          errorCode: 'not_configured',
          hint: 'Credential or source is not configured yet.',
          safeMessage: null,
          retryCount: 0,
          lastAttemptAt: null,
        },
      }),
    );
    expect(screen.getByText(/Nothing collected yet/)).toBeInTheDocument();
    expect(screen.getByText(/not configured yet/)).toBeInTheDocument();
    expect(screen.getByTestId('age-codex')).toHaveTextContent('—');
  });
});

describe('advisories', () => {
  it.each([
    ['ok', 'OK'],
    ['watch', 'Watch'],
    ['switch_suggested', 'Switch suggested'],
    ['unknown', 'Unknown'],
  ] as const)('renders the %s advisory', (state, label) => {
    renderCard(
      card({
        advisory: {
          state,
          reasons: [
            { subject: 's', metric: 'freshness', observed: 'o', threshold: null, message: 'm' },
          ],
        },
      }),
    );
    expect(screen.getByTestId('advisory-codex')).toHaveTextContent(label);
  });

  it('shows the reason and the threshold that fired', () => {
    renderCard(
      card({
        advisory: {
          state: 'switch_suggested',
          reasons: [
            {
              subject: 'codex:primary',
              metric: 'quota_remaining_percent',
              observed: '8.0%',
              threshold: '<= 10%',
              message: 'Only 8.0% of this window remains.',
            },
          ],
        },
      }),
    );
    expect(screen.getByText(/Only 8\.0% of this window remains/)).toBeInTheDocument();
    expect(screen.getByText(/observed 8\.0% · threshold <= 10%/)).toBeInTheDocument();
  });
});

describe('credit card', () => {
  const creditCard = card({
    provider: 'deepseek',
    label: 'DeepSeek',
    kind: 'credit',
    windows: [],
    balances: [
      {
        currency: 'CNY',
        totalBalance: '110' as MoneyString,
        grantedBalance: '10' as MoneyString,
        toppedUpBalance: '100' as MoneyString,
        totalCredits: null,
        totalUsage: null,
        remainingCredit: null,
        isAvailable: true,
      },
      {
        currency: 'USD',
        totalBalance: '15.42' as MoneyString,
        grantedBalance: null,
        toppedUpBalance: null,
        totalCredits: null,
        totalUsage: null,
        remainingCredit: null,
        isAvailable: true,
      },
    ],
  });

  it('renders each currency separately', () => {
    renderCard(creditCard);
    const cny = screen.getByTestId('balance-deepseek-CNY');
    const usd = screen.getByTestId('balance-deepseek-USD');
    expect(within(cny).getByText('110.00')).toBeInTheDocument();
    expect(within(usd).getByText('15.42')).toBeInTheDocument();
  });

  it('omits fields the provider did not report instead of showing zero', () => {
    renderCard(creditCard);
    const usd = screen.getByTestId('balance-deepseek-USD');
    // DeepSeek has no usage concept at all.
    expect(within(usd).queryByText('Total usage')).not.toBeInTheDocument();
    expect(within(usd).queryByText('Remaining')).not.toBeInTheDocument();
  });

  it('renders the full OpenRouter triple', () => {
    renderCard(
      card({
        provider: 'openrouter',
        label: 'OpenRouter',
        kind: 'credit',
        windows: [],
        balances: [
          {
            currency: 'USD',
            totalBalance: null,
            grantedBalance: null,
            toppedUpBalance: null,
            totalCredits: '100.5' as MoneyString,
            totalUsage: '25.75' as MoneyString,
            remainingCredit: '74.75' as MoneyString,
            isAvailable: null,
          },
        ],
      }),
    );
    const usd = screen.getByTestId('balance-openrouter-USD');
    expect(within(usd).getByText('Total credits')).toBeInTheDocument();
    expect(within(usd).getByText('100.50')).toBeInTheDocument();
    expect(within(usd).getByText('25.75')).toBeInTheDocument();
    expect(within(usd).getByText('74.75')).toBeInTheDocument();
  });

  it('flags an insufficient balance', () => {
    renderCard(
      card({
        provider: 'deepseek',
        kind: 'credit',
        windows: [],
        balances: [
          {
            currency: 'CNY',
            totalBalance: '0' as MoneyString,
            grantedBalance: null,
            toppedUpBalance: null,
            totalCredits: null,
            totalUsage: null,
            remainingCredit: null,
            isAvailable: false,
          },
        ],
      }),
    );
    expect(
      within(screen.getByTestId('balance-deepseek-CNY')).getByText('Insufficient for API'),
    ).toBeInTheDocument();
  });

  it('labels a usable balance as the provider verdict, not as card availability', () => {
    renderCard(creditCard);
    const usd = screen.getByTestId('balance-deepseek-USD');
    // "Available" beside an "Unavailable" card header read as a contradiction.
    expect(within(usd).getByText('API usable')).toBeInTheDocument();
    expect(within(usd).queryByText('Available')).not.toBeInTheDocument();
  });
});

describe('provenance and diagnostics', () => {
  it('always shows observation time, collection time and data age', () => {
    renderCard(card());
    expect(screen.getByText('Source observed')).toBeInTheDocument();
    expect(screen.getByText('Last collection')).toBeInTheDocument();
    expect(screen.getByTestId('age-codex')).toHaveTextContent('2m');
  });

  it('renders a refresh control per provider', () => {
    renderCard(card());
    expect(screen.getByTestId('refresh-codex')).toBeEnabled();
  });
});
