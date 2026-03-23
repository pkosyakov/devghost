'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Loader2, Settings2 } from 'lucide-react';
import {
  AnalysisPeriodInline,
  type AnalysisPeriodSettings,
} from '@/components/analysis-period-selector';

export type { AnalysisPeriodSettings };

interface EditScopePanelProps {
  currentSettings: AnalysisPeriodSettings;
  onSubmit: (settings: AnalysisPeriodSettings, forceRecalculate: boolean) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  availableStartDate?: Date;
  availableEndDate?: Date;
  /** Warning shown when current mode will be changed (e.g. SELECTED_YEARS → DATE_RANGE) */
  modeChangeWarning?: string;
}

export function EditScopePanel({
  currentSettings,
  onSubmit,
  onCancel,
  isSubmitting,
  availableStartDate,
  availableEndDate,
  modeChangeWarning,
}: EditScopePanelProps) {
  const [settings, setSettings] = useState<AnalysisPeriodSettings>(currentSettings);
  const [forceRecalculate, setForceRecalculate] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          Edit Analysis Scope
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {modeChangeWarning && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{modeChangeWarning}</span>
          </div>
        )}
        <AnalysisPeriodInline
          settings={settings}
          onChange={setSettings}
          availableStartDate={availableStartDate}
          availableEndDate={availableEndDate}
        />

        <div className="flex items-center space-x-2">
          <Checkbox
            id="force-recalculate"
            checked={forceRecalculate}
            onCheckedChange={(checked) => setForceRecalculate(checked === true)}
          />
          <Label htmlFor="force-recalculate" className="text-sm text-muted-foreground">
            Recalculate all commits (ignore cache)
          </Label>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            onClick={() => onSubmit(settings, forceRecalculate)}
            disabled={isSubmitting}
            size="sm"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save & Analyze
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
