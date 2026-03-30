import prisma from '../src/lib/db';
import { backfillAllOrders } from '../src/lib/services/contributor-identity';

async function main() {
  console.log('Starting contributor backfill...');
  console.log('');

  try {
    const result = await backfillAllOrders();

    console.log('');
    console.log('Backfill complete!');
    console.log(`  Users processed: ${result.usersProcessed}`);
    console.log(`  Orders processed: ${result.ordersProcessed}`);

    // Summary counts
    const contributorCount = await prisma.contributor.count();
    const aliasCount = await prisma.contributorAlias.count();
    const unresolvedCount = await prisma.contributorAlias.count({
      where: { resolveStatus: 'UNRESOLVED' },
    });

    console.log('');
    console.log('Results:');
    console.log(`  Contributors: ${contributorCount}`);
    console.log(`  Aliases: ${aliasCount}`);
    console.log(`  Unresolved: ${unresolvedCount}`);
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
