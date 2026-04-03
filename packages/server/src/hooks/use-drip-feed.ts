'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ClientEvent, LeaderboardData } from '@/lib/services/client-event-mapper';

// ── Types ─────────────────────────────────────────────────────────

type QueueItem = {
  event: ClientEvent;
  delayMs: number;     // pre-computed at enqueue, frozen
};

// ── Constants ─────────────────────────────────────────────────────

const TIER_WEIGHT: Record<string, number> = {
  milestone: 4,
  major: 2,
  micro: 0.5,
};

const DELAY_CLAMP: Record<string, [number, number]> = {
  milestone: [100, 800],
  major: [40, 400],
  micro: [15, 80],
};

const BUDGET_PADDING = 1.2;
const DRAIN_SPEEDUP = 5;
const HARD_FLOOR = 10;
const CATCH_UP_THRESHOLD = 3;

// ── Terminal job statuses that trigger draining ─────────────────────

const DRAIN_STATUSES = new Set([
  'COMPLETED', 'LLM_COMPLETE', 'FAILED', 'FAILED_FATAL', 'FAILED_RETRYABLE', 'CANCELLED',
]);

// ── Interface ─────────────────────────────────────────────────────

interface UseDripFeedOpts {
  rawEvents: ClientEvent[];
  rawLeaderboard: LeaderboardData;
  jobStatus: string;
  isPaused?: boolean;
  defaultIntervalMs?: number;  // initial budget hint (livePollMs from caller)
}

interface UseDripFeedResult {
  visibleEvents: ClientEvent[];
  counters: { commits: number; files: number; lines: number };
  leaderboard: LeaderboardData;
  isDraining: boolean;
  isDrained: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────

export function useDripFeed(opts: UseDripFeedOpts): UseDripFeedResult {
  const {
    rawEvents,
    rawLeaderboard,
    jobStatus,
    isPaused = false,
    defaultIntervalMs = 1000,
  } = opts;

  const [visibleEvents, setVisibleEvents] = useState<ClientEvent[]>([]);
  const [counters, setCounters] = useState({ commits: 0, files: 0, lines: 0 });
  const [isDraining, setIsDraining] = useState(false);
  const [isDrained, setIsDrained] = useState(false);

  // Per-event leaderboard accumulation
  const dripDevMapRef = useRef(
    new Map<string, { name: string; totalHours: number; commitCount: number }>(),
  );
  const [dripLeaderboard, setDripLeaderboard] = useState<LeaderboardData>({
    developers: [],
    ghost: { totalHours: 0 },
    scopeWorkDays: 0,
  });

  const rawLeaderboardRef = useRef(rawLeaderboard);
  useEffect(() => {
    rawLeaderboardRef.current = rawLeaderboard;
  }, [rawLeaderboard]);

  // ── Budget-based refs ──
  const queueRef = useRef<QueueItem[]>([]);
  const seenIdsRef = useRef(new Set<string>());
  const lastBatchAtRef = useRef(0);
  const measuredIntervalRef = useRef(defaultIntervalMs);
  const batchSizeEmaRef = useRef(10);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Enqueue with budget-stamped delays ──
  useEffect(() => {
    const newEvents: ClientEvent[] = [];
    for (const event of rawEvents) {
      if (!seenIdsRef.current.has(event.id)) {
        seenIdsRef.current.add(event.id);
        newEvents.push(event);
      }
    }
    if (newEvents.length === 0) return;

    // Measure interval between batch arrivals
    const now = performance.now();
    if (lastBatchAtRef.current > 0) {
      measuredIntervalRef.current = now - lastBatchAtRef.current;
    }
    lastBatchAtRef.current = now;

    const budget = measuredIntervalRef.current * BUDGET_PADDING;

    // Weighted delay distribution
    const totalWeight = newEvents.reduce(
      (s, e) => s + (TIER_WEIGHT[e.tier] ?? TIER_WEIGHT.major),
      0,
    );
    const msPerWeight =
      totalWeight > 0 ? budget / totalWeight : budget / newEvents.length;

    // Clamp per tier
    const items: QueueItem[] = newEvents.map((event) => {
      const weight = TIER_WEIGHT[event.tier] ?? TIER_WEIGHT.major;
      const raw = msPerWeight * weight;
      const [minD, maxD] = DELAY_CLAMP[event.tier] ?? DELAY_CLAMP.major;
      return { event, delayMs: Math.max(minD, Math.min(maxD, raw)) };
    });

    // Overload: scale down if clamped sum exceeds budget
    const clampedSum = items.reduce((s, it) => s + it.delayMs, 0);
    if (clampedSum > budget) {
      const scale = budget / clampedSum;
      for (const item of items) {
        item.delayMs = Math.max(HARD_FLOOR, item.delayMs * scale);
      }
    }

    // Update EMA for catch-up threshold
    batchSizeEmaRef.current =
      batchSizeEmaRef.current * 0.7 + newEvents.length * 0.3;

    queueRef.current.push(...items);
  }, [rawEvents]);

  // ── Drain detection ──
  useEffect(() => {
    if (
      DRAIN_STATUSES.has(jobStatus) &&
      !isPaused &&
      !isDraining &&
      !isDrained
    ) {
      setIsDraining(true);
    }
  }, [jobStatus, isPaused, isDraining, isDrained]);

  // ── Resume reset (timing refs only) ──
  const prevJobStatusRef = useRef(jobStatus);
  useEffect(() => {
    const prev = prevJobStatusRef.current;
    prevJobStatusRef.current = jobStatus;
    if (
      jobStatus === 'RUNNING' &&
      (prev === 'FAILED_RETRYABLE' || prev === 'PENDING')
    ) {
      // Reset drain state if it was active
      if (isDraining || isDrained) {
        setIsDraining(false);
        setIsDrained(false);
      }
      // Reset timing refs only — queue and seenIds are preserved
      lastBatchAtRef.current = 0;
      measuredIntervalRef.current = defaultIntervalMs;
      batchSizeEmaRef.current = 10;
    }
  }, [jobStatus, isDraining, isDrained, defaultIntervalMs]);

  // ── Leaderboard emit ──
  const emitLeaderboardUpdate = useCallback(() => {
    const raw = rawLeaderboardRef.current;
    const devMap = dripDevMapRef.current;
    const developers = Array.from(devMap.entries()).map(([id, d]) => ({
      id,
      name: d.name,
      totalHours: Math.round(d.totalHours * 100) / 100,
      commitCount: d.commitCount,
    }));

    const rawDevTotal = raw.developers.reduce((s, d) => s + d.totalHours, 0);
    const dripDevTotal = developers.reduce((s, d) => s + d.totalHours, 0);
    const fraction =
      rawDevTotal > 0 ? Math.min(1, dripDevTotal / rawDevTotal) : 0;
    const ghostHours =
      Math.round(raw.ghost.totalHours * fraction * 100) / 100;

    setDripLeaderboard({
      developers,
      ghost: { totalHours: ghostHours },
      scopeWorkDays: raw.scopeWorkDays,
    });
  }, []);

  // Snap to raw leaderboard on drain complete
  useEffect(() => {
    if (isDrained) {
      setDripLeaderboard(rawLeaderboardRef.current);
    }
  }, [isDrained]);

  // ── Main tick loop ──
  useEffect(() => {
    function processSingleEvent(event: ClientEvent) {
      if (event.text === 'clientProgress.commitAnalyzed') {
        setCounters((prev) => ({ ...prev, commits: prev.commits + 1 }));
      }
      if (event.text === 'clientProgress.filesChanged') {
        const fc =
          typeof event.params.fileCount === 'number'
            ? event.params.fileCount
            : 0;
        setCounters((prev) => ({ ...prev, files: prev.files + fc }));
      }
      if (event.text === 'clientProgress.linesChanged') {
        const lc =
          typeof event.params.lineCount === 'number'
            ? event.params.lineCount
            : 0;
        setCounters((prev) => ({ ...prev, lines: prev.lines + lc }));
      }

      if (event.developerId && event.effortHours != null) {
        const devMap = dripDevMapRef.current;
        const existing = devMap.get(event.developerId);
        if (existing) {
          existing.totalHours += event.effortHours;
          existing.commitCount += 1;
        } else {
          devMap.set(event.developerId, {
            name: (event.params.developerName as string) ?? 'Developer',
            totalHours: event.effortHours,
            commitCount: 1,
          });
        }
      }
    }

    function tick() {
      const queue = queueRef.current;

      // Quota pause: freeze visible state
      if (isPaused) {
        timerRef.current = setTimeout(tick, 250);
        return;
      }

      if (queue.length === 0) {
        if (isDraining) {
          setIsDrained(true);
          return;
        }
        timerRef.current = setTimeout(tick, 50);
        return;
      }

      // ── Catch-up mode: batch emit when queue is deep ──
      const avgBatch = batchSizeEmaRef.current;
      const inCatchUp = queue.length > avgBatch * CATCH_UP_THRESHOLD;

      if (inCatchUp) {
        const budget = measuredIntervalRef.current * BUDGET_PADDING;
        const batchSize = Math.min(
          queue.length,
          Math.max(1, Math.floor(budget / HARD_FLOOR)),
        );
        const batch = queue.splice(0, batchSize);
        const batchEvents = batch.map((it) => it.event);

        // Single state update for visible events
        setVisibleEvents((prev) => [...prev, ...batchEvents]);

        // Accumulate counter deltas across the batch
        let dCommits = 0,
          dFiles = 0,
          dLines = 0;
        for (const { event } of batch) {
          if (event.text === 'clientProgress.commitAnalyzed') dCommits++;
          if (event.text === 'clientProgress.filesChanged') {
            dFiles +=
              typeof event.params.fileCount === 'number'
                ? event.params.fileCount
                : 0;
          }
          if (event.text === 'clientProgress.linesChanged') {
            dLines +=
              typeof event.params.lineCount === 'number'
                ? event.params.lineCount
                : 0;
          }
          // Leaderboard: mutate dripDevMapRef in-place
          if (event.developerId && event.effortHours != null) {
            const existing = dripDevMapRef.current.get(event.developerId);
            if (existing) {
              existing.totalHours += event.effortHours;
              existing.commitCount += 1;
            } else {
              dripDevMapRef.current.set(event.developerId, {
                name:
                  (event.params.developerName as string) ?? 'Developer',
                totalHours: event.effortHours,
                commitCount: 1,
              });
            }
          }
        }
        if (dCommits || dFiles || dLines) {
          setCounters((prev) => ({
            commits: prev.commits + dCommits,
            files: prev.files + dFiles,
            lines: prev.lines + dLines,
          }));
        }
        // One leaderboard emit for the whole batch
        if (
          batch.some(
            ({ event }) => event.developerId && event.effortHours != null,
          )
        ) {
          emitLeaderboardUpdate();
        }

        timerRef.current = setTimeout(tick, HARD_FLOOR);
        return;
      }

      // ── Normal mode: single event with pre-stamped delay ──
      const { event, delayMs } = queue.shift()!;
      setVisibleEvents((prev) => [...prev, event]);

      processSingleEvent(event);

      if (event.developerId && event.effortHours != null) {
        emitLeaderboardUpdate();
      }

      const adjustedDelay = isDraining
        ? Math.max(HARD_FLOOR, delayMs / DRAIN_SPEEDUP)
        : delayMs;
      timerRef.current = setTimeout(tick, adjustedDelay);
    }

    timerRef.current = setTimeout(tick, 50);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPaused, isDraining, emitLeaderboardUpdate]);

  return {
    visibleEvents,
    counters,
    leaderboard: dripLeaderboard,
    isDraining,
    isDrained,
  };
}
