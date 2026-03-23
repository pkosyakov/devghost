import { describe, it, expect } from 'vitest';
import { preFilterCandidates, getActivityLevel } from '@/lib/explore-utils';

function makeRepo(mentionable: number, recentCommits: number | null) {
  return {
    mentionableUsers: { totalCount: mentionable },
    defaultBranchRef: recentCommits !== null
      ? { target: { history: { totalCount: recentCommits } } }
      : null,
  };
}

describe('preFilterCandidates', () => {
  // Default filters: minContributors=2, maxContributors=15, minActivityScore=5
  const defaults = { min: 2, max: 15, activity: 5 };
  // mentionableMin = max(1, 2-1) = 1
  // mentionableMax = 15 * 3 = 45
  // minRecentCommits = floor(5 * 13 * 0.5) = 32

  it('passes repo with mentionable in range and enough commits', () => {
    const repos = [makeRepo(10, 50)];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(1);
  });

  it('rejects repo with 0 mentionableUsers (single-dev project proxy)', () => {
    const repos = [makeRepo(0, 100)];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('rejects repo with too many mentionableUsers (>max*3)', () => {
    const repos = [makeRepo(46, 100)]; // 46 > 15*3=45
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('passes repo at boundary of mentionableMax', () => {
    const repos = [makeRepo(45, 100)]; // 45 == 15*3
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(1);
  });

  it('rejects repo with too few recent commits', () => {
    const repos = [makeRepo(10, 31)]; // 31 < 32
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('passes repo at boundary of minRecentCommits', () => {
    const repos = [makeRepo(10, 32)]; // 32 == floor(5*13*0.5)
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(1);
  });

  it('rejects empty repo (no defaultBranchRef)', () => {
    const repos = [makeRepo(10, null)];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('filters mixed set correctly', () => {
    const repos = [
      makeRepo(10, 50),  // pass
      makeRepo(0, 100),  // fail: mentionable=0
      makeRepo(10, 5),   // fail: low commits
      makeRepo(100, 50), // fail: mentionable too high
      makeRepo(5, 40),   // pass
    ];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(2);
  });

  it('uses lower activity threshold for minActivityScore=1', () => {
    // minRecentCommits = floor(1 * 13 * 0.5) = 6
    const repos = [makeRepo(5, 6)];
    const result = preFilterCandidates(repos, 2, 15, 1);
    expect(result).toHaveLength(1);
  });
});

describe('getActivityLevel', () => {
  it('returns high for score >= 10', () => {
    expect(getActivityLevel(10)).toBe('high');
    expect(getActivityLevel(25)).toBe('high');
  });

  it('returns medium for 3 <= score < 10', () => {
    expect(getActivityLevel(3)).toBe('medium');
    expect(getActivityLevel(9.9)).toBe('medium');
  });

  it('returns low for score < 3', () => {
    expect(getActivityLevel(0)).toBe('low');
    expect(getActivityLevel(2.9)).toBe('low');
  });
});
