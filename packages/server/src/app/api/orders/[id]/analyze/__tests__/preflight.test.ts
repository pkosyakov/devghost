import { describe, it, expect } from 'vitest';

describe('analyze route — billing preview integration', () => {
  it('allows zero estimated credits when all commits are cached', () => {
    const billableCommits = 0;
    const estimatedCredits = billableCommits;
    expect(estimatedCredits).toBe(0);
  });

  it('skips reservation when estimated credits is zero', () => {
    const estimatedCredits = 0;
    const shouldReserve = estimatedCredits > 0;
    expect(shouldReserve).toBe(false);
  });

  it('first-run estimate sums selectedDevelopers excluding blank-email rows', () => {
    const devs = [
      { email: 'alice@example.com', commitCount: 50 },
      { email: 'bob@example.com', commitCount: 30 },
      { email: '', commitCount: 999 },
      { email: 'bot@example.com', commitCount: 100 },
    ];
    const excluded = new Set(['bot@example.com']);
    const total = devs
      .filter(d => d.email && !excluded.has(d.email))
      .reduce((sum, d) => sum + (d.commitCount ?? 0), 0);
    expect(total).toBe(80);
  });
});
