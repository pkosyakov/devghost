// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalysisReturnBanner } from '../analysis-return-banner';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      'returnBanner.text': 'You came here from analysis results.',
      'returnBanner.cta': 'Back to analysis results',
    };
    return map[key] ?? key;
  },
}));

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

// Mock i18n Link
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('AnalysisReturnBanner', () => {
  it('renders nothing when fromAnalysis param is absent', () => {
    mockSearchParams.delete('fromAnalysis');
    const { container } = render(<AnalysisReturnBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders banner with return link when fromAnalysis param is present', () => {
    mockSearchParams.set('fromAnalysis', 'order-123');
    render(<AnalysisReturnBanner />);
    expect(screen.getByText('You came here from analysis results.')).toBeTruthy();
    const link = screen.getByText('Back to analysis results').closest('a');
    expect(link?.getAttribute('href')).toBe('/orders/order-123');
  });

  it('renders nothing when fromAnalysis param is empty string', () => {
    mockSearchParams.set('fromAnalysis', '');
    const { container } = render(<AnalysisReturnBanner />);
    expect(container.innerHTML).toBe('');
  });
});
