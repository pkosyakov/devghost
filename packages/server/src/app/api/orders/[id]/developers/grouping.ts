export interface CommitAuthorInput {
  email: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  date: string;
  repoName: string;
}

export interface ExtractedDeveloper {
  email: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  commitCount: number;
  repositories: string[];
  firstCommitAt: string;
  lastCommitAt: string;
}

/**
 * Group commit authors into unique developers.
 *
 * Grouping strategies (in priority order):
 *   1. Same GitHub login (deterministic provider signal)
 *   2. Same email, case-insensitive (primary identity key)
 *
 * Strategy 3 (exact name match) has been intentionally removed to prevent
 * silent merging of different people who share the same name.
 * Commits with no email are skipped.
 */
export function groupCommitAuthors(authors: CommitAuthorInput[]): ExtractedDeveloper[] {
  const devsByKey = new Map<string, ExtractedDeveloper>();
  // Secondary index: login → key, for O(1) login lookup
  const loginIndex = new Map<string, string>();

  for (const author of authors) {
    const email = author.email?.toLowerCase() || '';
    const name = author.name || '';
    const login = author.login || null;
    const avatarUrl = author.avatarUrl || null;
    const commitDate = author.date;
    const repoName = author.repoName;

    // Skip commits with no email
    const key = email;
    if (!key) continue;

    // Strategy 1: GitHub login (most reliable)
    let matchKey: string | null = null;
    if (login && loginIndex.has(login)) {
      matchKey = loginIndex.get(login)!;
    }

    // Strategy 2: Exact email match (case-insensitive via lowercase key)
    if (!matchKey && devsByKey.has(key)) {
      matchKey = key;
    }

    if (matchKey) {
      // Update existing developer
      const dev = devsByKey.get(matchKey)!;
      dev.commitCount++;
      if (!dev.repositories.includes(repoName)) {
        dev.repositories.push(repoName);
      }
      // Update login/avatar if we found them
      if (login && !dev.login) {
        dev.login = login;
        loginIndex.set(login, matchKey);
      }
      if (avatarUrl && !dev.avatarUrl) dev.avatarUrl = avatarUrl;
      // Update date range
      if (commitDate < dev.firstCommitAt) dev.firstCommitAt = commitDate;
      if (commitDate > dev.lastCommitAt) dev.lastCommitAt = commitDate;
    } else {
      // Create new developer entry
      devsByKey.set(key, {
        email,
        name,
        login,
        avatarUrl,
        commitCount: 1,
        repositories: [repoName],
        firstCommitAt: commitDate,
        lastCommitAt: commitDate,
      });
      if (login) {
        loginIndex.set(login, key);
      }
    }
  }

  return Array.from(devsByKey.values());
}
