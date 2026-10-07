import { LlmAgent } from '@google/adk';
import { loadDotEnv } from '@cp/platform';
import { TRIAGE } from './agents/prompts.js';
import { loadAgentConfig } from './config.js';
import { createModels } from './llm/models.js';

/**
 * ADK entry point: `rootAgent` is the triage agent, for `npx adk web` / `adk run` while working on
 * prompts. The service itself (src/index.ts) runs all three agents inside the deterministic pipeline.
 */
loadDotEnv();
const cfg = loadAgentConfig();
const models = createModels({
  backend: cfg.AGENT_LLM,
  apiKey: cfg.GOOGLE_API_KEY,
  bulkModel: cfg.GEMINI_MODEL_BULK,
  reasoningModel: cfg.GEMINI_MODEL_REASONING,
  project: process.env.GCP_PROJECT_ID,
  location: process.env.GCP_REGION ?? 'asia-south1',
});

export const rootAgent = new LlmAgent({
  name: TRIAGE.name,
  model: models.bulk,
  instruction: () => TRIAGE.instruction,
  outputSchema: TRIAGE.schema,
  includeContents: 'none',
});
