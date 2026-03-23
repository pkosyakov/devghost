import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatPercentage(value: number, showSign: boolean = true): string {
  const sign = showSign && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatFileSize(sizeKb: number): string {
  if (sizeKb < 1024) {
    return `${sizeKb} KB`;
  }
  const sizeMb = sizeKb / 1024;
  if (sizeMb < 1024) {
    return `${sizeMb.toFixed(1)} MB`;
  }
  const sizeGb = sizeMb / 1024;
  return `${sizeGb.toFixed(2)} GB`;
}

export function formatRelativeTime(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 4) return `${diffWeek}w ago`;
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${diffYear}y ago`;
}

/** Tailwind text color classes for Ghost% color categories */
export const ghostTextColors: Record<string, string> = {
  green: 'text-green-600 dark:text-green-400',
  yellow: 'text-yellow-600 dark:text-yellow-400',
  red: 'text-red-600 dark:text-red-400',
  gray: '',
};

/**
 * Convert Prisma Decimal fields to JavaScript numbers
 * @param obj - Object containing potential Decimal fields
 * @param fields - Array of field names to convert
 * @returns New object with Decimals converted to numbers
 */
export function normalizeDecimals<T extends Record<string, unknown>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const result = { ...obj };

  for (const field of fields) {
    const value = result[field];
    if (value === null || value === undefined) {
      continue;
    }
    // Handle Prisma Decimal objects
    if (typeof value === 'object' && value !== null) {
      if ('toNumber' in value && typeof value.toNumber === 'function') {
        (result as Record<string, unknown>)[field as string] = value.toNumber();
      } else {
        (result as Record<string, unknown>)[field as string] = Number(value);
      }
    }
  }

  return result;
}

