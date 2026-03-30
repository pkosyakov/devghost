import { describe, expect, it } from 'vitest';
import {
  buildSavedViewReadableWhere,
  buildSavedViewWritableWhere,
} from '@/lib/saved-view-access';

describe('saved-view-access', () => {
  const workspaceId = 'ws_1';
  const actorUserId = 'user_42';

  describe('buildSavedViewReadableWhere', () => {
    it('allows workspace-visible or owned views', () => {
      const where = buildSavedViewReadableWhere(workspaceId, actorUserId);

      expect(where).toEqual({
        workspaceId: 'ws_1',
        OR: [
          { visibility: 'WORKSPACE' },
          { ownerUserId: 'user_42' },
        ],
      });
    });

    it('scopes to the correct workspace', () => {
      const where = buildSavedViewReadableWhere('ws_other', actorUserId);
      expect(where.workspaceId).toBe('ws_other');
    });
  });

  describe('buildSavedViewWritableWhere', () => {
    it('restricts writes to the owner only', () => {
      const where = buildSavedViewWritableWhere(workspaceId, actorUserId);

      expect(where).toEqual({
        workspaceId: 'ws_1',
        ownerUserId: 'user_42',
      });
    });

    it('does not include visibility — non-owners cannot edit', () => {
      const where = buildSavedViewWritableWhere(workspaceId, actorUserId);
      expect(where).not.toHaveProperty('OR');
      expect(where).not.toHaveProperty('visibility');
    });
  });
});
