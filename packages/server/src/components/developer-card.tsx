'use client';

import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { User, Mail, GitCommit, Calendar, Github } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Developer {
  email: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  commitCount: number;
  repositories: string[];
  firstCommitAt: string;
  lastCommitAt: string;
}

interface DeveloperCardProps {
  developer: Developer;
  isSelected?: boolean;
  isPrimary?: boolean;
  isExcluded?: boolean;
  showCheckbox?: boolean;
  showRadio?: boolean;
  showInclusionCheckbox?: boolean;
  onSelect?: () => void;
  onSetPrimary?: () => void;
  onToggleExclude?: () => void;
  className?: string;
}

function DeveloperCardComponent({
  developer,
  isSelected = false,
  isPrimary = false,
  isExcluded = false,
  showCheckbox = false,
  showRadio = false,
  showInclusionCheckbox = false,
  onSelect,
  onSetPrimary,
  onToggleExclude,
  className,
}: DeveloperCardProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 p-3 rounded-lg transition-colors',
        isSelected && 'bg-green-50 border-l-4 border-green-400',
        isPrimary && !isSelected && 'bg-blue-50',
        isExcluded && 'opacity-50',
        !isSelected && !isPrimary && !isExcluded && 'hover:bg-muted/50',
        className
      )}
      onClick={showCheckbox ? onSelect : undefined}
    >
      {/* Inclusion Checkbox - for including/excluding from analysis */}
      {showInclusionCheckbox && (
        <Checkbox
          checked={!isExcluded}
          onCheckedChange={onToggleExclude}
          className="mt-1"
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {/* Selection Controls - for manual merge mode */}
      {showCheckbox && !showInclusionCheckbox && (
        <Checkbox
          checked={isSelected}
          onCheckedChange={onSelect}
          className="mt-1"
        />
      )}
      {showRadio && onSetPrimary && (
        <input
          type="radio"
          checked={isPrimary}
          onChange={onSetPrimary}
          className="mt-1.5 h-4 w-4 text-primary"
          aria-label={`Select ${developer.name || developer.email} as primary`}
        />
      )}

      {/* Avatar */}
      {developer.avatarUrl ? (
        <img
          src={developer.avatarUrl}
          alt={developer.name}
          className="w-10 h-10 rounded-full flex-shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
          <User className="h-5 w-5 text-muted-foreground" />
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{developer.name}</span>
          {developer.login && (
            <Badge variant="outline" className="text-xs gap-1">
              <Github className="h-3 w-3" />
              {developer.login}
            </Badge>
          )}
          {isPrimary && (
            <Badge variant="default" className="text-xs">
              Primary
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
          <span className="flex items-center gap-1 truncate">
            <Mail className="h-3 w-3 flex-shrink-0" />
            {developer.email}
          </span>
        </div>

        <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
          <span className="flex items-center gap-1">
            <GitCommit className="h-3 w-3" />
            {developer.commitCount} commits
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {new Date(developer.firstCommitAt).toLocaleDateString()} -{' '}
            {new Date(developer.lastCommitAt).toLocaleDateString()}
          </span>
        </div>

        {/* Repositories */}
        <div className="flex gap-1 mt-2 flex-wrap">
          {developer.repositories.map((repo) => (
            <Badge key={repo} variant="secondary" className="text-xs">
              {repo}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

export const DeveloperCard = memo(DeveloperCardComponent);
DeveloperCard.displayName = 'DeveloperCard';
