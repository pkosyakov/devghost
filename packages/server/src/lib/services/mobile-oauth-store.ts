import crypto from 'crypto';

interface OAuthStateEntry {
  userId: string;
  codeChallenge: string;
  githubToken?: string;
  authCode?: string;
  expiresAt: number;
}

const store = new Map<string, OAuthStateEntry>();

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) {
      store.delete(key);
    }
  }
}, 5 * 60 * 1000);

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createOAuthState(userId: string, codeChallenge: string): string {
  const state = crypto.randomBytes(32).toString('base64url');
  store.set(state, {
    userId,
    codeChallenge,
    expiresAt: Date.now() + TTL_MS,
  });
  return state;
}

export function getOAuthState(state: string): OAuthStateEntry | null {
  const entry = store.get(state);
  if (!entry || entry.expiresAt < Date.now()) {
    store.delete(state);
    return null;
  }
  return entry;
}

export function updateOAuthState(state: string, updates: Partial<OAuthStateEntry>): boolean {
  const entry = store.get(state);
  if (!entry || entry.expiresAt < Date.now()) {
    return false;
  }
  Object.assign(entry, updates);
  return true;
}

export function deleteOAuthState(state: string): void {
  store.delete(state);
}

export function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return hash === codeChallenge;
}
