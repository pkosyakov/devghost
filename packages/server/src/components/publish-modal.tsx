'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface DeveloperInfo {
  email: string;
  name: string | null;
}

interface PublishModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  repository: string;
  developers: DeveloperInfo[];
  onPublished: (shareToken: string) => void;
}

export function PublishModal({
  open,
  onOpenChange,
  orderId,
  repository,
  developers,
  onPublished,
}: PublishModalProps) {
  const { toast } = useToast();
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(
    new Set(developers.map((d) => d.email))
  );

  const toggleDeveloper = (email: string) => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedEmails.size === developers.length) {
      setSelectedEmails(new Set());
    } else {
      setSelectedEmails(new Set(developers.map((d) => d.email)));
    }
  };

  const publishMutation = useMutation({
    mutationFn: async () => {
      const allSelected = selectedEmails.size === developers.length;
      const visibleDevelopers = allSelected
        ? null
        : Array.from(selectedEmails);

      const res = await fetch('/api/publications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, repository, visibleDevelopers }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to publish');
      return json.data;
    },
    onSuccess: (data) => {
      toast({ title: 'Published successfully' });
      onOpenChange(false);
      onPublished(data.shareToken);
    },
    onError: (err: Error) => {
      toast({
        title: 'Failed to publish',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Publish Analytics</DialogTitle>
          <DialogDescription>
            Publish analytics for <span className="font-medium">{repository}</span>.
            Select which developers to include in the public view.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-64 overflow-y-auto py-2">
          <div className="flex items-center gap-2 pb-2 border-b">
            <Checkbox
              id="select-all"
              checked={selectedEmails.size === developers.length}
              onCheckedChange={toggleAll}
            />
            <Label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
              Select all ({developers.length})
            </Label>
          </div>

          {developers.map((dev) => (
            <div key={dev.email} className="flex items-center gap-2">
              <Checkbox
                id={`dev-${dev.email}`}
                checked={selectedEmails.has(dev.email)}
                onCheckedChange={() => toggleDeveloper(dev.email)}
              />
              <Label htmlFor={`dev-${dev.email}`} className="text-sm cursor-pointer">
                {dev.name || dev.email}
                {dev.name && (
                  <span className="text-muted-foreground ml-1">({dev.email})</span>
                )}
              </Label>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => publishMutation.mutate()}
            disabled={publishMutation.isPending || selectedEmails.size === 0}
          >
            {publishMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Publish ({selectedEmails.size} developer{selectedEmails.size !== 1 ? 's' : ''})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
