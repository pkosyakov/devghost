'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ClientEvent, LeaderboardData } from '@/lib/services/client-event-mapper';

// ── Base delays per tier (ms) ──────────────────────────────────────
const BASE_DELAY: Record<string, [number, number]> = {
  milestone: [400, 600],
  major: [150, 300],
  micro: [30, 60],
};

function baseDelayFor(tier: string): number {
  const [min, max] = BASE_DELAY[tier] ?? BASE_DELAY.major;
  return min + Math.random() * (max - min);
}

// ── Terminal job statuses that trigger draining ─────────────────────
// FAILED_RETRYABLE only drains when the run is NOT quota-paused.
const DRAIN_STATUSES = new Set([
  'COMPLETED', 'LLM_COMPLETE', 'FAILED', 'FAILED_FATAL', 'FAILED_RETRYABLE', 'CANCELLED',
]);

interface UseDripFeedOpts {
  rawEvents: ClientEvent[];
  rawLeaderboard: LeaderboardData;
  pollIntervalMs: number;
  jobStatus: string;  // job-level status (RUNNING, COMPLETED, FAILED_FATAL, etc.)
  isPaused?: boolean; // EXTERNAL_QUOTA pause freezes feed/leaderboard in place
}

interface UseDripFeedResult {
  visibleEvents: ClientEvent[];
  counters: { commits: number; files: number; lines: number };
  leaderboard: LeaderboardData;
  isDraining: boolean;
  isDrained: boolean;
}

export function useDripFeed(opts: UseDripFeedOpts): UseDripFeedResult {
  const { rawEvents, rawLeaderboard, pollIntervalMs, jobStatus, isPaused = false } = opts;

  const [visibleEvents, setVisibleEvents] = useState<ClientEvent[]>([]);
  const [counters, setCounters] = useState({ commits: 0, files: 0, lines: 0 });
  const [isDraining, setIsDraining] = useState(false);
  const [isDrained, setIsDrained] = useState(false);

  // Per-event leaderboard accumulation (not snapshot replacement)
  const dripDevMapRef = useRef(new Map<string, { name: string; totalHours: number; commitCount: number }>());
  const drippedCommitsRef = useRef(0);
  const [dripLeaderboard, setDripLeaderboard] = useState<LeaderboardData>({
    developers: [], ghost: { totalHours: 0 }, scopeWorkDays: 0,
  });

  // Keep latest raw leaderboard for ghost proportional calculation and final snap
  const rawLeaderboardRef = useRef(rawLeaderboard);
  useEffect(() => {
    rawLeaderboardRef.current = rawLeaderboard;
  }, [rawLeaderboard]);

  const queueRef = useRef<ClientEvent[]>([]);
  const seenIdsRef = useRef(new Set<string>());
  const speedRef = useRef(1.0);
  const targetSpeedRef = useRef(1.0);
  const batchSizesRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enqueue new events from rawEvents, deduplicating by id
  useEffect(() => {
    let newCount = 0;
    for (const event of rawEvents) {
      if (!seenIdsRef.current.has(event.id)) {
        seenIdsRef.current.add(event.id);
        queueRef.current.push(event);
        newCount++;
      }
    }
    if (newCount > 0) {
      const sizes = batchSizesRef.current;
      sizes.push(newCount);
      if (sizes.length > 5) sizes.shift();
    }
  }, [rawEvents]);

  // Detect drain trigger (uses job status, NOT order status)
  // Quota-paused runs must NOT drain — feed and leaderboard freeze in place.
  useEffect(() => {
    if (DRAIN_STATUSES.has(jobStatus) && !isPaused && !isDraining && !isDrained) {
      setIsDraining(true);
      targetSpeedRef.current = 5.0; // fast-forward
    }
  }, [jobStatus, isPaused, isDraining, isDrained]);

  // Reset drain state when job resumes (watchdog retry or manual resume)
  // FAILED_RETRYABLE → RUNNING, or PAUSED → RUNNING
  const prevJobStatusRef = useRef(jobStatus);
  useEffect(() => {
    const prev = prevJobStatusRef.current;
    prevJobStatusRef.current = jobStatus;
    if (
      jobStatus === 'RUNNING' &&
      (prev === 'FAILED_RETRYABLE' || prev === 'PENDING') &&
      (isDraining || isDrained)
    ) {
      setIsDraining(false);
      setIsDrained(false);
      targetSpeedRef.current = 1.0;
      speedRef.current = 1.0;
    }
  }, [jobStatus, isDraining, isDrained]);

  // Compute adaptive pressure
  const getExpectedBatchSize = useCallback(() => {
    const sizes = batchSizesRef.current;
    if (sizes.length === 0) return 10;
    return sizes.reduce((a, b) => a + b, 0) / sizes.length;
  }, []);

  // Recompute dripLeaderboard from internal dev map + proportional ghost
  const emitLeaderboardUpdate = useCallback(() => {
    const raw = rawLeaderboardRef.current;
    const devMap = dripDevMapRef.current;
    const developers = Array.from(devMap.entries()).map(([id, d]) => ({
      id,
      name: d.name,
      totalHours: Math.round(d.totalHours * 100) / 100,
      commitCount: d.commitCount,
    }));

    // Ghost proportional to drip progress: fraction of dripped dev hours vs raw total
    const rawDevTotal = raw.developers.reduce((s, d) => s + d.totalHours, 0);
    const dripDevTotal = developers.reduce((s, d) => s + d.totalHours, 0);
    const fraction = rawDevTotal > 0 ? Math.min(1, dripDevTotal / rawDevTotal) : 0;
    const ghostHours = Math.round(raw.ghost.totalHours * fraction * 100) / 100;

    setDripLeaderboard({
      developers,
      ghost: { totalHours: ghostHours },
      scopeWorkDays: raw.scopeWorkDays,
    });
  }, []);

  // On drain complete, snap to raw leaderboard to close rounding gaps
  useEffect(() => {
    if (isDrained) {
      setDripLeaderboard(rawLeaderboardRef.current);
    }
  }, [isDrained]);

  // Main drip loop
  useEffect(() => {
    function tick() {
      const queue = queueRef.current;

      // Quota pause: freeze visible state exactly where it is. Do not dequeue,
      // do not fast-forward, just wait for resume or a fresh rerun.
      if (isPaused) {
        timerRef.current = setTimeout(tick, 250);
        return;
      }

      if (queue.length === 0) {
        if (isDraining) {
          setIsDrained(true);
          return;
        }
        // Schedule next check
        timerRef.current = setTimeout(tick, 50);
        return;
      }

      // Adaptive pressure
      const expected = getExpectedBatchSize();
      const pressure = queue.length / expected;
      if (pressure < 0.5) {
        targetSpeedRef.current = isDraining ? 5.0 : 0.75;
      } else if (pressure <= 1.5) {
        targetSpeedRef.current = isDraining ? 5.0 : 1.0;
      } else if (pressure <= 3.0) {
        targetSpeedRef.current = isDraining ? 5.0 : Math.min(2.0, 1.0 + (pressure - 1.5));
      } else {
        targetSpeedRef.current = isDraining ? 5.0 : 3.0;
      }

      // Lerp speed
      speedRef.current += (targetSpeedRef.current - speedRef.current) * 0.1;

      // Emit next event
      const event = queue.shift()!;
      setVisibleEvents(prev => [...prev, event]);

      // Update counters
      if (event.text === 'clientProgress.commitAnalyzed') {
        setCounters(prev => ({ ...prev, commits: prev.commits + 1 }));
      }
      if (event.text === 'clientProgress.filesChanged') {
        const fc = typeof event.params.fileCount === 'number' ? event.params.fileCount : 0;
        setCounters(prev => ({ ...prev, files: prev.files + fc }));
      }
      if (event.text === 'clientProgress.linesChanged') {
        const lc = typeof event.params.lineCount === 'number' ? event.params.lineCount : 0;
        setCounters(prev => ({ ...prev, lines: prev.lines + lc }));
      }

      // Per-event leaderboard accumulation (not snapshot replacement)
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
        drippedCommitsRef.current += 1;
        emitLeaderboardUpdate();
      }

      // Schedule next tick with adaptive delay
      const baseDelay = baseDelayFor(event.tier);
      const adjustedDelay = Math.max(15, baseDelay / speedRef.current);
      timerRef.current = setTimeout(tick, adjustedDelay);
    }

    timerRef.current = setTimeout(tick, 50);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPaused, isDraining, getExpectedBatchSize, emitLeaderboardUpdate]);

  // Suppress unused warning for pollIntervalMs (kept for API compatibility)
  void pollIntervalMs;

  return { visibleEvents, counters, leaderboard: dripLeaderboard, isDraining, isDrained };
}
