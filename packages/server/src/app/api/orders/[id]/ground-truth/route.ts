import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import { createGroundTruthSchema } from '@/lib/schemas';

const DEFAULT_GT_AUTHOR = 'unknown';
const MAX_AUTHOR_LENGTH = 64;

type GroundTruthEntryInput = {
  commitHash: string;
  hours: number;
  author?: string;
  repository?: string;
  notes?: string;
};

function normalizeAuthor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_AUTHOR_LENGTH) return null;
  return trimmed;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await getOrderWithAuth(id);
  if (!authResult.success) return orderAuthError(authResult);

  const entries = await prisma.groundTruth.findMany({
    where: { orderId: id },
    orderBy: [{ author: 'asc' }, { createdAt: 'asc' }],
    select: { commitHash: true, author: true, repository: true, hours: true, notes: true },
  });

  // Aggregate per-author stats
  const authorData = new Map<string, { hours: number[]; minCreatedAt: Date }>();
  for (const entry of entries) {
    const data = authorData.get(entry.author);
    if (data) {
      data.hours.push(entry.hours);
    } else {
      authorData.set(entry.author, { hours: [entry.hours], minCreatedAt: new Date() });
    }
  }

  // Get earliest createdAt per author from DB
  const createdAtByAuthor = await prisma.groundTruth.groupBy({
    by: ['author'],
    where: { orderId: id },
    _min: { createdAt: true },
  });
  const createdAtMap = new Map(createdAtByAuthor.map(r => [r.author, r._min.createdAt]));

  const authors = Array.from(authorData.entries())
    .map(([author, { hours }]) => {
      const sorted = [...hours].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const total = hours.reduce((a, b) => a + b, 0);
      return {
        author,
        count: hours.length,
        totalHours: Math.round(total * 10) / 10,
        meanHours: Math.round((total / hours.length) * 100) / 100,
        medianHours: Math.round(median * 100) / 100,
        createdAt: createdAtMap.get(author)?.toISOString() ?? null,
      };
    })
    .sort((a, b) => b.totalHours - a.totalHours || a.author.localeCompare(b.author));

  return NextResponse.json({ entries, authors });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await getOrderWithAuth(id);
  if (!authResult.success) return orderAuthError(authResult);

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createGroundTruthSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });
  }
  const { entries, author: rawAuthor } = parsed.data;
  const bodyAuthor = rawAuthor ?? null;

  // Validate
  const warnings: string[] = [];
  const valid: Array<Required<Pick<GroundTruthEntryInput, 'commitHash' | 'hours' | 'author'>> & Pick<GroundTruthEntryInput, 'repository' | 'notes'>> = [];
  const knownShas = new Set(
    (await prisma.commitAnalysis.findMany({
      where: { orderId: id, jobId: null },
      select: { commitHash: true },
      distinct: ['commitHash'],
    })).map(c => c.commitHash),
  );

  for (const entry of entries) {
    if (typeof entry.commitHash !== 'string' || !entry.commitHash.trim()) {
      return NextResponse.json({ error: 'Invalid commitHash: non-empty string required' }, { status: 400 });
    }
    const commitHash = entry.commitHash.trim();
    const normalizedEntryAuthor = normalizeAuthor(entry.author);
    if (entry.author !== undefined && !normalizedEntryAuthor) {
      return NextResponse.json(
        { error: `Invalid author for ${commitHash}: non-empty string up to ${MAX_AUTHOR_LENGTH} chars required` },
        { status: 400 },
      );
    }
    const author = normalizedEntryAuthor ?? bodyAuthor ?? DEFAULT_GT_AUTHOR;
    if (typeof entry.hours !== 'number' || entry.hours < 0) {
      return NextResponse.json({ error: `Invalid hours for ${commitHash}: must be >= 0` }, { status: 400 });
    }
    if (!knownShas.has(commitHash)) {
      return NextResponse.json({ error: `Unknown commitHash: ${commitHash}` }, { status: 400 });
    }
    if (entry.hours > 48) {
      warnings.push(`${commitHash} (${author}): unusually high estimate (${entry.hours}h)`);
    }
    valid.push({
      commitHash,
      hours: entry.hours,
      author,
      repository: entry.repository,
      notes: entry.notes,
    });
  }

  // Upsert in transaction for atomicity
  await prisma.$transaction(
    valid.map(entry =>
      prisma.groundTruth.upsert({
        where: {
          orderId_commitHash_author: {
            orderId: id,
            commitHash: entry.commitHash,
            author: entry.author,
          },
        },
        create: {
          orderId: id,
          commitHash: entry.commitHash,
          author: entry.author,
          repository: entry.repository,
          hours: entry.hours,
          notes: entry.notes,
        },
        update: {
          hours: entry.hours,
          repository: entry.repository,
          notes: entry.notes,
        },
      })
    )
  );

  return NextResponse.json({ upserted: valid.length, ...(warnings.length > 0 ? { warnings } : {}) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await getOrderWithAuth(id);
  if (!authResult.success) return orderAuthError(authResult);

  const author = normalizeAuthor(req.nextUrl.searchParams.get('author'));
  if (!author) {
    return NextResponse.json(
      { error: 'author query parameter required' },
      { status: 400 },
    );
  }

  const result = await prisma.groundTruth.deleteMany({
    where: { orderId: id, author },
  });

  return NextResponse.json({ deleted: result.count });
}
