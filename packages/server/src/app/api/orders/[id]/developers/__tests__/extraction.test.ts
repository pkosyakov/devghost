import { describe, it, expect } from 'vitest';
import { groupCommitAuthors } from '../grouping';

describe('groupCommitAuthors', () => {
  it('should NOT merge authors with same name but different emails', () => {
    // Two people named "John Smith" with different emails must remain separate
    const authors = [
      { email: 'john@company-a.com', name: 'John Smith', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'john@company-b.com', name: 'John Smith', login: null, avatarUrl: null, date: '2025-01-02', repoName: 'repo1' },
    ];
    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(2);
    expect(result.map(d => d.email).sort()).toEqual(['john@company-a.com', 'john@company-b.com']);
  });

  it('should merge authors with same email (case-insensitive)', () => {
    const authors = [
      { email: 'john@example.com', name: 'John', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'John@Example.com', name: 'John S', login: null, avatarUrl: null, date: '2025-01-02', repoName: 'repo1' },
    ];
    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].commitCount).toBe(2);
  });

  it('should merge authors with same GitHub login', () => {
    const authors = [
      { email: 'john@personal.com', name: 'John', login: 'johndev', avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'john@work.com', name: 'John Smith', login: 'johndev', avatarUrl: null, date: '2025-01-02', repoName: 'repo1' },
    ];
    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].commitCount).toBe(2);
    expect(result[0].login).toBe('johndev');
  });

  it('should skip commits with no email', () => {
    const authors = [
      { email: '', name: 'Unknown', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'real@example.com', name: 'Real Person', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
    ];
    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('real@example.com');
  });

  it('should accumulate repositories across commits', () => {
    const authors = [
      { email: 'dev@example.com', name: 'Dev', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'dev@example.com', name: 'Dev', login: null, avatarUrl: null, date: '2025-01-02', repoName: 'repo2' },
    ];
    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].repositories).toEqual(['repo1', 'repo2']);
  });
});
