/**
 * One-time migration: backfill availableStartDate / availableEndDate
 * for existing orders.
 *
 * Sources:
 *   - COMPLETED orders: MIN/MAX authorDate from CommitAnalysis
 *   - DEVELOPERS_LOADED / READY_FOR_ANALYSIS: selectedDevelopers JSONB
 *     (firstCommitAt / lastCommitAt fields)
 *
 * Usage:
 *   cd packages/server
 *   npx tsx prisma/backfill-available-dates.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SelectedDeveloper {
  firstCommitAt?: string;
  lastCommitAt?: string;
}

async function main() {
  // Find orders missing available dates
  const orders = await prisma.order.findMany({
    where: {
      availableStartDate: null,
      status: { in: ['DEVELOPERS_LOADED', 'READY_FOR_ANALYSIS', 'COMPLETED', 'FAILED'] },
    },
    select: {
      id: true,
      name: true,
      status: true,
      selectedDevelopers: true,
    },
  });

  console.log(`Found ${orders.length} orders to backfill`);

  let updated = 0;
  let skipped = 0;

  for (const order of orders) {
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    if (order.status === 'COMPLETED' || order.status === 'FAILED') {
      // Use CommitAnalysis records — most accurate
      const result = await prisma.commitAnalysis.aggregate({
        where: { orderId: order.id, jobId: null }, // original analysis only
        _min: { authorDate: true },
        _max: { authorDate: true },
      });
      minDate = result._min.authorDate;
      maxDate = result._max.authorDate;
    }

    // Fallback (or for non-COMPLETED): use selectedDevelopers JSONB
    if (!minDate || !maxDate) {
      const devs = order.selectedDevelopers as SelectedDeveloper[] | null;
      if (Array.isArray(devs)) {
        for (const dev of devs) {
          if (dev.firstCommitAt) {
            const d = new Date(dev.firstCommitAt);
            if (!isNaN(d.getTime()) && (!minDate || d < minDate)) minDate = d;
          }
          if (dev.lastCommitAt) {
            const d = new Date(dev.lastCommitAt);
            if (!isNaN(d.getTime()) && (!maxDate || d > maxDate)) maxDate = d;
          }
        }
      }
    }

    if (minDate && maxDate) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          availableStartDate: minDate,
          availableEndDate: maxDate,
        },
      });
      console.log(`  [OK] ${order.name} (${order.status}): ${minDate.toISOString().slice(0, 10)} — ${maxDate.toISOString().slice(0, 10)}`);
      updated++;
    } else {
      console.log(`  [SKIP] ${order.name} (${order.status}): no date data found`);
      skipped++;
    }
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
