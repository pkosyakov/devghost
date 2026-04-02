// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDripFeed } from '../use-drip-feed';
import type { ClientEvent } from '@/lib/services/client-event-mapper';
import type { LeaderboardData } from '@/lib/services/client-event-mapper';

function makeClientEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
  return {
    id: `ce-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    tier: 'major',
    category: 'commit',
    text: 'clientProgress.commitAnalyzed',
    params: { subject: 'test commit' },
    ...overrides,
  };
}

const emptyLeaderboard: LeaderboardData = {
  developers: [],
  ghost: { totalHours: 0 },
  scopeWorkDays: 0,
};

describe('useDripFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty visible events', () => {
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: [],
        rawLeaderboard: emptyLeaderboard,
        jobStatus: 'RUNNING',
      }),
    );
    expect(result.current.visibleEvents).toEqual([]);
    expect(result.current.isDraining).toBe(false);
    expect(result.current.isDrained).toBe(false);
  });

  it('drips events one by one over time', () => {
    const events = [
      makeClientEvent({ tier: 'major' }),
      makeClientEvent({ tier: 'micro' }),
      makeClientEvent({ tier: 'micro' }),
    ];
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: events,
        rawLeaderboard: emptyLeaderboard,
        jobStatus: 'RUNNING',
      }),
    );

    // Initially no events visible
    expect(result.current.visibleEvents).toHaveLength(0);

    // Advance time — events should appear one by one
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.visibleEvents.length).toBeGreaterThan(0);
    expect(result.current.visibleEvents.length).toBeLessThanOrEqual(events.length);
  });

  it('sets isDraining when jobStatus becomes a terminal state', () => {
    const events = [
      makeClientEvent(),
      makeClientEvent(),
      makeClientEvent(),
      makeClientEvent(),
      makeClientEvent(),
    ];
    const { result, rerender } = renderHook(
      ({ status }) =>
        useDripFeed({
          rawEvents: events,
          rawLeaderboard: emptyLeaderboard,
            jobStatus: status,
        }),
      { initialProps: { status: 'RUNNING' } },
    );

    // Switch to LLM_COMPLETE (terminal job status)
    rerender({ status: 'LLM_COMPLETE' });
    expect(result.current.isDraining).toBe(true);

    // Advance time to drain
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.isDrained).toBe(true);
  });

  it('updates counters from micro events', () => {
    const events = [
      makeClientEvent({
        tier: 'major', text: 'clientProgress.commitAnalyzed',
        developerId: 'h1', effortHours: 2.0,
      }),
      makeClientEvent({
        tier: 'micro', text: 'clientProgress.filesChanged',
        params: { fileCount: 5 },
      }),
      makeClientEvent({
        tier: 'micro', text: 'clientProgress.linesChanged',
        params: { lineCount: 120 },
      }),
    ];
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: events,
        rawLeaderboard: emptyLeaderboard,
        jobStatus: 'RUNNING',
      }),
    );

    // Drain all events
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.counters.commits).toBe(1);
    expect(result.current.counters.files).toBe(5);
    expect(result.current.counters.lines).toBe(120);
  });
});
