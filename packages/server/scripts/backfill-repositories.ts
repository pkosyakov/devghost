import prisma from '../src/lib/db';
import { backfillAllRepositories } from '../src/lib/services/repository-projector';

async function main() {
  console.log('Starting repository backfill...');
  console.log('');

  try {
    const result = await backfillAllRepositories();

    console.log('');
    console.log('Backfill complete!');
    console.log(`  Users processed: ${result.usersProcessed}`);
    console.log(`  Orders processed: ${result.ordersProcessed}`);
    console.log(`  Repos projected: ${result.reposProjected}`);

    // Summary counts
    const repoCount = await prisma.repository.count();
    const byProvider = await prisma.repository.groupBy({
      by: ['provider'],
      _count: { id: true },
    });

    console.log('');
    console.log('Results:');
    console.log(`  Total repositories: ${repoCount}`);
    for (const g of byProvider) {
      console.log(`  ${g.provider}: ${g._count.id}`);
    }
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
