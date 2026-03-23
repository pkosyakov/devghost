import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;    // $ per token
    completion: string; // $ per token
  };
  context_length: number;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

export const revalidate = 300; // 5 min cache

export async function GET() {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      return apiError(`OpenRouter API returned ${response.status}`, 502);
    }

    const json = (await response.json()) as OpenRouterResponse;

    const models = json.data
      .filter((m) => m.pricing?.prompt && m.pricing?.completion)
      .map((m) => ({
        id: m.id,
        name: m.name,
        inputPrice: parseFloat(m.pricing.prompt) * 1e6,   // $/token → $/M tokens
        outputPrice: parseFloat(m.pricing.completion) * 1e6,
        contextLength: m.context_length,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return apiResponse({ models });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch OpenRouter models');
    return apiError('Failed to fetch OpenRouter models', 502);
  }
}
