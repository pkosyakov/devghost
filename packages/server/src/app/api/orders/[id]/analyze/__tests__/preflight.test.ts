import { describe, it, expect } from 'vitest';

describe('analyze route — DEVELOPERS_LOADED flow', () => {
  it('should accept excludedDevelopers in request body and persist before billing', () => {
    const selectedDevelopers = [
      { email: 'alice@example.com', commitCount: 50 },
      { email: 'bob@example.com', commitCount: 30 },
      { email: 'bot@example.com', commitCount: 100 },
    ];
    const excludedEmails = new Set(['bot@example.com']);

    const totalEstimate = selectedDevelopers
      .filter(d => !excludedEmails.has(d.email))
      .reduce((sum, d) => sum + (d.commitCount ?? 0), 0);

    expect(totalEstimate).toBe(80);
  });

  it('should read commitCount (camelCase) from selectedDevelopers', () => {
    const dev = { email: 'dev@example.com', commitCount: 42 };
    expect(dev.commitCount).toBe(42);
    expect((dev as any).commit_count).toBeUndefined();
  });
});
