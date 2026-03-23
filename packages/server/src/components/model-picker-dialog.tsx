'use client';

import { useState } from 'react';
import { useModelPreferences } from '@/hooks/use-model-preferences';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Star, ChevronsUpDown, Loader2 } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  inputPricePerMToken?: number;
  outputPricePerMToken?: number;
  size?: string; // Ollama only
}

interface ModelPickerDialogProps {
  provider: 'ollama' | 'openrouter';
  models: ModelInfo[];
  isLoading: boolean;
  selectedModelId: string | null;
  onSelect: (model: ModelInfo) => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtCtx(ctx: number | null): string {
  if (ctx == null) return '?';
  if (ctx >= 1024) return `${Math.round(ctx / 1024)}K`;
  return String(ctx);
}

function fmtPrice(input?: number, output?: number): string | null {
  if (input == null || output == null) return null;
  return `$${input < 1 ? input.toFixed(2) : Math.round(input)}/$${output < 1 ? output.toFixed(2) : Math.round(output)}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ModelPickerDialog({
  provider,
  models,
  isLoading,
  selectedModelId,
  onSelect,
}: ModelPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const { isFavorite, toggleFavorite, recent } =
    useModelPreferences();

  const selectedModel = models.find((m) => m.id === selectedModelId);

  const favoriteModels = models.filter((m) => isFavorite(provider, m.id));
  const recentIds = recent
    .filter((r) => r.provider === provider)
    .map((r) => r.id);
  const recentModels = recentIds
    .map((id) => models.find((m) => m.id === id))
    .filter((m): m is ModelInfo => m != null);

  // Exclude favorites and recent from "All Models" to avoid duplicates
  const shownIds = new Set([
    ...favoriteModels.map((m) => m.id),
    ...recentModels.map((m) => m.id),
  ]);
  const allModels = models.filter((m) => !shownIds.has(m.id));

  function handleSelect(model: ModelInfo) {
    onSelect(model);
    setOpen(false);
  }

  function renderItem(model: ModelInfo) {
    const fav = isFavorite(provider, model.id);
    const price = fmtPrice(model.inputPricePerMToken, model.outputPricePerMToken);

    return (
      <CommandItem
        key={model.id}
        value={model.id}
        onSelect={() => handleSelect(model)}
        className="flex items-center gap-2"
      >
        <button
          type="button"
          className="shrink-0 p-0.5 rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleFavorite(provider, model.id);
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
        >
          <Star
            className={`h-4 w-4 ${fav ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'}`}
          />
        </button>

        <span className="truncate flex-1 min-w-0">{model.name}</span>

        <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
          {fmtCtx(model.contextLength)}
        </Badge>

        {provider === 'openrouter' && price && (
          <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
            {price}
          </Badge>
        )}

        {provider === 'ollama' && model.size && (
          <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
            {model.size}
          </Badge>
        )}
      </CommandItem>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[260px] h-8 justify-between text-sm font-normal"
        >
          <span className="truncate">
            {selectedModel ? selectedModel.name : 'Select model...'}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle>Select Model</DialogTitle>
        </DialogHeader>

        <Command className="rounded-none border-0">
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-[350px]">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  Loading models...
                </span>
              </div>
            ) : (
              <>
                <CommandEmpty>No models found</CommandEmpty>

                {favoriteModels.length > 0 && (
                  <CommandGroup heading="Favorites">
                    {favoriteModels.map(renderItem)}
                  </CommandGroup>
                )}

                {recentModels.length > 0 && (
                  <CommandGroup heading="Recent">
                    {recentModels.map(renderItem)}
                  </CommandGroup>
                )}

                {allModels.length > 0 && (
                  <CommandGroup heading="All Models">
                    {allModels.map(renderItem)}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
