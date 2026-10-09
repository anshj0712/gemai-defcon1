import { Gemini, type BaseLlm } from '@google/adk';
import { OfflineLlm } from './offline.js';

/**
 * The two model tiers (AGENTS.md rule 7: ids come from config). `bulk` runs triage and the ranker;
 * `reasoning` runs root cause with the visual check. Without credentials both are the offline
 * stand-in, so the local demo runs end to end with no key.
 */
export interface ModelSet {
  bulk: BaseLlm;
  reasoning: BaseLlm;
  /** True when the offline stand-in is in use. */
  offline: boolean;
}

export interface ModelConfig {
  /** auto: Gemini when a key (or Vertex) is configured, else offline. */
  backend: 'auto' | 'gemini' | 'vertex' | 'offline';
  apiKey: string | undefined;
  bulkModel: string;
  reasoningModel: string;
  project: string | undefined;
  location: string;
}

export function createModels(cfg: ModelConfig): ModelSet {
  const backend = cfg.backend === 'auto' ? (cfg.apiKey ? 'gemini' : 'offline') : cfg.backend;
  if (backend === 'offline') {
    const m = new OfflineLlm();
    return { bulk: m, reasoning: m, offline: true };
  }
  if (backend === 'gemini' && !cfg.apiKey) throw new Error('AGENT_LLM=gemini needs GOOGLE_API_KEY');
  if (backend === 'vertex' && !cfg.project) throw new Error('AGENT_LLM=vertex needs GCP_PROJECT_ID');
  const make = (model: string) =>
    backend === 'vertex' ? new Gemini({ model, vertexai: true, project: cfg.project!, location: cfg.location }) : new Gemini({ model, apiKey: cfg.apiKey! });
  return { bulk: make(cfg.bulkModel), reasoning: make(cfg.reasoningModel), offline: false };
}
