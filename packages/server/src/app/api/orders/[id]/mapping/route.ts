import { NextRequest } from 'next/server';
import { apiResponse, apiError, parseBody, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import prisma from '@/lib/db';
import { mappingSchema } from '@/lib/schemas';
import { analysisLogger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth(id);
    if (!result.success) {
      return orderAuthError(result);
    }

    const parsed = await parseBody(request, mappingSchema);
    if (!parsed.success) return parsed.error;
    const { developerMapping, excludedDevelopers } = parsed.data;

    const { order } = result;

    // Update the order with the new mapping and excluded developers
    // Only advance status if currently at DEVELOPERS_LOADED
    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        developerMapping,
        excludedDevelopers,
        ...(order.status === 'DEVELOPERS_LOADED' ? { status: 'READY_FOR_ANALYSIS' as const } : {}),
      },
    });

    return apiResponse(updatedOrder);
  } catch (error) {
    analysisLogger.error({ err: error }, 'Save mapping error');
    return apiError('Failed to save mapping', 500);
  }
}
