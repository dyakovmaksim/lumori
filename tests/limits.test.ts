import { describe, it, expect } from 'vitest';
import { parseLimits } from '../server/limits';
describe('Codex quota data', () => {
  it('keeps separate quota windows and buckets while omitting account and credit identifiers', () => {
    const result = parseLimits(
      {
        accountId: 'private-account',
        rateLimitResetCredits: { credits: [{ id: 'private-credit' }] },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 71, windowDurationMins: 300, resetsAt: 1789043693 },
            secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1789630493 },
          },
          reserve: {
            limitName: 'gpt-reserve',
            primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null },
          },
        },
      },
      123,
    );
    expect(result.available).toBe(true);
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].windows[0]).toEqual({
      id: 'primary',
      usedPercent: 71,
      durationMinutes: 300,
      resetsAt: 1789043693000,
    });
    expect(result.buckets[1].windows[0].usedPercent).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('supports the legacy response and never invents zero usage for missing data', () => {
    expect(parseLimits({}).available).toBe(false);
    expect(parseLimits({ rateLimits: { primary: { usedPercent: null } } }).buckets).toEqual([]);
    expect(
      parseLimits({ rateLimits: { primary: { usedPercent: 105 } } }).buckets[0].windows[0]
        .usedPercent,
    ).toBe(100);
  });
});
