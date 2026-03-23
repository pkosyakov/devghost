'use client';

import { useState, useCallback, useEffect } from 'react';

const FAVORITES_KEY = 'devghost:favoriteModels';
const RECENT_KEY = 'devghost:recentModels';
const MAX_FAVORITES = 10;
const MAX_RECENT = 5;

export interface RecentEntry {
  provider: string;
  id: string;
  usedAt: number;
}

export function useModelPreferences() {
  // Initialize with empty arrays — localStorage is read in useEffect to avoid SSR hydration errors.
  // Next.js renders server-side first where localStorage is undefined; reading it in useState
  // initializer causes "localStorage is not defined" or hydration mismatch.
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);

  // Hydrate from localStorage on mount (client-side only)
  useEffect(() => {
    try {
      const savedFavs = localStorage.getItem(FAVORITES_KEY);
      if (savedFavs) setFavorites(JSON.parse(savedFavs));
    } catch { /* corrupted data — start fresh */ }
    try {
      const savedRecent = localStorage.getItem(RECENT_KEY);
      if (savedRecent) setRecent(JSON.parse(savedRecent));
    } catch { /* corrupted data — start fresh */ }
  }, []);

  const toggleFavorite = useCallback((provider: string, modelId: string) => {
    const key = `${provider}:${modelId}`;
    setFavorites(prev => {
      const next = prev.includes(key)
        ? prev.filter(f => f !== key)
        : [...prev, key].slice(-MAX_FAVORITES);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const isFavorite = useCallback((provider: string, modelId: string) => {
    return favorites.includes(`${provider}:${modelId}`);
  }, [favorites]);

  const addRecent = useCallback((provider: string, modelId: string) => {
    setRecent(prev => {
      const filtered = prev.filter(r => !(r.provider === provider && r.id === modelId));
      const next = [{ provider, id: modelId, usedAt: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { favorites, recent, toggleFavorite, isFavorite, addRecent };
}
