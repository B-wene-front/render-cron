import { VoyageAIClient } from 'voyageai';

const voyageApiKey = process.env.VOYAGEAI_API_KEY;
const voyageModel = process.env.VOYAGEAI_EMBEDDING_MODEL;

if (!voyageApiKey) {
  throw new Error('Missing required environment variable: VOYAGEAI_API_KEY or VOYAGE_API_KEY');
}

export const voyageai = new VoyageAIClient({ apiKey: voyageApiKey });
export const VOYAGEAI_MODEL = voyageModel;

