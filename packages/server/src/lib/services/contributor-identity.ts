import { prisma } from '@/lib/db';
import { analysisLogger } from '@/lib/logger';
import { ensureWorkspaceForUser } from './workspace-service';
import type { Contributor } from '@prisma/client';

const log = analysisLogger.child({ service: 'contributor-identity' });

// ─── Types ───

interface RawAlias {
  email: string;
  displayName: string;
  username?: string;
  providerId?: string;
  providerType: string;
  source: 'primary' | 'merged_from';
}

type IdentityHealthStatus = 'healthy' | 'attention' | 'unresolved';

interface IdentityHealth {
  status: IdentityHealthStatus;
  unresolvedAliasCount: number;
}

// ─── Extract aliases from Order data ───

export function extractAliasesFromOrder(order: {
  selectedDevelopers: any;
  developerMapping: any;
}): RawAlias[] {
  const seen = new Map<string, RawAlias>();
  const developers: any[] = Array.isArray(order.selectedDevelopers)
    ? order.selectedDevelopers
    : [];

  for (const dev of developers) {
    const email = (dev.email || '').toLowerCase().trim();
    if (!email) continue;
    seen.set(email, {
      email,
      displayName: dev.name || dev.login || email,
      username: dev.login || dev.username || undefined,
      providerId: dev.id?.toString() || undefined,
      providerType: 'github',
      source: 'primary',
    });
  }

  const mapping = order.developerMapping || {};
  for (const key of Object.keys(mapping)) {
    const group = mapping[key];
    if (!group) continue;

    if (group.primary?.email) {
      const email = group.primary.email.toLowerCase().trim();
      if (!seen.has(email)) {
        seen.set(email, {
          email,
          displayName: group.primary.name || email,
          username: group.primary.login || group.primary.username || undefined,
          providerId: group.primary.id?.toString() || undefined,
          providerType: 'github',
          source: 'primary',
        });
      }
    }

    const mergedFrom: any[] = Array.isArray(group.merged_from) ? group.merged_from : [];
    for (const alias of mergedFrom) {
      const email = (alias.email || '').toLowerCase().trim();
      if (!email || seen.has(email)) continue;
      seen.set(email, {
        email,
        displayName: alias.name || alias.login || email,
        username: alias.login || alias.username || undefined,
        providerId: alias.id?.toString() || undefined,
        providerType: 'github',
        source: 'merged_from',
      });
    }
  }

  return Array.from(seen.values());
}

// ─── Identity health computation ───

export function computeIdentityHealth(counts: {
  resolvedCount: number;
  unresolvedCount: number;
}): IdentityHealth {
  const { resolvedCount, unresolvedCount } = counts;
  let status: IdentityHealthStatus;

  if (unresolvedCount === 0) {
    status = 'healthy';
  } else if (resolvedCount > 0) {
    status = 'attention';
  } else {
    status = 'unresolved';
  }

  return { status, unresolvedAliasCount: unresolvedCount };
}

// ─── Auto-merge rules ───

async function findContributorMatch(
  workspaceId: string,
  raw: RawAlias
): Promise<Contributor | null> {
  if (raw.providerId) {
    const aliasMatch = await prisma.contributorAlias.findFirst({
      where: {
        workspaceId,
        providerType: raw.providerType,
        providerId: raw.providerId,
        contributorId: { not: null },
      },
      include: { contributor: true },
    });
    if (aliasMatch?.contributor) {
      return aliasMatch.contributor;
    }
  }

  const contributor = await prisma.contributor.findFirst({
    where: { workspaceId, primaryEmail: raw.email },
  });
  if (contributor) return contributor;

  return null;
}

// ─── Safe email sync (handles unique constraint collisions) ───

async function resolveEmailConflict(
  aliasId: string,
  workspaceId: string,
  providerType: string,
  newEmail: string,
): Promise<string | null> {
  const conflicting = await prisma.contributorAlias.findFirst({
    where: { workspaceId, providerType, email: newEmail, id: { not: aliasId } },
  });

  if (!conflicting) return newEmail;

  if (!conflicting.contributorId && conflicting.resolveStatus === 'UNRESOLVED') {
    // Orphan unresolved alias — safe to absorb before updating email
    await prisma.contributorAlias.delete({ where: { id: conflicting.id } });
    log.info({ deletedAliasId: conflicting.id, email: newEmail }, 'Absorbed orphan alias during email sync');
    return newEmail;
  }

  // Conflict with a resolved/attached alias — skip email update to avoid crash
  log.warn({ aliasId, conflictingAliasId: conflicting.id, newEmail }, 'Email sync skipped — conflicting alias exists');
  return null;
}

// ─── Project contributors from a single order ───

export async function projectContributorsFromOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, selectedDevelopers: true, developerMapping: true },
  });

  if (!order) {
    log.warn({ orderId }, 'Order not found for projection');
    return;
  }

  const workspace = await ensureWorkspaceForUser(order.userId);
  const rawAliases = extractAliasesFromOrder(order);

  if (rawAliases.length === 0) {
    log.debug({ orderId }, 'No aliases to project');
    return;
  }

  for (const raw of rawAliases) {
    // Look up existing alias: prefer providerId match, fall back to email
    let existingAlias = null;
    if (raw.providerId) {
      existingAlias = await prisma.contributorAlias.findFirst({
        where: { workspaceId: workspace.id, providerType: raw.providerType, providerId: raw.providerId },
      });
    }
    if (!existingAlias) {
      existingAlias = await prisma.contributorAlias.findFirst({
        where: { workspaceId: workspace.id, providerType: raw.providerType, email: raw.email },
      });
    }

    if (existingAlias) {
      if (existingAlias.resolveStatus === 'MANUAL') {
        const manualData: any = {
          lastSeenAt: new Date(),
          username: raw.username || existingAlias.username,
        };
        if (raw.email !== existingAlias.email) {
          const safeEmail = await resolveEmailConflict(existingAlias.id, workspace.id, raw.providerType, raw.email);
          if (safeEmail) manualData.email = safeEmail;
        }
        await prisma.contributorAlias.update({
          where: { id: existingAlias.id },
          data: manualData,
        });
        continue;
      }

      const updateData: any = {
        lastSeenAt: new Date(),
        username: raw.username || existingAlias.username,
      };

      if (raw.providerId && !existingAlias.providerId) {
        updateData.providerId = raw.providerId;
      }

      // Sync email if alias was found by providerId and email changed
      if (raw.email !== existingAlias.email) {
        const safeEmail = await resolveEmailConflict(existingAlias.id, workspace.id, raw.providerType, raw.email);
        if (safeEmail) updateData.email = safeEmail;
      }

      if (existingAlias.contributorId) {
        await prisma.contributorAlias.update({ where: { id: existingAlias.id }, data: updateData });
        continue;
      }

      const match = await findContributorMatch(workspace.id, raw);
      if (match) {
        await prisma.contributorAlias.update({
          where: { id: existingAlias.id },
          data: {
            ...updateData,
            contributorId: match.id,
            resolveStatus: 'AUTO_MERGED',
            mergeReason: raw.providerId ? 'exact_provider_match' : 'exact_email_match',
            confidence: 1.0,
          },
        });
      } else {
        await prisma.contributorAlias.update({ where: { id: existingAlias.id }, data: updateData });
      }
    } else {
      const match = await findContributorMatch(workspace.id, raw);

      try {
        if (match) {
          await prisma.contributorAlias.create({
            data: {
              workspaceId: workspace.id,
              contributorId: match.id,
              providerType: raw.providerType,
              providerId: raw.providerId || null,
              email: raw.email,
              username: raw.username || null,
              resolveStatus: 'AUTO_MERGED',
              mergeReason: raw.providerId ? 'exact_provider_match' : 'exact_email_match',
              confidence: 1.0,
              lastSeenAt: new Date(),
            },
          });
        } else if (raw.source === 'primary') {
          // Primary aliases: create new canonical contributor
          const contributor = await prisma.contributor.create({
            data: { workspaceId: workspace.id, displayName: raw.displayName, primaryEmail: raw.email },
          });

          await prisma.contributorAlias.create({
            data: {
              workspaceId: workspace.id,
              contributorId: contributor.id,
              providerType: raw.providerType,
              providerId: raw.providerId || null,
              email: raw.email,
              username: raw.username || null,
              resolveStatus: 'AUTO_MERGED',
              mergeReason: 'exact_email_match',
              confidence: 1.0,
              lastSeenAt: new Date(),
            },
          });

          log.info({ contributorId: contributor.id, email: raw.email, orderId }, 'New contributor created');
        } else {
          // Merged-from aliases without a match: leave UNRESOLVED for identity queue
          await prisma.contributorAlias.create({
            data: {
              workspaceId: workspace.id,
              contributorId: null,
              providerType: raw.providerType,
              providerId: raw.providerId || null,
              email: raw.email,
              username: raw.username || null,
              resolveStatus: 'UNRESOLVED',
              lastSeenAt: new Date(),
            },
          });

          log.info({ email: raw.email, orderId }, 'Unresolved alias added to identity queue');
        }
      } catch (err: any) {
        if (err?.code === 'P2002') {
          log.warn({ email: raw.email, orderId }, 'Skipped duplicate alias (unique constraint)');
        } else {
          throw err;
        }
      }
    }
  }

  log.info({ orderId, aliasCount: rawAliases.length }, 'Contributor projection complete');
}

// ─── Backfill all completed orders ───

export async function backfillAllOrders(): Promise<{ usersProcessed: number; ordersProcessed: number }> {
  const users = await prisma.user.findMany({
    where: { orders: { some: { status: 'COMPLETED' } } },
    select: { id: true },
  });

  let ordersProcessed = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    log.info({ userId: user.id, progress: `${i + 1}/${users.length}` }, 'Processing user');

    await ensureWorkspaceForUser(user.id);

    const orders = await prisma.order.findMany({
      where: { userId: user.id, status: 'COMPLETED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    for (let j = 0; j < orders.length; j++) {
      log.info({ orderId: orders[j].id, progress: `order ${j + 1}/${orders.length}` }, 'Projecting order');
      await projectContributorsFromOrder(orders[j].id);
      ordersProcessed++;
    }
  }

  return { usersProcessed: users.length, ordersProcessed };
}
