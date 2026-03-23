'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';

export interface PipelineLogEntry {
  ts: number;
  sha: string;
  status: 'ok' | 'error' | 'skip';
  hours?: number;
  method?: string;
  type?: string;
  durationMs?: number;
  error?: string;
  repo?: string;
}

export function PipelineLog({ entries }: { entries: PipelineLogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries.length]);

  const { okCount, errCount, skipCount } = useMemo(() => ({
    okCount: entries.filter(e => e.status === 'ok').length,
    errCount: entries.filter(e => e.status === 'error').length,
    skipCount: entries.filter(e => e.status === 'skip').length,
  }), [entries]);

  const copyLog = useCallback(() => {
    const text = entries.map(e => {
      const time = new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false });
      const icon = e.status === 'ok' ? '+' : e.status === 'error' ? 'X' : '-';
      const hours = e.hours != null ? `${e.hours.toFixed(1)}h` : '';
      const dur = e.durationMs ? `(${(e.durationMs / 1000).toFixed(1)}s)` : '';
      const detail = e.error || e.type || '';
      return `${time} ${icon} ${e.sha} ${hours.padStart(6)} ${(e.method ?? '').padEnd(20)} ${detail} ${dur}`;
    }).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [entries]);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-1">
        <span className="font-mono">Pipeline Log</span>
        {okCount > 0 && <span className="text-green-600">{okCount} ok</span>}
        {errCount > 0 && <span className="text-red-500">{errCount} err</span>}
        {skipCount > 0 && <span className="text-gray-400">{skipCount} skip</span>}
        <button
          onClick={copyLog}
          className="ml-auto text-gray-400 hover:text-gray-200 transition-colors"
          title="Copy log to clipboard"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div
        ref={containerRef}
        className="bg-gray-950 text-gray-300 rounded-md p-3 font-mono text-xs leading-5 max-h-64 overflow-y-auto"
      >
        {entries.map((entry, idx) => (
          <div key={`${idx}-${entry.ts}-${entry.sha}`} className="flex gap-2">
            <span className="text-gray-500 w-16 shrink-0">
              {new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
            <span className={
              entry.status === 'ok' ? 'text-green-400' :
              entry.status === 'error' ? 'text-red-400' :
              'text-gray-500'
            }>
              {entry.status === 'ok' ? '\u2713' : entry.status === 'error' ? '\u2717' : '\u2014'}
            </span>
            <span className="text-blue-300 w-16 shrink-0">{entry.sha}</span>
            <span className="text-gray-400 w-16 shrink-0 text-right">
              {entry.hours != null ? `${entry.hours.toFixed(1)}h` : ''}
            </span>
            <span className="text-yellow-300/70 w-36 shrink-0 truncate">{entry.method ?? ''}</span>
            <span className="truncate">
              {entry.error ? (
                <span className="text-red-400/80">{entry.error}</span>
              ) : (
                <span className="text-gray-500">{entry.type ?? ''}</span>
              )}
              {entry.durationMs ? (
                <span className="text-gray-600"> ({(entry.durationMs / 1000).toFixed(1)}s)</span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
