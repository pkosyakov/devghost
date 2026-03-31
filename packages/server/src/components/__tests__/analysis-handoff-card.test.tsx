// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalysisHandoffCard } from '../analysis-handoff-card';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      'handoff.title': 'Your analysis is complete.',
      'handoff.description': 'Review the imported data.',
      'handoff.peopleCta': 'Review contributors',
      'handoff.repositoriesCta': 'Check repositories',
      'handoff.teamCta': 'Create first team',
      'handoff.teamFallbackCta': 'Find a repository to start your first team',
      'handoff.operationalLabel': 'Review imported data:',
      'handoff.operationalPeople': 'People',
      'handoff.operationalRepositories': 'Repositories',
    };
    return map[key] ?? key;
  },
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('AnalysisHandoffCard', () => {
  it('renders prominent variant for first_data stage', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId="repo-abc"
        unresolvedIdentityCount={0}
      />
    );
    expect(screen.getByText('Your analysis is complete.')).toBeTruthy();
    expect(screen.getByText('Review contributors')).toBeTruthy();
    expect(screen.getByText('Check repositories')).toBeTruthy();
    expect(screen.getByText('Create first team')).toBeTruthy();
  });

  it('links team CTA to specific repo when topCanonicalRepoId is provided', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId="repo-abc"
        unresolvedIdentityCount={0}
      />
    );
    const teamLink = screen.getByText('Create first team').closest('a');
    expect(teamLink?.getAttribute('href')).toBe('/repositories/repo-abc?fromAnalysis=order-1');
  });

  it('uses fallback CTA when topCanonicalRepoId is null', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId={null}
        unresolvedIdentityCount={0}
      />
    );
    expect(screen.getByText('Find a repository to start your first team')).toBeTruthy();
    const fallbackLink = screen.getByText('Find a repository to start your first team').closest('a');
    expect(fallbackLink?.getAttribute('href')).toBe('/repositories?fromAnalysis=order-1');
  });

  it('renders compact variant for operational stage', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="operational"
        topCanonicalRepoId={null}
        unresolvedIdentityCount={0}
      />
    );
    expect(screen.getByText('Review imported data:')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.getByText('Repositories')).toBeTruthy();
    // No team CTA in operational
    expect(screen.queryByText('Create first team')).toBeNull();
  });

  it('shows identity banner when unresolvedIdentityCount > 0', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId={null}
        unresolvedIdentityCount={5}
      />
    );
    // Identity banner links carry fromAnalysis
    const links = screen.getAllByRole('link');
    const identityLink = links.find(
      (l) => l.getAttribute('href')?.includes('identityHealth=unresolved')
    );
    expect(identityLink?.getAttribute('href')).toContain('fromAnalysis=order-1');
  });
});
