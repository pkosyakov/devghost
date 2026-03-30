import { prisma } from '@/lib/db';
import { analysisLogger } from '@/lib/logger';
import { ensureWorkspaceForUser } from './workspace-service';

const log = analysisLogger.child({ service: 'repository-projector' });

// ─── Types ───

interface RawRepo {
  fullName: string;
  name: string;
  owner: string;
  provider: string;
  externalId?: string;
  url?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  language?: string;
  stars?: number;
  isPrivate?: boolean;
}

// ─── Extract repos from Order JSONB ───

export function extractReposFromOrder(order: {
  selectedRepos: unknown;
}): RawRepo[] {
  const repos: unknown[] = Array.isArray(order.selectedRepos)
    ? order.selectedRepos
    : [];

  const seen = new Map<string, RawRepo>();

  for (const raw of repos) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;

    const fullName = ((r.full_name || r.fullName || '') as string).trim();
    if (!fullName) continue;

    // Parse owner/name from full_name
    const parts = fullName.split('/');
    const owner = parts.length > 1 ? parts[0] : '';
    const name = parts.length > 1 ? parts.slice(1).join('/') : fullName;

    if (!seen.has(fullName.toLowerCase())) {
      seen.set(fullName.toLowerCase(), {
        fullName,
        name: (r.name as string) || name,
        owner: (typeof r.owner === 'string' ? r.owner
          : (r.owner && typeof r.owner === 'object' && 'login' in (r.owner as object))
            ? ((r.owner as { login: string }).login)
            : '') || owner,
        provider: 'github',
        externalId: r.id?.toString() || undefined,
        url: (r.url || r.html_url) as string | undefined,
        cloneUrl: (r.clone_url || r.cloneUrl) as string | undefined,
        defaultBranch: (r.default_branch || r.defaultBranch) as string | undefined,
        language: r.language as string | undefined,
        stars: typeof r.stars === 'number' ? r.stars
          : typeof r.stargazers_count === 'number' ? r.stargazers_count : undefined,
        isPrivate: typeof r.is_private === 'boolean' ? r.is_private
          : typeof r.private === 'boolean' ? r.private : undefined,
      });
    }
  }

  return Array.from(seen.values());
}

// ─── Project repositories from a single order ───

export async function projectRepositoriesFromOrder(orderId: string): Promise<number> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      selectedRepos: true,
      completedAt: true,
    },
  });

  if (!order) {
    log.warn({ orderId }, 'Order not found for repository projection');
    return 0;
  }

  const workspace = await ensureWorkspaceForUser(order.userId);
  const rawRepos = extractReposFromOrder(order);

  if (rawRepos.length === 0) {
    log.debug({ orderId }, 'No repos to project');
    return 0;
  }

  let projected = 0;

  for (const raw of rawRepos) {
    try {
      // Canonical counts — recomputed from all CommitAnalysis across all orders,
      // deduplicated by commitHash. contributorCount resolves through
      // ContributorAlias so merged aliases collapse into one contributor,
      // matching the detail endpoint's resolution logic exactly.
      const [canonicalStats] = await prisma.$queryRaw<[{
        totalCommits: number;
        contributorCount: number;
        lastCommitAt: Date | null;
      }]>`
        SELECT
          COUNT(DISTINCT ca."commitHash")::int AS "totalCommits",
          COUNT(DISTINCT COALESCE(cal."contributorId", ca."authorEmail"))::int AS "contributorCount",
          MAX(ca."authorDate") AS "lastCommitAt"
        FROM "CommitAnalysis" ca
        LEFT JOIN "ContributorAlias" cal
          ON cal."email" = ca."authorEmail"
          AND cal."workspaceId" = ${workspace.id}
          AND cal."contributorId" IS NOT NULL
        WHERE ca."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ${order.userId})
        AND ca."repository" = ${raw.fullName}
      `;

      const existing = await prisma.repository.findUnique({
        where: {
          workspaceId_provider_fullName: {
            workspaceId: workspace.id,
            provider: raw.provider,
            fullName: raw.fullName,
          },
        },
        select: { lastAnalyzedAt: true },
      });

      if (existing) {
        await prisma.repository.update({
          where: {
            workspaceId_provider_fullName: {
              workspaceId: workspace.id,
              provider: raw.provider,
              fullName: raw.fullName,
            },
          },
          data: {
            // Always refresh metadata
            name: raw.name,
            owner: raw.owner,
            externalId: raw.externalId ?? undefined,
            url: raw.url ?? undefined,
            cloneUrl: raw.cloneUrl ?? undefined,
            defaultBranch: raw.defaultBranch ?? undefined,
            language: raw.language ?? undefined,
            stars: raw.stars ?? undefined,
            isPrivate: raw.isPrivate ?? undefined,
            // Canonical counts — always overwrite with recomputed values
            totalCommits: canonicalStats?.totalCommits ?? 0,
            contributorCount: canonicalStats?.contributorCount ?? 0,
            lastCommitAt: canonicalStats?.lastCommitAt ?? null,
            // Only advance lastAnalyzedAt forward (never regress)
            ...(order.completedAt && (!existing.lastAnalyzedAt || order.completedAt > existing.lastAnalyzedAt)
              ? { lastAnalyzedAt: order.completedAt } : {}),
          },
        });
      } else {
        await prisma.repository.create({
          data: {
            workspaceId: workspace.id,
            provider: raw.provider,
            fullName: raw.fullName,
            name: raw.name,
            owner: raw.owner,
            externalId: raw.externalId || null,
            url: raw.url || null,
            cloneUrl: raw.cloneUrl || null,
            defaultBranch: raw.defaultBranch || 'main',
            language: raw.language || null,
            stars: raw.stars ?? 0,
            isPrivate: raw.isPrivate ?? false,
            lastAnalyzedAt: order.completedAt,
            lastCommitAt: canonicalStats?.lastCommitAt ?? null,
            totalCommits: canonicalStats?.totalCommits ?? 0,
            contributorCount: canonicalStats?.contributorCount ?? 0,
          },
        });
      }
      projected++;
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr?.code === 'P2002') {
        log.warn({ fullName: raw.fullName, orderId }, 'Skipped duplicate repository');
      } else {
        throw err;
      }
    }
  }

  log.info({ orderId, projected, total: rawRepos.length }, 'Repository projection complete');
  return projected;
}

// ─── Backfill all completed orders ───

export async function backfillAllRepositories(): Promise<{
  usersProcessed: number;
  ordersProcessed: number;
  reposProjected: number;
}> {
  const users = await prisma.user.findMany({
    where: { orders: { some: { status: 'COMPLETED' } } },
    select: { id: true },
  });

  let ordersProcessed = 0;
  let reposProjected = 0;

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
      log.info({ orderId: orders[j].id, progress: `order ${j + 1}/${orders.length}` }, 'Projecting repositories');
      const count = await projectRepositoriesFromOrder(orders[j].id);
      reposProjected += count;
      ordersProcessed++;
    }
  }

  return { usersProcessed: users.length, ordersProcessed, reposProjected };
}
