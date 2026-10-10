import { Gemini, type BaseLlm } from '@google/adk';
import { GoogleGenAI } from '@google/genai';
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
  /** auto: Gemini (AI Studio key) when a key is configured, else offline. vertex: Vertex AI, with a Vertex key or service-account login. */
  backend: 'auto' | 'gemini' | 'vertex' | 'offline';
  apiKey: string | undefined;
  bulkModel: string;
  reasoningModel: string;
  project: string | undefined;
  location: string;
}

/**
 * Gemini on Vertex AI with an API key (Vertex "express mode", keys that start with `AQ.`). ADK's own Vertex
 * path only knows service-account credentials and never passes a key, and these keys are refused by the
 * AI Studio endpoint, so the client is built here. Everything else is ADK's Gemini.
 */
class VertexKeyGemini extends Gemini {
  private client?: Gemini['apiClient'];
  constructor(model: string, private readonly vertexKey: string) {
    super({ model, apiKey: vertexKey });
  }
  override get apiClient(): Gemini['apiClient'] {
    this.client ??= new GoogleGenAI({ vertexai: true, apiKey: this.vertexKey, httpOptions: this.getHttpOptions() }) as unknown as Gemini['apiClient'];
    return this.client;
  }
}

export function createModels(cfg: ModelConfig): ModelSet {
  const backend = cfg.backend === 'auto' ? (cfg.apiKey ? 'gemini' : 'offline') : cfg.backend;
  if (backend === 'offline') {
    const m = new OfflineLlm();
    return { bulk: m, reasoning: m, offline: true };
  }
  if (backend === 'gemini' && !cfg.apiKey) throw new Error('AGENT_LLM=gemini needs GOOGLE_API_KEY');
  if (backend === 'vertex' && !cfg.apiKey && !cfg.project) throw new Error('AGENT_LLM=vertex needs GOOGLE_API_KEY (Vertex key) or GCP_PROJECT_ID (service account)');
  const make = (model: string): BaseLlm => {
    if (backend !== 'vertex') return new Gemini({ model, apiKey: cfg.apiKey! });
    // A key wins when both are set: it is the explicit choice, and project-based login needs ADC on the host.
    return cfg.apiKey ? new VertexKeyGemini(model, cfg.apiKey) : new Gemini({ model, vertexai: true, project: cfg.project!, location: cfg.location });
  };
  return { bulk: make(cfg.bulkModel), reasoning: make(cfg.reasoningModel), offline: false };
}
