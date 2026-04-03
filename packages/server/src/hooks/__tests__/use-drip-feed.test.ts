// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDripFeed } from '../use-drip-feed';
import type { ClientEvent, LeaderboardData } from '@/lib/services/client-event-mapper';

// ── Helpers ───────────────────────────────────────────────────────

let mockNow: number;

function makeEvent(
  overrides: Partial<ClientEvent> & { id: string },
): ClientEvent {
  return {
    ts: Date.now(),
    tier: 'major',
    category: 'commit',
    text: 'clientProgress.commitAnalyzed',
    params: { subject: 'test' },
    ...overrides,
  };
}

function makeBatch(
  count: number,
  prefix: string,
  tier: ClientEvent['tier'] = 'micro',
): ClientEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({ id: `${prefix}-${i}`, tier }),
  );
}

const emptyLB: LeaderboardData = {
  developers: [],
  ghost: { totalHours: 0 },
  scopeWorkDays: 0,
};

const defaultOpts = {
  rawLeaderboard: emptyLB,
  jobStatus: 'RUNNING' as string,
  defaultIntervalMs: 1000,
};

// ── Tests ─────────────────────────────────────────────────────────

describe('useDripFeed (budget-based)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Baseline ──

  it('starts with empty visible events', () => {
    const { result } = renderHook(() =>
      useDripFeed({ rawEvents: [], ...defaultOpts }),
    );
    expect(result.current.visibleEvents).toEqual([]);
    expect(result.current.counters).toEqual({ commits: 0, files: 0, lines: 0 });
    expect(result.current.isDraining).toBe(false);
    expect(result.current.isDrained).toBe(false);
  });

  // ── Test 7: First batch fallback ──

  it('uses defaultIntervalMs for first batch budget', () => {
    // defaultIntervalMs=300 → budget=360ms
    // 2 major: totalWeight=4, msPerWeight=90, delay=clamp(180,40,400)=180ms
    const events = [
      makeEvent({ id: 'a1', tier: 'major' }),
      makeEvent({ id: 'a2', tier: 'major' }),
    ];
    mockNow = 1000;
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: events,
        ...defaultOpts,
        defaultIntervalMs: 300,
      }),
    );

    act(() => { vi.advanceTimersByTime(50); }); // initial tick → a1
    expect(result.current.visibleEvents).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(100); }); // 100 < 180, no a2
    expect(result.current.visibleEvents).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(80); }); // total 180 → a2
    expect(result.current.visibleEvents).toHaveLength(2);
  });

  // ── Test 2: Budget from measured interval ──

  it('uses measured interval between batches for budget', () => {
    const batch1 = [makeEvent({ id: 'b1', tier: 'major' })];
    mockNow = 1000;
    const { result, rerender } = renderHook(
      ({ events }) =>
        useDripFeed({ rawEvents: events, ...defaultOpts }),
      { initialProps: { events: batch1 } },
    );
    // batch1: budget=1200, 1 major: delay=clamp(1200/2*2,40,400)=400ms

    // Drain batch1
    act(() => { vi.advanceTimersByTime(50 + 400 + 50); });
    expect(result.current.visibleEvents).toHaveLength(1);

    // Batch2 at t+500ms: measuredInterval=500, budget=600
    // 2 major: totalWeight=4, msPerWeight=150, delay=clamp(300,40,400)=300ms
    mockNow = 1500;
    rerender({
      events: [
        ...batch1,
        makeEvent({ id: 'b2-1', tier: 'major' }),
        makeEvent({ id: 'b2-2', tier: 'major' }),
      ],
    });

    // Tick was idling at 50ms — next idle fires, picks up b2-1
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current.visibleEvents).toHaveLength(2);

    act(() => { vi.advanceTimersByTime(300); }); // b2-2
    expect(result.current.visibleEvents).toHaveLength(3);
  });

  // ── Test 3: Weighted distribution ──

  it('assigns delays proportional to tier weights', () => {
    // budget=1200ms (default 1000*1.2)
    // 1 milestone(4) + 2 major(2) + 4 micro(0.5) → totalWeight=10
    // msPerWeight=120
    // milestone: clamp(480, 100, 800) = 480ms
    // major: clamp(240, 40, 400) = 240ms
    // micro: clamp(60, 15, 80) = 60ms
    // sum: 480 + 240*2 + 60*4 = 1200ms ✓
    const events = [
      makeEvent({ id: 'ms', tier: 'milestone' }),
      makeEvent({ id: 'mj1', tier: 'major' }),
      makeEvent({ id: 'mj2', tier: 'major' }),
      makeEvent({ id: 'mi1', tier: 'micro', text: 'clientProgress.filesChanged', params: { fileCount: 3 } }),
      makeEvent({ id: 'mi2', tier: 'micro', text: 'clientProgress.filesChanged', params: { fileCount: 5 } }),
      makeEvent({ id: 'mi3', tier: 'micro', text: 'clientProgress.filesChanged', params: { fileCount: 2 } }),
      makeEvent({ id: 'mi4', tier: 'micro', text: 'clientProgress.filesChanged', params: { fileCount: 1 } }),
    ];
    mockNow = 1000;
    const { result } = renderHook(() =>
      useDripFeed({ rawEvents: events, ...defaultOpts }),
    );

    act(() => { vi.advanceTimersByTime(50); }); // → milestone
    expect(result.current.visibleEvents[0].tier).toBe('milestone');

    // milestone delay=480ms → next event (major)
    act(() => { vi.advanceTimersByTime(480); });
    expect(result.current.visibleEvents).toHaveLength(2);
    expect(result.current.visibleEvents[1].tier).toBe('major');

    // major delay=240ms → next major
    act(() => { vi.advanceTimersByTime(240); });
    expect(result.current.visibleEvents).toHaveLength(3);

    // major delay=240ms → first micro
    act(() => { vi.advanceTimersByTime(240); });
    expect(result.current.visibleEvents).toHaveLength(4);
    expect(result.current.visibleEvents[3].tier).toBe('micro');

    // micro delay=60ms each → drain remaining 3 micros
    act(() => { vi.advanceTimersByTime(60 * 3); });
    expect(result.current.visibleEvents).toHaveLength(7);
  });

  // ── Test 1: Per-event stamp isolation ──

  it('preserves pre-stamped delays when a new batch arrives mid-drain', () => {
    // Batch A (3 major): budget=1200, delay=clamp(1200/6*2,40,400)=400ms
    const batchA = [
      makeEvent({ id: 'a1', tier: 'major' }),
      makeEvent({ id: 'a2', tier: 'major' }),
      makeEvent({ id: 'a3', tier: 'major' }),
    ];
    mockNow = 1000;
    const { result, rerender } = renderHook(
      ({ events }) =>
        useDripFeed({ rawEvents: events, ...defaultOpts }),
      { initialProps: { events: batchA } },
    );

    act(() => { vi.advanceTimersByTime(50); }); // → a1
    expect(result.current.visibleEvents).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(400); }); // → a2
    expect(result.current.visibleEvents).toHaveLength(2);

    // Batch B arrives mid-drain (a3 still in queue)
    // measuredInterval = 1500-1000 = 500ms, budget = 600ms
    // 2 micro: totalWeight=1, msPerWeight=600, delay=clamp(300,15,80)=80ms
    mockNow = 1500;
    rerender({
      events: [
        ...batchA,
        makeEvent({ id: 'b1', tier: 'micro' }),
        makeEvent({ id: 'b2', tier: 'micro' }),
      ],
    });
    // Queue: [a3(400ms), b1(80ms), b2(80ms)]

    // a3 still uses its 400ms delay from batch A
    // (delay from the previously-emitted event a2 is the wait before a3)
    act(() => { vi.advanceTimersByTime(200); }); // 200 < 400
    expect(result.current.visibleEvents).toHaveLength(2); // still 2

    act(() => { vi.advanceTimersByTime(200); }); // total 400 → a3
    expect(result.current.visibleEvents).toHaveLength(3);

    // a3's delay (400ms) is the wait before b1 appears
    act(() => { vi.advanceTimersByTime(200); }); // 200 < 400
    expect(result.current.visibleEvents).toHaveLength(3); // still 3

    act(() => { vi.advanceTimersByTime(200); }); // total 400 → b1
    expect(result.current.visibleEvents).toHaveLength(4);

    act(() => { vi.advanceTimersByTime(80); }); // b1's delay=80ms → b2
    expect(result.current.visibleEvents).toHaveLength(5);
  });

  // ── Test 4: Overload scale-down ──

  it('scales down delays when clamped sum exceeds budget', () => {
    // 10 major + 50 micro, defaultIntervalMs=300 (admin demo)
    // budget=360ms, totalWeight=10*2+50*0.5=45, msPerWeight=8
    // major: clamp(16, 40, 400)=40. micro: clamp(4, 15, 80)=15
    // clampedSum=400+750=1150 > 360 → scale=360/1150≈0.313
    // scaled major: max(10, 40*0.313)=12.5ms. scaled micro: max(10, 15*0.313)=10ms
    // sum after scale: 10*12.5+50*10=625ms
    const events: ClientEvent[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeEvent({ id: `mj-${i}`, tier: 'major' }),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        makeEvent({ id: `mi-${i}`, tier: 'micro' }),
      ),
    ];
    mockNow = 1000;
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: events,
        ...defaultOpts,
        defaultIntervalMs: 300,
      }),
    );

    // All 60 events should drain within ~700ms (50 initial + 625 delays)
    act(() => { vi.advanceTimersByTime(700); });
    expect(result.current.visibleEvents).toHaveLength(60);

    // Verify none were lost and they arrived faster than unscaled (1200ms)
    // — this test confirms the overload scale-down path doesn't drop events
  });

  // ── Test 5: Catch-up batch emit ──
  //
  // Verifies: (a) batchSize capped at floor(budget/HARD_FLOOR) per tick
  //   (first tick emits 12, not all 24 — proves the cap),
  // (b) counters reflect aggregated deltas at each step,
  // (c) leaderboard state correct after full catch-up (single-emit-per-tick
  //     is an implementation optimization verified through code review),
  // (d) after catch-up drains, subsequent events use normal single-event mode.

  it('caps catch-up batch at floor(budget/HARD_FLOOR) per tick', () => {
    // Use defaultIntervalMs=100 → budget=120, catchUpBatchSize=floor(120/10)=12
    // With 24 queued events, the first tick emits exactly 12 (not all 24),
    // proving the batchSize cap. A "flush whole queue" bug would emit 24.
    const { result, rerender } = renderHook(
      ({ events }) =>
        useDripFeed({ rawEvents: events, ...defaultOpts, defaultIntervalMs: 100 }),
      { initialProps: { events: [] as ClientEvent[] } },
    );

    let allEvents: ClientEvent[] = [];
    for (let i = 0; i < 8; i++) {
      mockNow = 1000 + i * 100; // 100ms apart → measuredInterval=100
      allEvents = [
        ...allEvents,
        makeEvent({
          id: `b${i}-commit`,
          tier: 'major',
          text: 'clientProgress.commitAnalyzed',
          developerId: `dev-${i}`,
          effortHours: 1.5,
          params: { subject: `commit ${i}`, developerName: `Dev ${i}` },
        }),
        makeEvent({
          id: `b${i}-files`,
          tier: 'micro',
          text: 'clientProgress.filesChanged',
          params: { fileCount: 3 },
        }),
        makeEvent({
          id: `b${i}-lines`,
          tier: 'micro',
          text: 'clientProgress.linesChanged',
          params: { lineCount: 50 },
        }),
      ];
      rerender({ events: [...allEvents] });
    }
    // Queue=24, EMA≈3.4, threshold≈10.2, catchUpBatchSize=floor(120/10)=12

    // (a) First catch-up tick: exactly 12 events (batchSize cap), not 24
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current.visibleEvents).toHaveLength(12);

    // (b) Partial counters: first 12 = 4 complete batches (commit+files+lines)
    expect(result.current.counters.commits).toBe(4);
    expect(result.current.counters.files).toBe(4 * 3);   // 12
    expect(result.current.counters.lines).toBe(4 * 50);  // 200

    // Second catch-up tick at HARD_FLOOR (10ms): remaining 12
    // Queue was 12, still > threshold 10.2 → catch-up continues
    act(() => { vi.advanceTimersByTime(10); });
    expect(result.current.visibleEvents).toHaveLength(24);
    expect(result.current.counters.commits).toBe(8);
    expect(result.current.counters.files).toBe(24);
    expect(result.current.counters.lines).toBe(400);

    // (c) Leaderboard updated: 8 unique developers
    expect(result.current.leaderboard.developers).toHaveLength(8);

    // (d) After catch-up, add 2 events → normal single-event mode
    mockNow = 5000;
    rerender({
      events: [
        ...allEvents,
        makeEvent({ id: 'post1', tier: 'major' }),
        makeEvent({ id: 'post2', tier: 'major' }),
      ],
    });

    // Post-catchup: HARD_FLOOR tick → empty → idle 50ms → pick up post1
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.visibleEvents).toHaveLength(25); // one, not both

    // post2 arrives after its pre-stamped delay
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.visibleEvents).toHaveLength(26);
    expect(result.current.counters.commits).toBe(10);
  });

  // ── Test 6: Drain speedup ──

  it('applies DRAIN_SPEEDUP divisor to pre-stamped delays', () => {
    // 2 major events, budget=1200, delay=400ms each
    // Drain: adjustedDelay = max(10, 400/5) = 80ms
    const events = [
      makeEvent({ id: 'd1', tier: 'major' }),
      makeEvent({ id: 'd2', tier: 'major' }),
    ];
    mockNow = 1000;
    const { result, rerender } = renderHook(
      ({ status }) =>
        useDripFeed({ rawEvents: events, ...defaultOpts, jobStatus: status }),
      { initialProps: { status: 'RUNNING' } },
    );

    rerender({ status: 'COMPLETED' });
    expect(result.current.isDraining).toBe(true);

    // Tick loop restarts (isDraining dep changed) → new 50ms initial tick
    act(() => { vi.advanceTimersByTime(50); }); // → d1
    expect(result.current.visibleEvents).toHaveLength(1);

    // Drained delay: max(10, 400/5) = 80ms
    act(() => { vi.advanceTimersByTime(80); }); // → d2
    expect(result.current.visibleEvents).toHaveLength(2);

    // Queue empty, next tick at 80ms → isDrained
    act(() => { vi.advanceTimersByTime(80); });
    expect(result.current.isDrained).toBe(true);
  });

  // ── Test 8: Resume reset (timing only) ──
  //
  // Three invariants from the spec:
  // (a) Timing refs (lastBatchAt, measuredInterval, batchSizeEma) reset to defaults
  // (b) queueRef preserved — already-queued events survive resume
  // (c) Pre-stamped delays preserved — queued events keep their original delayMs
  //
  // Strategy: leave events IN the queue at pause time (don't drain them),
  // resume, then verify they drip at their original delays. Then send new
  // events near the stale lastBatchAt to verify timing reset.

  it('resets timing refs on resume, preserves queue and seenIds', () => {
    // defaultIntervalMs=1000
    const batch1 = [
      makeEvent({ id: 'r1', tier: 'major' }),
      makeEvent({ id: 'r2', tier: 'major' }),
    ];
    mockNow = 1000;
    const { result, rerender } = renderHook(
      ({ events: evts, status }) =>
        useDripFeed({ rawEvents: evts, ...defaultOpts, jobStatus: status }),
      { initialProps: { events: batch1, status: 'RUNNING' } },
    );
    // batch1: budget=1200, delays: r1=400ms, r2=400ms. lastBatchAt=1000.

    // Rapid batch2 at t=1100 → lastBatchAt=1100, measuredInterval=100
    // r3: budget=120, 1 major: delay=clamp(120,40,400)=120ms
    mockNow = 1100;
    const batch2 = [
      ...batch1,
      makeEvent({ id: 'r3', tier: 'major' }),
    ];
    rerender({ events: batch2, status: 'RUNNING' });

    // Drain ONLY r1 — leave r2 and r3 in queue
    act(() => { vi.advanceTimersByTime(50); }); // initial tick → r1
    expect(result.current.visibleEvents).toHaveLength(1);
    expect(result.current.visibleEvents[0].id).toBe('r1');
    // Queue: [r2(400ms), r3(120ms)]

    // FAILED_RETRYABLE → drain activates (but don't advance timers)
    rerender({ events: batch2, status: 'FAILED_RETRYABLE' });
    expect(result.current.isDraining).toBe(true);

    // Resume immediately: FAILED_RETRYABLE → RUNNING
    rerender({ events: batch2, status: 'RUNNING' });
    expect(result.current.isDraining).toBe(false);

    // (b) Queue preserved: r2 and r3 still there
    // Tick loop restarted → 50ms initial tick → emit r2
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current.visibleEvents).toHaveLength(2);
    expect(result.current.visibleEvents[1].id).toBe('r2');

    // (c) r2's ORIGINAL 400ms delay preserved → r3 NOT yet at +200ms
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current.visibleEvents).toHaveLength(2); // still just r2

    // r3 appears at r2's full 400ms delay
    act(() => { vi.advanceTimersByTime(200); }); // total 400ms after r2
    expect(result.current.visibleEvents).toHaveLength(3);
    expect(result.current.visibleEvents[2].id).toBe('r3');

    // (a) Timing reset: send 2 new events CLOSE to stale lastBatchAt (1100).
    // If reset: lastBatchAt=0 → guard false → measuredInterval=1000 (default)
    //   → budget=1200, 2 major: delay=clamp(600,40,400)=400ms
    // If broken: lastBatchAt=1100 (stale) → interval=1200-1100=100
    //   → budget=120, delay=clamp(60,40,400)=60ms
    mockNow = 1200;
    rerender({
      events: [
        ...batch2,
        makeEvent({ id: 'r4', tier: 'major' }),
        makeEvent({ id: 'r5', tier: 'major' }),
      ],
      status: 'RUNNING',
    });

    // r3's 120ms scheduled tick picks up r4
    act(() => { vi.advanceTimersByTime(120); });
    expect(result.current.visibleEvents).toHaveLength(4);

    // If reset: r4's delay=400ms → r5 won't appear at +100ms
    // If broken: delay=60ms → r5 already visible → assertion fails
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.visibleEvents).toHaveLength(4); // still just r4

    // r5 appears at 400ms after r4
    act(() => { vi.advanceTimersByTime(300); }); // total 400ms
    expect(result.current.visibleEvents).toHaveLength(5);

    // seenIds preserved: no duplicates, correct order
    expect(result.current.visibleEvents.map(e => e.id))
      .toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  // ── Test 9: Resume from quota pause (no drain state) ──
  //
  // Same invariant as #8 but harder: isPaused=true blocks drain detection,
  // so isDraining=false, isDrained=false at resume time. The resume guard
  // must fire regardless.

  it('resets timing refs on resume even when drain was never active', () => {
    // defaultIntervalMs=300 (admin demo poll)
    const batch1 = [makeEvent({ id: 'q1', tier: 'major' })];
    mockNow = 1000;
    const { result, rerender } = renderHook(
      ({ events: evts, status, paused }) =>
        useDripFeed({
          rawEvents: evts,
          ...defaultOpts,
          jobStatus: status,
          isPaused: paused,
          defaultIntervalMs: 300,
        }),
      { initialProps: { events: batch1, status: 'RUNNING', paused: false } },
    );
    // batch1: budget=360, 1 major: delay=360ms

    // Rapid batch2 at t=1050 → measuredInterval becomes 50ms (stale)
    mockNow = 1050;
    const batch2 = [...batch1, makeEvent({ id: 'q1b', tier: 'major' })];
    rerender({ events: batch2, status: 'RUNNING', paused: false });

    // Drain events
    act(() => { vi.advanceTimersByTime(50 + 400 + 400); });
    const drainedCount = result.current.visibleEvents.length;

    // Quota pause: isPaused=true blocks drain detection
    rerender({ events: batch2, status: 'FAILED_RETRYABLE', paused: true });
    expect(result.current.isDraining).toBe(false); // isPaused prevented drain

    // Resume: FAILED_RETRYABLE → RUNNING (drain was never set)
    // isPaused changes false→true→false, triggering tick loop restart.
    // Resume effect resets timing refs (lastBatchAt=0, measuredInterval=300).
    //
    // First, resume WITHOUT new events to let reset take effect.
    rerender({
      events: batch2,
      status: 'RUNNING',
      paused: false,
    });

    // Now send new events in a separate rerender. With reset applied:
    // lastBatchAt=0 → guard false → measuredInterval=300 (default)
    // → budget=360, 2 major: msPerWeight=90, delay=clamp(180,40,400)=180ms
    //
    // Without reset (stale lastBatchAt=1050): interval=5000-1050=3950
    // → budget=4740, delay=clamp(2370,40,400)=400ms (too long)
    mockNow = 5000;
    rerender({
      events: [
        ...batch2,
        makeEvent({ id: 'q2', tier: 'major' }),
        makeEvent({ id: 'q3', tier: 'major' }),
      ],
      status: 'RUNNING',
      paused: false,
    });

    // Tick picks up q2 (tick loop was restarted by isPaused change → 50ms initial)
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.visibleEvents).toHaveLength(drainedCount + 1);

    // q2's delay=180ms → q3 won't appear at +50ms
    // If broken (400ms): still waiting → OK here. If broken (40ms): q3 already visible → fails.
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current.visibleEvents).toHaveLength(drainedCount + 1); // still just q2

    // q3 at 180ms — broken 400ms path not yet arrived → assertion fails
    act(() => { vi.advanceTimersByTime(130); }); // total 180ms after q2
    expect(result.current.visibleEvents).toHaveLength(drainedCount + 2);
  });

  // ── Test 11: Empty poll ──

  it('does not recalculate budget on empty poll (all seen)', () => {
    const events = [
      makeEvent({ id: 'e1', tier: 'major' }),
      makeEvent({ id: 'e2', tier: 'major' }),
    ];
    mockNow = 1000;
    const { result, rerender } = renderHook(
      ({ events: evts }) =>
        useDripFeed({ rawEvents: evts, ...defaultOpts }),
      { initialProps: { events } },
    );

    // Drain all
    act(() => { vi.advanceTimersByTime(50 + 400 + 400 + 50); });
    expect(result.current.visibleEvents).toHaveLength(2);

    // Rerender with same events (all already seen)
    mockNow = 5000;
    rerender({ events: [...events] }); // new reference, same IDs

    // No new events enqueued, no budget change
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.visibleEvents).toHaveLength(2); // unchanged
  });

  // ── Test 10: Fresh rerun remount ──

  it('resets all state on remount (simulating key prop change)', () => {
    const events = [
      makeEvent({ id: 'f1', tier: 'major' }),
      makeEvent({
        id: 'f2',
        tier: 'micro',
        text: 'clientProgress.filesChanged',
        params: { fileCount: 5 },
      }),
    ];
    mockNow = 1000;
    const { result, unmount } = renderHook(() =>
      useDripFeed({ rawEvents: events, ...defaultOpts }),
    );

    // Drain events
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.visibleEvents.length).toBeGreaterThan(0);
    expect(result.current.counters.commits).toBe(1);
    expect(result.current.counters.files).toBe(5);

    // Unmount (what React key change does) and remount fresh
    unmount();

    const newEvents = [makeEvent({ id: 'g1', tier: 'major' })];
    mockNow = 10000;
    const { result: result2 } = renderHook(() =>
      useDripFeed({ rawEvents: newEvents, ...defaultOpts }),
    );

    // Fresh state — old counters/events gone
    expect(result2.current.visibleEvents).toEqual([]);
    expect(result2.current.counters).toEqual({ commits: 0, files: 0, lines: 0 });
    expect(result2.current.isDraining).toBe(false);

    // New events drain normally
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result2.current.visibleEvents).toHaveLength(1);
    expect(result2.current.counters.commits).toBe(1);
  });

  // ── Counter updates ──

  it('updates counters from commit, file, and line events', () => {
    const events = [
      makeEvent({
        id: 'c1',
        tier: 'major',
        text: 'clientProgress.commitAnalyzed',
        developerId: 'dev1',
        effortHours: 2.0,
        params: { subject: 'feat', developerName: 'Alice' },
      }),
      makeEvent({
        id: 'c2',
        tier: 'micro',
        text: 'clientProgress.filesChanged',
        params: { fileCount: 5 },
      }),
      makeEvent({
        id: 'c3',
        tier: 'micro',
        text: 'clientProgress.linesChanged',
        params: { lineCount: 120 },
      }),
    ];
    mockNow = 1000;
    const { result } = renderHook(() =>
      useDripFeed({ rawEvents: events, ...defaultOpts }),
    );

    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.counters.commits).toBe(1);
    expect(result.current.counters.files).toBe(5);
    expect(result.current.counters.lines).toBe(120);
  });
});
