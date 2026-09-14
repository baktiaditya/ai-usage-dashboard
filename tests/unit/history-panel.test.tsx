// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPanel } from '@/components/history-panel';
import type { CreditHistoryResult } from '@/lib/queries/history';
import type { ProviderCard } from '@/lib/queries/overview';
import type { MoneyString } from '@/lib/money';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('credit trend', () => {
  it('says the card rounds an amount it cannot chart, never that it is exact', async () => {
    const result: CreditHistoryResult = {
      metric: 'balance_change',
      provider: 'openrouter',
      range: '7d',
      availability: { available: true },
      deltas: [],
      series: [
        {
          observedAt: '2026-09-10T00:00:00.000Z',
          currency: 'USD',
          value: '100000000000000' as MoneyString,
        },
        {
          observedAt: '2026-09-11T00:00:00.000Z',
          currency: 'USD',
          value: '100000000000000.01' as MoneyString,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(result), { status: 200 })),
    );
    const cards = [{ provider: 'openrouter', label: 'OpenRouter' }] as unknown as ProviderCard[];

    render(<HistoryPanel cards={cards} timezone="UTC" />);

    const note = await screen.findByTestId('history-credit-trend-unplottable-USD');
    expect(note).toHaveTextContent(
      'The card shows the latest amount rounded to two decimal places.',
    );
    expect(note.textContent).not.toMatch(/exact figures/i);
  });
});
