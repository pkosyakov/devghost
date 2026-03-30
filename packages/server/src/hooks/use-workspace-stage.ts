import { useQuery } from '@tanstack/react-query';

export type WorkspaceStage = 'empty' | 'first_data' | 'operational';

interface WorkspaceStageData {
  workspaceStage: WorkspaceStage;
  onboarding: {
    needsFirstSavedView: boolean;
    savedViewCount: number;
  };
}

export function useWorkspaceStage() {
  return useQuery<WorkspaceStageData>({
    queryKey: ['workspace-stage'],
    queryFn: async () => {
      const res = await fetch('/api/v2/workspace-stage');
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
