import { describe, expect, it } from 'vitest';
import { createModels, type ModelConfig } from '../src/llm/models.js';

const base: ModelConfig = { backend: 'auto', apiKey: undefined, bulkModel: 'bulk-model', reasoningModel: 'reasoning-model', project: undefined, location: 'asia-south1' };
const usesVertex = (m: unknown) => (m as { apiClient: { vertexai: boolean } }).apiClient.vertexai;

describe('createModels', () => {
  it('runs offline without credentials, and when asked to', () => {
    expect(createModels(base).offline).toBe(true);
    expect(createModels({ ...base, backend: 'offline', apiKey: 'k' }).offline).toBe(true);
  });

  it('auto with a key uses Gemini on the AI Studio endpoint', () => {
    const m = createModels({ ...base, apiKey: 'k' });
    expect(m.offline).toBe(false);
    expect(usesVertex(m.bulk)).toBe(false);
  });

  it('vertex with a key builds a Vertex client from the key, for both tiers', () => {
    const m = createModels({ ...base, backend: 'vertex', apiKey: 'AQ.test' });
    expect(m.offline).toBe(false);
    expect(usesVertex(m.bulk)).toBe(true);
    expect(usesVertex(m.reasoning)).toBe(true);
    expect(m.bulk.model).toBe('bulk-model');
    expect(m.reasoning.model).toBe('reasoning-model');
  });

  it('vertex needs a key or a project', () => {
    expect(() => createModels({ ...base, backend: 'vertex' })).toThrow(/GOOGLE_API_KEY.*GCP_PROJECT_ID/);
    expect(createModels({ ...base, backend: 'vertex', project: 'p' }).offline).toBe(false);
  });

  it('gemini needs a key', () => {
    expect(() => createModels({ ...base, backend: 'gemini' })).toThrow(/GOOGLE_API_KEY/);
  });
});
