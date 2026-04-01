import { apiResponse, apiError, getOrderWithAuth } from '@/lib/api-utils';
import { getGhostMetricsService } from '@/lib/services/ghost-metrics-service';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getOrderWithAuth(id, {
    select: { id: true, userId: true, status: true },
  });

  if (!result.success) {
    return apiError(result.error, result.status);
  }

  const order = result.order as { id: string; userId: string; status: string };
  if (order.status !== 'COMPLETED') {
    return apiError('Order must be completed to recalculate FTE metrics', 400);
  }

  const service = getGhostMetricsService();
  const updated = await service.recalculateFteForOrder(id, order.userId);

  return apiResponse({ updated });
}
