'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandItem,
} from '@/components/ui/command';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronDown } from 'lucide-react';
import { type TimelineDeveloper } from './effort-timeline-utils';

interface DeveloperMultiSelectProps {
  developers: TimelineDeveloper[];
  selected: string[];          // selected emails
  onChange: (emails: string[]) => void;
}

export function DeveloperMultiSelect({ developers, selected, onChange }: DeveloperMultiSelectProps) {
  const t = useTranslations('components.developerSelect');
  const [open, setOpen] = useState(false);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const allSelected = selected.length === developers.length && selected.length > 0;
  const noneSelected = selected.length === 0;
  const label = allSelected
    ? t('allDevelopers', { count: developers.length })
    : t('xOfY', { selected: selected.length, total: developers.length });

  const toggle = (email: string) => {
    onChange(
      selectedSet.has(email)
        ? selected.filter(e => e !== email)
        : [...selected, email],
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="justify-between min-w-[200px]">
          {label}
          <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('search')} />
          <div className="flex gap-2 p-2 border-b">
            <Button
              variant="ghost" size="sm" className="h-7 text-xs"
              onClick={() => onChange(developers.map(d => d.email))}
              disabled={allSelected}
            >
              {t('selectAll')}
            </Button>
            <Button
              variant="ghost" size="sm" className="h-7 text-xs"
              onClick={() => onChange([])}
              disabled={noneSelected}
            >
              {t('deselectAll')}
            </Button>
          </div>
          <CommandList className="max-h-[300px]">
            <CommandEmpty>{t('noResults')}</CommandEmpty>
            {developers.map(dev => (
              <CommandItem
                key={dev.email}
                value={dev.name}
                onSelect={() => toggle(dev.email)}
                className="cursor-pointer"
              >
                <Checkbox
                  checked={selectedSet.has(dev.email)}
                  className="mr-2 pointer-events-none"
                />
                <span className="truncate">{dev.name}</span>
                <span className="ml-auto text-xs text-muted-foreground truncate max-w-[120px]">
                  {dev.email}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
