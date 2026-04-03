'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Globe } from 'lucide-react';
import { locales } from '@/i18n/routing';
import { cn } from '@/lib/utils';

const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  ru: 'Русский',
};

interface LanguageSwitcherProps {
  className?: string;
  /** Accessible name for the trigger (e.g. translated "Language"). */
  ariaLabel?: string;
}

export function LanguageSwitcher({ className, ariaLabel }: LanguageSwitcherProps) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const handleChange = (newLocale: string) => {
    router.replace(pathname, { locale: newLocale });
  };

  return (
    <Select value={locale} onValueChange={handleChange}>
      <SelectTrigger
        className={cn('h-9 w-[132px]', className)}
        aria-label={ariaLabel}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Globe className="h-4 w-4 shrink-0 opacity-70" />
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent>
        {locales.map((value) => (
          <SelectItem key={value} value={value}>
            {LOCALE_LABELS[value] ?? value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
