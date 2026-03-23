import type { Developer } from '@/components/developer-card';

export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface MatchResult {
  dev1Index: number;
  dev2Index: number;
  confidence: MatchConfidence;
  reason: string;
}

export interface DeveloperGroup {
  id: string;
  developers: Developer[];
  merged: boolean;
  primaryEmail?: string;
  isSaved?: boolean;
  autoMerged?: boolean;
  matchConfidence?: MatchConfidence;
  matchReason?: string;
}

// ============================================================================
// Matching Strategies
// ============================================================================

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function extractNameParts(name: string): { first: string; last: string; initials: string[] } {
  const parts = normalizeName(name).split(' ').filter(Boolean);
  if (parts.length === 0) return { first: '', last: '', initials: [] };

  const first = parts[0];
  const last = parts[parts.length - 1];
  const initials = parts.map(p => p.charAt(0));

  return { first, last, initials };
}

function extractEmailDomain(email: string): string {
  const parts = email.toLowerCase().split('@');
  return parts.length > 1 ? parts[1] : '';
}

// Levenshtein distance calculation
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// Strategy 1: Exact name match (case-insensitive)
function exactNameMatch(a: Developer, b: Developer): boolean {
  return normalizeName(a.name) === normalizeName(b.name) && a.email !== b.email;
}

// Strategy 2: Same GitHub login
function sameGitHubLogin(a: Developer, b: Developer): boolean {
  return !!(a.login && b.login && a.login === b.login && a.email !== b.email);
}

// Strategy 3: First initial + Last name match
function initialPlusLastName(a: Developer, b: Developer): boolean {
  const partsA = extractNameParts(a.name);
  const partsB = extractNameParts(b.name);

  if (!partsA.last || !partsB.last) return false;
  if (partsA.last !== partsB.last) return false;

  // Check if first names match or one is initial of the other
  const firstA = partsA.first;
  const firstB = partsB.first;

  if (firstA === firstB) return false; // Would be caught by exact match

  // "J" matches "John", "J." matches "John"
  const isInitialA = firstA.length <= 2 && firstA.replace('.', '').length === 1;
  const isInitialB = firstB.length <= 2 && firstB.replace('.', '').length === 1;

  if (isInitialA && firstB.startsWith(firstA.charAt(0))) return true;
  if (isInitialB && firstA.startsWith(firstB.charAt(0))) return true;

  return false;
}

// Strategy 4: Same email domain + similar name
function sameEmailDomainSimilarName(a: Developer, b: Developer): boolean {
  const domainA = extractEmailDomain(a.email);
  const domainB = extractEmailDomain(b.email);

  // Skip common public domains (including GitHub's noreply)
  const publicDomains = [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'mail.ru',
    'yandex.ru',
    'users.noreply.github.com',
    'noreply.github.com',
  ];
  if (publicDomains.includes(domainA) || publicDomains.includes(domainB)) return false;

  if (domainA !== domainB || !domainA) return false;

  // Check if names are similar (Levenshtein <= 3)
  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);

  return levenshteinDistance(nameA, nameB) <= 3 && nameA !== nameB;
}

// Strategy 5: Levenshtein distance on names
function levenshteinMatch(a: Developer, b: Developer): boolean {
  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);

  if (nameA === nameB) return false; // Would be caught by exact match

  // Only match if distance is 1-2 (very close spelling)
  const distance = levenshteinDistance(nameA, nameB);
  return distance > 0 && distance <= 2;
}

// ============================================================================
// Main matching function
// ============================================================================

function findMatch(a: Developer, b: Developer): MatchResult | null {
  // Skip if same email (same person)
  if (a.email.toLowerCase() === b.email.toLowerCase()) return null;

  // Check strategies in priority order
  if (exactNameMatch(a, b)) {
    return { dev1Index: -1, dev2Index: -1, confidence: 'HIGH', reason: 'Exact name match' };
  }

  if (sameGitHubLogin(a, b)) {
    return { dev1Index: -1, dev2Index: -1, confidence: 'HIGH', reason: 'Same GitHub login' };
  }

  if (initialPlusLastName(a, b)) {
    return { dev1Index: -1, dev2Index: -1, confidence: 'MEDIUM', reason: 'Initial + last name' };
  }

  if (sameEmailDomainSimilarName(a, b)) {
    return { dev1Index: -1, dev2Index: -1, confidence: 'MEDIUM', reason: 'Same domain, similar name' };
  }

  if (levenshteinMatch(a, b)) {
    return { dev1Index: -1, dev2Index: -1, confidence: 'LOW', reason: 'Similar spelling' };
  }

  return null;
}

// ============================================================================
// Union-Find for grouping
// ============================================================================

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array(size).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // Path compression
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);

    if (rootX !== rootY) {
      // Union by rank
      if (this.rank[rootX] < this.rank[rootY]) {
        this.parent[rootX] = rootY;
      } else if (this.rank[rootX] > this.rank[rootY]) {
        this.parent[rootY] = rootX;
      } else {
        this.parent[rootY] = rootX;
        this.rank[rootX]++;
      }
    }
  }

  getGroups(): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(i);
    }
    return groups;
  }
}

// ============================================================================
// Main deduplication function
// ============================================================================

export function detectDuplicates(
  developers: Developer[],
  savedMapping?: Record<string, { primary: Developer; mergedFrom: Developer[] }>
): DeveloperGroup[] {
  const groups: DeveloperGroup[] = [];
  const processedEmails = new Set<string>();

  // 1. First, restore saved mappings from database
  if (savedMapping) {
    for (const [primaryEmail, entry] of Object.entries(savedMapping)) {
      const allDevs = [entry.primary, ...(entry.mergedFrom || [])];
      groups.push({
        id: `group-saved-${primaryEmail}`,
        developers: allDevs,
        merged: true,
        primaryEmail,
        isSaved: true,
      });
      allDevs.forEach((d) => processedEmails.add(d.email.toLowerCase()));
    }
  }

  // 2. Filter out already processed developers
  const remainingDevs = developers.filter(
    (d) => !processedEmails.has(d.email.toLowerCase())
  );

  if (remainingDevs.length === 0) {
    return sortGroups(groups);
  }

  // 3. Find all matches between remaining developers
  const matches: (MatchResult & { dev1Index: number; dev2Index: number })[] = [];

  for (let i = 0; i < remainingDevs.length; i++) {
    for (let j = i + 1; j < remainingDevs.length; j++) {
      const match = findMatch(remainingDevs[i], remainingDevs[j]);
      if (match) {
        matches.push({ ...match, dev1Index: i, dev2Index: j });
      }
    }
  }

  // 4. Use Union-Find to group connected developers
  const uf = new UnionFind(remainingDevs.length);
  const matchInfoByGroup = new Map<number, { confidence: MatchConfidence; reason: string }>();

  for (const match of matches) {
    const root1 = uf.find(match.dev1Index);
    const root2 = uf.find(match.dev2Index);

    // Track the highest confidence match for each group
    const existingInfo = matchInfoByGroup.get(root1) || matchInfoByGroup.get(root2);
    const newInfo = { confidence: match.confidence, reason: match.reason };

    // Keep highest confidence (HIGH > MEDIUM > LOW)
    const confidenceOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    if (!existingInfo || confidenceOrder[newInfo.confidence] > confidenceOrder[existingInfo.confidence]) {
      matchInfoByGroup.set(root1, newInfo);
      matchInfoByGroup.set(root2, newInfo);
    }

    uf.union(match.dev1Index, match.dev2Index);
  }

  // 5. Build groups from Union-Find
  const ufGroups = uf.getGroups();

  for (const [root, indices] of ufGroups) {
    const devs = indices.map((i) => remainingDevs[i]);
    const matchInfo = matchInfoByGroup.get(root);

    if (devs.length > 1 && matchInfo) {
      // Multi-developer group with match
      const isHighConfidence = matchInfo.confidence === 'HIGH';
      const primary = selectPrimary(devs);

      groups.push({
        id: `group-auto-${root}-${Date.now()}`,
        developers: devs,
        merged: isHighConfidence, // Auto-merge only HIGH confidence
        primaryEmail: primary.email,
        autoMerged: isHighConfidence,
        matchConfidence: matchInfo.confidence,
        matchReason: matchInfo.reason,
        isSaved: false,
      });
    } else {
      // Single developer or no match info
      groups.push({
        id: `group-single-${devs[0].email}`,
        developers: devs,
        merged: false,
        isSaved: false,
      });
    }
  }

  return sortGroups(groups);
}

// Select primary developer by highest commit count
function selectPrimary(developers: Developer[]): Developer {
  return developers.reduce((primary, current) =>
    current.commitCount > primary.commitCount ? current : primary
  );
}

// Sort groups: suggestions first, then auto-merged, then saved, then singles
function sortGroups(groups: DeveloperGroup[]): DeveloperGroup[] {
  return groups.sort((a, b) => {
    // Suggestions (not merged, but has match) first
    const aIsSuggestion = !a.merged && a.matchConfidence && a.developers.length > 1;
    const bIsSuggestion = !b.merged && b.matchConfidence && b.developers.length > 1;

    if (aIsSuggestion && !bIsSuggestion) return -1;
    if (!aIsSuggestion && bIsSuggestion) return 1;

    // Auto-merged second
    if (a.autoMerged && !b.autoMerged) return -1;
    if (!a.autoMerged && b.autoMerged) return 1;

    // Saved third
    if (a.isSaved && !b.isSaved) return -1;
    if (!a.isSaved && b.isSaved) return 1;

    // By developer count (more developers = more important)
    return b.developers.length - a.developers.length;
  });
}

// Re-export for convenience
export { selectPrimary };
