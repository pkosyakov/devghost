import prisma from '@/lib/db';
import { apiResponse, requireUserSession, isErrorResponse } from '@/lib/api-utils';

// Average tokens per commit (2 LLM calls: classify + estimate)
const AVG_INPUT_TOKENS_PER_COMMIT = 4000;
const AVG_OUTPUT_TOKENS_PER_COMMIT = 600;

export async function GET() {
  const result = await requireUserSession();
  if (isErrorResponse(result)) return result;

  const settings = await prisma.systemSettings.findUnique({
    where: { id: 'singleton' },
  });

  const provider = settings?.llmProvider || 'ollama';

  const inputPrice = settings ? Number(settings.openrouterInputPrice) : 0.03;
  const outputPrice = settings ? Number(settings.openrouterOutputPrice) : 0.11;

  const costPerCommitUsd =
    provider === 'openrouter'
      ? (AVG_INPUT_TOKENS_PER_COMMIT / 1e6) * inputPrice +
        (AVG_OUTPUT_TOKENS_PER_COMMIT / 1e6) * outputPrice
      : 0;

  return apiResponse({
    provider,
    model:
      provider === 'openrouter'
        ? settings?.openrouterModel || 'qwen/qwen-2.5-coder-32b-instruct'
        : settings?.ollamaModel || 'qwen2.5-coder:32b',
    costPerCommitUsd,
  });
}
