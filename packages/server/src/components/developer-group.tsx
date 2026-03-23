'use client';

import { useState, memo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { DeveloperCard } from '@/components/developer-card';
import { Merge, Users, ChevronDown, ChevronUp, Undo2, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DeveloperGroup } from '@/lib/deduplication';

// Re-export for consumers that import from this file
export type { DeveloperGroup };

interface DeveloperGroupCardProps {
  group: DeveloperGroup;
  isManualMergeMode: boolean;
  selectedForMerge: Set<string>;
  excludedEmails: Set<string>;
  onToggleMerge: () => void;
  onSetPrimary: (email: string) => void;
  onToggleSelect: (email: string) => void;
  onToggleExclude: (email: string) => void;
  onUnmerge?: () => void;
}

function DeveloperGroupCardComponent({
  group,
  isManualMergeMode,
  selectedForMerge,
  excludedEmails,
  onToggleMerge,
  onSetPrimary,
  onToggleSelect,
  onToggleExclude,
  onUnmerge,
}: DeveloperGroupCardProps) {
  const [expanded, setExpanded] = useState(true);
  const isDuplicate = group.developers.length > 1;
  const isSuggestion = !group.merged && group.matchConfidence && isDuplicate;
  const isAutoMerged = group.autoMerged && group.merged;

  // Calculate exclusion state for group checkbox
  const excludedCount = group.developers.filter((d) => excludedEmails.has(d.email)).length;
  const allExcluded = excludedCount === group.developers.length;
  const someExcluded = excludedCount > 0 && excludedCount < group.developers.length;

  return (
    <Card
      className={cn(
        'overflow-hidden transition-colors',
        // Suggestion (not merged, has match) - orange
        isSuggestion && 'border-orange-300 bg-orange-50/50',
        // Auto-merged - light green
        isAutoMerged && !group.isSaved && 'border-green-300 bg-green-50/30',
        // Saved from DB - green
        isDuplicate && group.isSaved && 'border-green-200 bg-green-50/30',
        // Manually merged (not auto, not saved) - blue
        group.merged && !isAutoMerged && !group.isSaved && 'border-blue-200 bg-blue-50/30'
      )}
    >
      {/* Group Header */}
      {isDuplicate && (
        <div
          className={cn(
            'px-4 py-2 border-b flex items-center justify-between',
            isSuggestion && 'bg-orange-100/70',
            isAutoMerged && !group.isSaved && 'bg-green-100/50',
            group.isSaved && 'bg-green-100/50',
            group.merged && !isAutoMerged && !group.isSaved && 'bg-blue-100/50'
          )}
        >
          <div className="flex items-center gap-3">
            {/* Group inclusion checkbox */}
            {!isManualMergeMode && (
              <Checkbox
                checked={!allExcluded}
                className={someExcluded ? 'data-[state=checked]:bg-muted-foreground' : ''}
                onCheckedChange={() => {
                  // Toggle all developers in group
                  for (const dev of group.developers) {
                    if (allExcluded) {
                      // Include all
                      if (excludedEmails.has(dev.email)) {
                        onToggleExclude(dev.email);
                      }
                    } else {
                      // Exclude all
                      if (!excludedEmails.has(dev.email)) {
                        onToggleExclude(dev.email);
                      }
                    }
                  }
                }}
              />
            )}
            <div className="flex items-center gap-2">
              {!isManualMergeMode && (
                <Checkbox
                  checked={group.merged}
                  onCheckedChange={onToggleMerge}
                />
              )}
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm">
                {group.isSaved
                  ? 'Previously Merged'
                  : isSuggestion
                    ? 'Potential Duplicate'
                    : isAutoMerged
                      ? 'Auto-Merged'
                      : 'Merged'}:
              </span>
              <Badge variant="secondary">{group.developers.length} profiles</Badge>
            </div>

            {/* Status badges */}
            {isSuggestion && group.matchReason && (
              <Badge variant="outline" className="gap-1 bg-orange-100 text-orange-700 border-orange-300">
                <AlertCircle className="h-3 w-3" />
                {group.matchReason}
              </Badge>
            )}
            {isAutoMerged && group.matchReason && (
              <Badge variant="outline" className="gap-1 bg-green-100 text-green-700 border-green-300">
                <Sparkles className="h-3 w-3" />
                {group.matchReason}
              </Badge>
            )}
            {group.merged && !isAutoMerged && !group.isSaved && (
              <Badge variant="default" className="gap-1">
                <Merge className="h-3 w-3" />
                Manual
              </Badge>
            )}
            {group.isSaved && (
              <Badge variant="outline" className="gap-1 bg-green-100 text-green-700 border-green-300">
                <CheckCircle2 className="h-3 w-3" />
                Saved
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Undo button for saved, auto-merged, or manually merged groups */}
            {(group.isSaved || isAutoMerged || (group.merged && !isSuggestion)) && onUnmerge && (
              <Button variant="ghost" size="sm" onClick={onUnmerge}>
                <Undo2 className="h-4 w-4 mr-1" />
                Undo
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Developers */}
      <CardContent className={cn('p-0', !expanded && 'hidden')}>
        <div className="divide-y">
          {group.developers.map((dev, idx) => {
            const devKey = `${dev.name}-${dev.email}`;
            const isSelected = selectedForMerge.has(devKey);
            const isPrimary = group.merged && dev.email === (group.primaryEmail || group.developers[0].email);
            const isExcluded = excludedEmails.has(dev.email);

            return (
              <div
                key={dev.email}
                className={cn(
                  idx > 0 && isDuplicate && !isManualMergeMode && 'border-l-2 border-dashed ml-4'
                )}
              >
                <DeveloperCard
                  developer={dev}
                  isSelected={isManualMergeMode && isSelected}
                  isPrimary={isPrimary}
                  isExcluded={isExcluded}
                  showCheckbox={isManualMergeMode}
                  showRadio={!isManualMergeMode && group.merged && isDuplicate}
                  showInclusionCheckbox={!isManualMergeMode && !isDuplicate}
                  onSelect={() => onToggleSelect(devKey)}
                  onSetPrimary={() => onSetPrimary(dev.email)}
                  onToggleExclude={() => onToggleExclude(dev.email)}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export const DeveloperGroupCard = memo(DeveloperGroupCardComponent);
DeveloperGroupCard.displayName = 'DeveloperGroupCard';
