'use client';

import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';

export interface AnalysisEventEntry {
  id: string;
  createdAt: string;
  level: string;
  phase: string | null;
  code: string | null;
  message: string;
  repo: string | null;
  sha: string | null;
  payload: unknown;
}

interface AnalysisEventLogProps {
  entries: AnalysisEventEntry[];
  title: string;
  copyLabel: string;
  copiedLabel: string;
}

function levelClass(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === 'error') return 'border-red-300 bg-red-50 text-red-700';
  if (normalized === 'warn') return 'border-amber-300 bg-amber-50 text-amber-700';
  return 'border-blue-300 bg-blue-50 text-blue-700';
}

function compactPayload(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload.length > 400 ? `${payload.slice(0, 400)}...` : payload;
  try {
    const encoded = JSON.stringify(payload);
    if (!encoded) return null;
    return encoded.length > 400 ? `${encoded.slice(0, 400)}...` : encoded;
  } catch {
    return null;
  }
}

export function AnalysisEventLog({
  entries,
  title,
  copyLabel,
  copiedLabel,
}: AnalysisEventLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries.length]);

  const { infoCount, warnCount, errorCount } = useMemo(() => {
    let info = 0;
    let warn = 0;
    let error = 0;
    for (const entry of entries) {
      const level = entry.level.toLowerCase();
      if (level === 'error') error += 1;
      else if (level === 'warn') warn += 1;
      else info += 1;
    }
    return { infoCount: info, warnCount: warn, errorCount: error };
  }, [entries]);

  const copyLog = useCallback(() => {
    const text = entries.map((entry) => {
      const time = new Date(entry.createdAt).toLocaleTimeString('en-GB', { hour12: false });
      const meta = [entry.phase, entry.code, entry.repo, entry.sha].filter(Boolean).join(' ');
      const payload = compactPayload(entry.payload);
      return `[${time}] ${entry.level.toUpperCase()} ${meta} :: ${entry.message}${payload ? ` | ${payload}` : ''}`;
    }).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [entries]);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-1">
        <span className="font-mono">{title}</span>
        <span className="text-blue-600">{infoCount} info</span>
        {warnCount > 0 && <span className="text-amber-600">{warnCount} warn</span>}
        {errorCount > 0 && <span className="text-red-600">{errorCount} err</span>}
        <button
          onClick={copyLog}
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          title={copyLabel}
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <div
        ref={containerRef}
        className="rounded-md border bg-background p-2 font-mono text-xs leading-5 max-h-80 overflow-y-auto"
      >
        {entries.map((entry) => {
          const payload = compactPayload(entry.payload);
          return (
            <div key={entry.id} className="border-b last:border-b-0 py-1">
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-16 shrink-0">
                  {new Date(entry.createdAt).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                <Badge variant="outline" className={`h-5 px-1.5 py-0 text-[10px] ${levelClass(entry.level)}`}>
                  {entry.level.toUpperCase()}
                </Badge>
                <span className="text-muted-foreground truncate">
                  {[entry.phase, entry.code, entry.repo, entry.sha].filter(Boolean).join(' ')}
                </span>
              </div>
              <div className="pl-[4.75rem] break-words">{entry.message}</div>
              {payload && (
                <div className="pl-[4.75rem] text-muted-foreground break-all">
                  {payload}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
