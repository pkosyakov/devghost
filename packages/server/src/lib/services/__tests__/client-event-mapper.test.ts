import { describe, it, expect } from 'vitest';
import {
  mapToClientEvents,
  buildLeaderboard,
  type ClientEvent,
  type LeaderboardData,
} from '../client-event-mapper';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    createdAt: new Date('2026-04-02T10:00:00Z'),
    level: 'info',
    phase: 'llm',
    code: 'LLM_COMMIT_RESULT',
    message: 'Commit analysis result available',
    repo: 'owner/repo',
    sha: 'abc123',
    payload: {
      method: 'llm',
      estimatedHours: 2.5,
      subject: 'fix: login validation',
      category: 'bugfix',
      authorEmail: 'dev@example.com',
      authorName: 'Alice Dev',
      filesCount: 7,
      additions: 120,
      deletions: 30,
    },
    ...overrides,
  };
}

describe('mapToClientEvents', () => {
  it('expands LLM_COMMIT_RESULT into major + micro events', () => {
    const events = mapToClientEvents([makeEvent()]);
    expect(events.length).toBeGreaterThanOrEqual(3);

    const major = events.find(e => e.tier === 'major');
    expect(major).toBeDefined();
    expect(major!.text).toBe('clientProgress.commitAnalyzed');
    expect(major!.params.subject).toBe('fix: login validation');
    expect(major!.developerId).toBeDefined();
    expect(major!.effortHours).toBe(2.5);

    const filesMicro = events.find(
      e => e.tier === 'micro' && e.text === 'clientProgress.filesChanged',
    );
    expect(filesMicro).toBeDefined();
    expect(filesMicro!.params.fileCount).toBe(7);

    const linesMicro = events.find(
      e => e.tier === 'micro' && e.text === 'clientProgress.linesChanged',
    );
    expect(linesMicro).toBeDefined();
    expect(linesMicro!.params.lineCount).toBe(150);
  });

  it('maps REPO_CLONE_START to milestone', () => {
    const events = mapToClientEvents([
      makeEvent({
        code: 'REPO_CLONE_START',
        payload: {},
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe('milestone');
    expect(events[0].text).toBe('clientProgress.repoConnecting');
    expect(events[0].params.repo).toBe('owner/repo');
  });

  it('maps REPO_PROCESS_DONE to milestone with totalHours', () => {
    const events = mapToClientEvents([
      makeEvent({
        code: 'REPO_PROCESS_DONE',
        payload: { totalAnalyzed: 42, totalHours: 85.5 },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe('milestone');
    expect(events[0].text).toBe('clientProgress.repoCompleted');
    expect(events[0].params.commitCount).toBe(42);
    expect(events[0].params.totalHours).toBe(85.5);
  });

  it('filters out internal event codes', () => {
    const events = mapToClientEvents([
      makeEvent({ code: 'HEARTBEAT_TOUCH_FAILED', payload: {} }),
      makeEvent({ code: 'WORKER_ACQUIRED', payload: {} }),
      makeEvent({ code: 'TRIGGER_CLAIM_CLEARED', payload: {} }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('never includes sha in output', () => {
    const events = mapToClientEvents([makeEvent()]);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain('abc123');
    }
  });

  it('developerId is a stable hash, not raw email', () => {
    const events = mapToClientEvents([makeEvent()]);
    const withDev = events.filter(e => e.developerId);
    expect(withDev.length).toBeGreaterThan(0);
    for (const e of withDev) {
      expect(e.developerId).not.toBe('dev@example.com');
      expect(e.developerId).not.toContain('@');
    }
  });
});

describe('buildLeaderboard', () => {
  it('accumulates hours per developer', () => {
    const events: ClientEvent[] = [
      {
        id: '1', ts: 1000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'a' },
        developerId: 'hash-alice', effortHours: 2.0,
      },
      {
        id: '2', ts: 2000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'b' },
        developerId: 'hash-alice', effortHours: 1.5,
      },
      {
        id: '3', ts: 3000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'c' },
        developerId: 'hash-bob', effortHours: 3.0,
      },
    ];
    const devNames = new Map([['hash-alice', 'Alice'], ['hash-bob', 'Bob']]);
    const lb = buildLeaderboard(events, devNames, 22, 50);

    expect(lb.developers).toHaveLength(2);
    const alice = lb.developers.find(d => d.id === 'hash-alice')!;
    expect(alice.totalHours).toBe(3.5);
    expect(alice.commitCount).toBe(2);
    expect(alice.name).toBe('Alice');

    const bob = lb.developers.find(d => d.id === 'hash-bob')!;
    expect(bob.totalHours).toBe(3.0);
    expect(bob.commitCount).toBe(1);
  });

  it('computes ghost hours proportional to progress', () => {
    const lb = buildLeaderboard([], new Map(), 20, 45);
    // GHOST_NORM (3.0) * 20 workDays * 45% progress / 100 = 27.0
    expect(lb.ghost.totalHours).toBe(27);
    expect(lb.scopeWorkDays).toBe(20);
  });
});
