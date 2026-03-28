/**
 * DevGhost — Prisma Seed Script
 *
 * Initializes SystemSettings singleton from env vars.
 * Idempotent: safe to run multiple times.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

async function main() {
  console.log('DevGhost seed: starting...');

  // Initialize SystemSettings singleton (LLM config + monetization defaults)
  const settings = await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
      demoLiveMode: false,
    },
    create: {
      id: 'singleton',
      llmProvider: process.env.LLM_PROVIDER || 'openrouter',
      ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
      ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:32b',
      openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
      openrouterModel: process.env.OPENROUTER_MODEL || 'qwen/qwen3-coder-next',
      openrouterProviderOrder: process.env.OPENROUTER_PROVIDER_ORDER || '',
      openrouterProviderIgnore: process.env.OPENROUTER_PROVIDER_IGNORE || '',
      openrouterAllowFallbacks: parseBool(process.env.OPENROUTER_ALLOW_FALLBACKS, true),
      openrouterRequireParameters: parseBool(process.env.OPENROUTER_REQUIRE_PARAMETERS, true),
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
      demoLiveMode: false,
    },
  });

  console.log(`  Initialized SystemSettings (provider: ${settings.llmProvider})`);

  // Seed Credit Packs (upsert by name for idempotency — stripePriceId may change between envs)
  const packs = [
    { name: 'Starter', credits: 500, priceUsd: 9.00, stripePriceId: process.env.STRIPE_PRICE_STARTER ?? '', sortOrder: 1 },
    { name: 'Pro', credits: 2000, priceUsd: 29.00, stripePriceId: process.env.STRIPE_PRICE_PRO ?? '', sortOrder: 2 },
    { name: 'Business', credits: 10000, priceUsd: 99.00, stripePriceId: process.env.STRIPE_PRICE_BUSINESS ?? '', sortOrder: 3 },
  ];

  for (const pack of packs) {
    await prisma.creditPack.upsert({
      where: { name: pack.name },
      update: { credits: pack.credits, priceUsd: pack.priceUsd, stripePriceId: pack.stripePriceId, sortOrder: pack.sortOrder },
      create: pack,
    });
  }

  console.log(`  Seeded ${packs.length} credit packs`);

  // Seed Subscriptions (upsert by name for idempotency — stripePriceId may change between envs)
  const subs = [
    { name: 'Monthly', creditsPerMonth: 1000, priceUsd: 9.00, stripePriceId: process.env.STRIPE_PRICE_SUB_MONTHLY ?? '', sortOrder: 1 },
    { name: 'Annual', creditsPerMonth: 4000, priceUsd: 29.00, stripePriceId: process.env.STRIPE_PRICE_SUB_ANNUAL ?? '', sortOrder: 2 },
  ];

  for (const sub of subs) {
    await prisma.subscription.upsert({
      where: { name: sub.name },
      update: { creditsPerMonth: sub.creditsPerMonth, priceUsd: sub.priceUsd, stripePriceId: sub.stripePriceId, sortOrder: sub.sortOrder },
      create: sub,
    });
  }

  console.log(`  Seeded ${subs.length} subscriptions`);

  // Partial unique index for idempotent CommitAnalysis upserts (Modal integration).
  // Prisma doesn't support partial indexes natively, so we apply via raw SQL.
  // IF NOT EXISTS makes this safe to run repeatedly.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "CommitAnalysis_orderId_commitHash_noJob_key"
    ON "CommitAnalysis" ("orderId", "commitHash")
    WHERE "jobId" IS NULL
  `);
  console.log('  Ensured partial unique index on CommitAnalysis');

  console.log('DevGhost seed: completed successfully!');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
