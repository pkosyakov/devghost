import { describe, it, expect } from 'vitest';
import {
  spreadEffort,
  collectDaysBack,
  distributeEvenly,
  distributeProRata,
  type SpreadCommit,
} from '../utils';
import Decimal from 'decimal.js';

// Helper: make a commit with a specific UTC date string (YYYY-MM-DD)
function mkCommit(sha: string, dateStr: string, effortHours: number): SpreadCommit {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    sha,
    authorDate: new Date(Date.UTC(y, m - 1, d, 12, 0, 0)),
    effortHours,
  };
}

// Helper: sum of dayMap values
function sumDayMap(dayMap: Map<string, number>): number {
  let total = 0;
  for (const v of dayMap.values()) total += v;
  return Math.round(total * 100) / 100;
}

// Helper: sum of dailyEffortRows
function sumRows(rows: { effortHours: number }[]): number {
  let total = 0;
  for (const r of rows) total += r.effortHours;
  return Math.round(total * 100) / 100;
}

// Helper: sum of input commits
function sumInputEffort(commits: SpreadCommit[]): number {
  let total = 0;
  for (const c of commits) total += c.effortHours;
  return Math.round(total * 100) / 100;
}

describe('collectDaysBack', () => {
  // Test 5: Boundary excludes days
  it('stops at boundary (exclusive)', () => {
    // Wednesday 2026-02-18, boundary Monday 2026-02-16
    const days = collectDaysBack('2026-02-18', '2026-02-16', 5);
    // Wed -> Tue (Mon is boundary, excluded)
    expect(days).toEqual(['2026-02-18', '2026-02-17']);
  });

  // Test 6: Boundary on Saturday, next commit Monday
  it('boundary priority over weekend skip', () => {
    // Monday 2026-02-16, boundary Saturday 2026-02-14
    const days = collectDaysBack('2026-02-16', '2026-02-14', 5);
    // Mon — boundary check: Mon > Sat OK — not weekend — include
    // Sun — boundary check: Sun > Sat OK — weekend, SKIP
    // Sat — boundary check: Sat <= Sat — STOP
    expect(days).toEqual(['2026-02-16']);
  });

  // Test 7: Sunday commit
  it('Sunday commit: own day included, Sat skipped', () => {
    // Sunday 2026-02-15
    const days = collectDaysBack('2026-02-15', null, 5);
    // Sun (own day) -> skip Sat -> Fri, Thu, Wed, Tue
    expect(days).toEqual([
      '2026-02-15', // Sunday (own day)
      '2026-02-13', // Friday
      '2026-02-12', // Thursday
      '2026-02-11', // Wednesday
      '2026-02-10', // Tuesday
    ]);
  });

  // Test 8: Saturday commit
  it('Saturday commit: own day included, continues to Fri', () => {
    // Saturday 2026-02-14
    const days = collectDaysBack('2026-02-14', null, 5);
    // Sat (own day) -> Fri, Thu, Wed, Tue
    expect(days).toEqual([
      '2026-02-14', // Saturday (own day)
      '2026-02-13', // Friday
      '2026-02-12', // Thursday
      '2026-02-11', // Wednesday
      '2026-02-10', // Tuesday
    ]);
  });

  // Test 9: Weekday commit with weekend in spread range
  it('skips weekends going back from weekday', () => {
    // Monday 2026-02-16, no boundary
    const days = collectDaysBack('2026-02-16', null, 5);
    // Mon -> skip Sun, skip Sat -> Fri, Thu, Wed, Tue
    expect(days).toEqual([
      '2026-02-16', // Monday
      '2026-02-13', // Friday
      '2026-02-12', // Thursday
      '2026-02-11', // Wednesday
      '2026-02-10', // Tuesday
    ]);
  });

  // Test 14: Boundary == entryDate (same day shared)
  it('boundary == entryDate: own day still included', () => {
    const days = collectDaysBack('2026-02-16', '2026-02-16', 5);
    // Own day is always included (isFirst=true bypass)
    expect(days).toEqual(['2026-02-16']);
  });
});

describe('distributeEvenly', () => {
  // Test 15: Rounding: 10h / 3 days
  it('penny-spread remainder: 10h / 3 -> [3.34, 3.33, 3.33]', () => {
    const { allocations, overflow } = distributeEvenly(new Decimal(10), 3);
    expect(allocations.map(a => a.toNumber())).toEqual([3.34, 3.33, 3.33]);
    expect(overflow.toNumber()).toBe(0);
  });

  // Test 18: Penny-spread: 24.99h / 5 -> no false overflow
  it('24.99h / 5: [5.00, 5.00, 5.00, 5.00, 4.99], no overflow', () => {
    const { allocations, overflow } = distributeEvenly(new Decimal('24.99'), 5);
    expect(allocations.map(a => a.toNumber())).toEqual([5.00, 5.00, 5.00, 5.00, 4.99]);
    expect(overflow.toNumber()).toBe(0);
  });

  // Test 19a: Real overflow: 25.04h / 5
  it('25.04h / 5: overflow = 0.04', () => {
    const { allocations, overflow } = distributeEvenly(new Decimal('25.04'), 5);
    // base=5.00, remainder=4 cents -> [5.01, 5.01, 5.01, 5.01, 5.00] -> clamp -> overflow=0.04
    expect(allocations.map(a => a.toNumber())).toEqual([5.00, 5.00, 5.00, 5.00, 5.00]);
    expect(overflow.toNumber()).toBe(0.04);
  });
});

describe('distributeProRata', () => {
  // Test 16: Pro-rata attribution
  it('distributes proportionally with SHA sort and remainder absorption', () => {
    const shares = [
      { sha: 'bbb', effort: new Decimal(4) },
      { sha: 'aaa', effort: new Decimal(3) },
    ];
    const result = distributeProRata(new Decimal(5), shares);
    // Sorted: aaa(3), bbb(4). Total effort=7
    // aaa: floor(5 * 3/7, 2) = floor(2.142857, 2) = 2.14
    // bbb: 5 - 2.14 = 2.86
    expect(result).toEqual([
      { sha: 'aaa', hours: expect.any(Decimal) },
      { sha: 'bbb', hours: expect.any(Decimal) },
    ]);
    expect(result[0].hours.toNumber()).toBe(2.14);
    expect(result[1].hours.toNumber()).toBe(2.86);
    // Sum invariant
    expect(result[0].hours.plus(result[1].hours).toNumber()).toBe(5);
  });

  // Test 20: Pro-rata commit order — same result regardless of input order
  it('deterministic regardless of input order', () => {
    const shares1 = [
      { sha: 'ccc', effort: new Decimal(5) },
      { sha: 'aaa', effort: new Decimal(3) },
      { sha: 'bbb', effort: new Decimal(2) },
    ];
    const shares2 = [
      { sha: 'aaa', effort: new Decimal(3) },
      { sha: 'bbb', effort: new Decimal(2) },
      { sha: 'ccc', effort: new Decimal(5) },
    ];
    const r1 = distributeProRata(new Decimal(10), shares1);
    const r2 = distributeProRata(new Decimal(10), shares2);
    expect(r1.map(r => ({ sha: r.sha, hours: r.hours.toNumber() }))).toEqual(
      r2.map(r => ({ sha: r.sha, hours: r.hours.toNumber() })),
    );
  });
});

describe('spreadEffort', () => {
  // Test 1: Single commit fits in 1 day
  it('single commit <=5h fits in 1 day', () => {
    const commits = [mkCommit('abc123', '2026-02-16', 4)]; // Monday
    const result = spreadEffort(commits);
    expect(result.dayMap.size).toBe(1);
    expect(result.dayMap.get('2026-02-16')).toBe(4);
    expect(result.totalOverhead).toBe(0);
    expect(result.dailyEffortRows.length).toBe(1);
    expect(result.dailyEffortRows[0].effortHours).toBe(4);
    expect(result.dailyEffortRows[0].sourceCommitHash).toBe('abc123');
  });

  // Test 2: Single commit spreads across 2-3 days
  it('single commit 8h spreads across 2 days', () => {
    const commits = [mkCommit('abc123', '2026-02-16', 8)]; // Monday
    const result = spreadEffort(commits);
    // n = ceil(8/5) = 2, perDay = 4h
    expect(result.dayMap.size).toBe(2);
    expect(result.dayMap.get('2026-02-16')).toBe(4);
    expect(result.dayMap.get('2026-02-13')).toBe(4); // Friday (skip weekend)
    expect(result.totalOverhead).toBe(0);
  });

  // Test 3: Giant commit > 25h
  it('giant commit 30h creates overhead', () => {
    const commits = [mkCommit('abc123', '2026-02-20', 30)]; // Friday
    const result = spreadEffort(commits);
    // 5 days * 5h = 25h max, overhead = 5h
    expect(result.dayMap.size).toBe(5);
    for (const [, hours] of result.dayMap) {
      expect(hours).toBe(5);
    }
    expect(result.totalOverhead).toBe(5);
  });

  // Test 4: Two commits same day (aggregated)
  it('same-day commits aggregated and attributed pro-rata', () => {
    // Thursday 2026-02-19
    const commits = [
      mkCommit('aaa111', '2026-02-19', 8),
      mkCommit('bbb222', '2026-02-19', 12),
    ];
    const result = spreadEffort(commits);
    // Aggregated: 20h
    // n = ceil(20/5) = 4, spread across 4 days
    expect(result.dayMap.size).toBe(4);
    for (const [, hours] of result.dayMap) {
      expect(hours).toBe(5);
    }
    expect(result.totalOverhead).toBe(0);

    // Pro-rata: aaa=40%, bbb=60%
    // Each day = 5h -> aaa=2.00, bbb=3.00
    const aaaRows = result.dailyEffortRows.filter(r => r.sourceCommitHash === 'aaa111');
    const bbbRows = result.dailyEffortRows.filter(r => r.sourceCommitHash === 'bbb222');
    expect(aaaRows.length).toBe(4);
    expect(bbbRows.length).toBe(4);

    const aaaTotal = sumRows(aaaRows);
    const bbbTotal = sumRows(bbbRows);
    expect(aaaTotal).toBe(8);
    expect(bbbTotal).toBe(12);
  });

  // Test 10: Effort = 0
  it('effort=0 produces no days and no overhead', () => {
    const commits = [mkCommit('abc123', '2026-02-16', 0)];
    const result = spreadEffort(commits);
    expect(result.dayMap.size).toBe(0);
    expect(result.totalOverhead).toBe(0);
    expect(result.dailyEffortRows.length).toBe(0);
  });

  // Test 11: Large burst — 5 commits in 2 days
  it('large burst: 5 commits in 2 days with aggregation + overflow', () => {
    const commits = [
      mkCommit('a1', '2026-02-18', 5),  // Wednesday
      mkCommit('a2', '2026-02-18', 5),  // Wednesday
      mkCommit('a3', '2026-02-18', 3),  // Wednesday
      mkCommit('b1', '2026-02-19', 10), // Thursday
      mkCommit('b2', '2026-02-19', 6),  // Thursday
    ];
    const result = spreadEffort(commits);
    const totalInput = sumInputEffort(commits);
    expect(totalInput).toBe(29);

    // Entry A (Wed): 13h, no boundary
    //   n = ceil(13/5) = 3, spread across 3 days: Wed, Tue, Mon
    //   distributeEvenly(13, 3): base=4.33, remainder=1 cent -> [4.34, 4.33, 4.33]
    // Entry B (Thu): 16h, boundary=Wed
    //   priority=[Thu], fill to 5h, remaining=11h
    //   spillover=[Wed, Tue, Mon, Fri]: greedy-fill tops up existing days + uses Fri
    //   overhead = 29 - 25 = 4h (total capacity 5 days * 5h = 25h)

    const sumPlaced = sumDayMap(result.dayMap);
    expect(sumPlaced + result.totalOverhead).toBeCloseTo(totalInput, 2);
  });

  // Test 12: Sum invariant across all tests
  it('sum invariant: sum(dayMap) + overhead == totalEffort (complex case)', () => {
    const commits = [
      mkCommit('a1', '2026-02-16', 7),   // Monday
      mkCommit('b1', '2026-02-17', 3),   // Tuesday
      mkCommit('c1', '2026-02-18', 12),  // Wednesday
      mkCommit('d1', '2026-02-19', 4.5), // Thursday
    ];
    const result = spreadEffort(commits);
    const totalInput = sumInputEffort(commits); // 26.5
    const sumPlaced = sumDayMap(result.dayMap);
    expect(sumPlaced + result.totalOverhead).toBeCloseTo(totalInput, 2);
  });

  // Test 13: Order invariant — shuffled input same result
  it('order invariant: shuffled input produces same result', () => {
    const commits1 = [
      mkCommit('aaa', '2026-02-16', 5),
      mkCommit('bbb', '2026-02-18', 8),
      mkCommit('ccc', '2026-02-17', 3),
    ];
    const commits2 = [
      mkCommit('ccc', '2026-02-17', 3),
      mkCommit('aaa', '2026-02-16', 5),
      mkCommit('bbb', '2026-02-18', 8),
    ];
    const r1 = spreadEffort(commits1);
    const r2 = spreadEffort(commits2);

    // dayMaps should be identical
    expect([...r1.dayMap].sort()).toEqual([...r2.dayMap].sort());
    expect(r1.totalOverhead).toBe(r2.totalOverhead);

    // DailyEffort rows should match (sorted by date+hash)
    const sortRows = (rows: typeof r1.dailyEffortRows) =>
      [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.sourceCommitHash.localeCompare(b.sourceCommitHash));
    expect(sortRows(r1.dailyEffortRows)).toEqual(sortRows(r2.dailyEffortRows));
  });

  // Test 5 (spreadEffort level): soft boundary — priority days first, no spillover needed
  it('soft boundary: second entry fits in priority days, no spillover', () => {
    const commits = [
      mkCommit('a1', '2026-02-16', 8),  // Monday
      mkCommit('b1', '2026-02-18', 6),  // Wednesday
    ];
    const result = spreadEffort(commits);
    // Entry A (Mon): 8h, spread Mon + Fri (prev week) -> 4h each
    // Entry B (Wed): 6h, priority=[Wed, Tue], fits in 2 days -> 3h each
    expect(result.dayMap.has('2026-02-18')).toBe(true); // Wed
    expect(result.dayMap.has('2026-02-17')).toBe(true); // Tue
    // Mon has 4h from entry A only (no spillover needed)
    expect(result.dayMap.get('2026-02-16')).toBe(4);
    expect(result.totalOverhead).toBe(0);
  });

  // Test 6 (spreadEffort level): Boundary Sat, next commit Mon — spillover fills remaining
  it('soft boundary: Saturday + Monday commit, spillover absorbs overflow', () => {
    const commits = [
      mkCommit('a1', '2026-02-14', 4),  // Saturday
      mkCommit('b1', '2026-02-16', 10), // Monday
    ];
    const result = spreadEffort(commits);
    // Entry A: Sat=4h (own day)
    // Entry B: priority=[Mon], Mon fills to 5h, remaining=5h
    //   spillover=[Fri 02-13, Thu 02-12, Wed 02-11, Tue 02-10]
    //   greedy-fill: Fri=5h, remaining=0
    expect(result.dayMap.get('2026-02-14')).toBe(4);
    expect(result.dayMap.get('2026-02-16')).toBe(5);
    expect(result.dayMap.get('2026-02-13')).toBe(5); // spillover to Friday
    expect(result.totalOverhead).toBe(0);
  });

  // Test 7 (spreadEffort level): Sunday commit
  it('Sunday commit spreads to Sun, Fri, Thu', () => {
    const commits = [mkCommit('abc', '2026-02-15', 12)]; // Sunday
    const result = spreadEffort(commits);
    // n = ceil(12/5) = 3
    // Days: Sun, Fri, Thu (skip Sat)
    expect(result.dayMap.size).toBe(3);
    expect(result.dayMap.has('2026-02-15')).toBe(true); // Sun
    expect(result.dayMap.has('2026-02-13')).toBe(true); // Fri
    expect(result.dayMap.has('2026-02-12')).toBe(true); // Thu
    expect(result.totalOverhead).toBe(0);
    expect(sumDayMap(result.dayMap)).toBe(12);
  });

  // Test A+: Soft boundary spillover — consecutive-day commits use full 5-day window
  it('soft boundary spillover: large entry on consecutive day fills backward', () => {
    const commits = [
      mkCommit('a1', '2026-02-17', 2),   // Tuesday
      mkCommit('b1', '2026-02-18', 22),  // Wednesday (3 commits would aggregate same)
      mkCommit('c1', '2026-02-19', 1),   // Thursday
    ];
    const result = spreadEffort(commits);
    const totalInput = sumInputEffort(commits); // 25h
    const sumPlaced = sumDayMap(result.dayMap);

    // With hard boundary: only 8h placed, 17h overhead
    // With A+ soft boundary: 22h entry on Wed spills past Tue boundary
    //   priority=[Wed]=5h, spillover=[Tue,Mon,Fri,Thu] greedy-fills remaining 17h
    //   Tue already has 2h from entry A -> fill to 5h (+3h), then Mon=5h, Fri=5h, Thu=4h
    expect(sumPlaced + result.totalOverhead).toBeCloseTo(totalInput, 2);
    expect(result.totalOverhead).toBe(0); // all 25h placed (5 days * 5h capacity)
    expect(sumPlaced).toBe(25);

    // Verify Tue got topped up (entry A's 2h + entry B's spillover)
    expect(result.dayMap.get('2026-02-17')).toBe(5);
    // Wed and Thu have their entries
    expect(result.dayMap.get('2026-02-18')).toBe(5);
    expect(result.dayMap.get('2026-02-19')).toBe(1);
  });

  // Test 17: Pro-rata rounding: 7h split 3:4 across 2 days
  it('pro-rata rounding: no precision drift', () => {
    // 2 commits same day: 3h + 4h = 7h total
    // n = ceil(7/5) = 2, spread across 2 days: 3.5h + 3.5h
    const commits = [
      mkCommit('aaa', '2026-02-16', 3),  // Monday
      mkCommit('bbb', '2026-02-16', 4),  // Monday
    ];
    const result = spreadEffort(commits);
    expect(result.dayMap.size).toBe(2);
    expect(result.totalOverhead).toBe(0);

    // Pro-rata: aaa=3/7, bbb=4/7 of each day's 3.50h
    // Day 1: aaa = floor(3.50*3/7, 2) = floor(1.50, 2) = 1.50; bbb = 3.50-1.50 = 2.00
    // Day 2: aaa = floor(3.50*3/7, 2) = 1.50; bbb = 2.00
    const aaaRows = result.dailyEffortRows.filter(r => r.sourceCommitHash === 'aaa');
    const bbbRows = result.dailyEffortRows.filter(r => r.sourceCommitHash === 'bbb');
    expect(aaaRows.length).toBe(2);
    expect(bbbRows.length).toBe(2);

    // Sum must match input exactly
    expect(sumRows(aaaRows) + sumRows(bbbRows)).toBeCloseTo(7, 2);
  });

  // Test 19b: Overhead = totalEffort - sum(DailyEffort)
  it('overhead computed correctly as totalEffort - sum(placed)', () => {
    const commits = [mkCommit('abc', '2026-02-20', 28)]; // Friday, 28h
    const result = spreadEffort(commits);
    // 5 days * 5h = 25h placed, overhead = 3h
    const totalInput = 28;
    const sumPlaced = sumRows(result.dailyEffortRows);
    expect(result.totalOverhead).toBe(totalInput - sumPlaced);
    expect(result.totalOverhead).toBe(3);
  });

  // Additional edge case: empty input
  it('empty input returns empty result', () => {
    const result = spreadEffort([]);
    expect(result.dayMap.size).toBe(0);
    expect(result.totalOverhead).toBe(0);
    expect(result.dailyEffortRows.length).toBe(0);
  });

  // Test 16 (spreadEffort level): Pro-rata attribution across 3 spread days
  it('pro-rata attribution: 2 commits, 3 spread days, hash preserved', () => {
    // 2 commits on Friday: 6h + 9h = 15h
    // n = ceil(15/5) = 3 days
    const commits = [
      mkCommit('sha_aaa', '2026-02-20', 6),  // Friday
      mkCommit('sha_bbb', '2026-02-20', 9),  // Friday
    ];
    const result = spreadEffort(commits);
    expect(result.dayMap.size).toBe(3);
    expect(result.totalOverhead).toBe(0);

    // All rows should have real commit hashes
    for (const row of result.dailyEffortRows) {
      expect(['sha_aaa', 'sha_bbb']).toContain(row.sourceCommitHash);
    }

    // Each spread day should have 2 rows (one per commit)
    const byDate = new Map<string, typeof result.dailyEffortRows>();
    for (const row of result.dailyEffortRows) {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date)!.push(row);
    }
    expect(byDate.size).toBe(3);
    for (const [, rows] of byDate) {
      expect(rows.length).toBe(2);
    }

    // Sum per commit matches input
    const aaaTotal = sumRows(result.dailyEffortRows.filter(r => r.sourceCommitHash === 'sha_aaa'));
    const bbbTotal = sumRows(result.dailyEffortRows.filter(r => r.sourceCommitHash === 'sha_bbb'));
    expect(aaaTotal).toBe(6);
    expect(bbbTotal).toBe(9);
  });
});
