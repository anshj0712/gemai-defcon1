import { createHash } from 'node:crypto';
import { BaseLlm, InMemoryRunner, isFinalResponse, LlmAgent } from '@google/adk';
import type { Part } from '@google/genai';
import type { z } from 'zod';
import type { AgentRun } from '@cp/schema';

/**
 * Runs one ADK LlmAgent once over structured input and returns validated JSON (or null, failing
 * closed). The agent has no history (includeContents none), no transfers, and an output schema, so
 * Gemini answers in JSON matching the zod schema. Every output then passes the zod parse and the
 * caller's grounding validator; on rejection the agent is retried once with the validator's message.
 */

export interface AgentSpec<S extends z.ZodObject> {
  name: AgentRun['agent'];
  /** System instruction. Passed as a function so ADK does not treat braces as state placeholders. */
  instruction: string;
  schema: S;
}

export interface AgentInput {
  /** The user turn: the task and the evidence JSON. */
  text: string;
  image?: { mimeType: 'image/png' | 'image/jpeg'; data: Buffer };
}

export interface RunOptions {
  /** Validation attempts: the first try plus one retry with the validator's message. */
  maxAttempts?: number;
  /** Back-off retries for rate limits and transient model errors, per attempt. */
  maxBackoffRetries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunResult<T> {
  output: T | null;
  run: AgentRun;
}

export class ModelCallError extends Error {
  override name = 'ModelCallError';
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Hash of everything that determines the model's answer: model, instruction, input, and image. */
export function promptHash(model: string, instruction: string, input: AgentInput): string {
  return sha([model, instruction, input.text, input.image ? sha(input.image.data) : ''].join('\u0000')).slice(0, 16);
}

const RETRYABLE = /429|RESOURCE_EXHAUSTED|UNAVAILABLE|503|500|DEADLINE|ECONNRESET|ETIMEDOUT|fetch failed/i;

async function callOnce(spec: AgentSpec<z.ZodObject>, model: BaseLlm, input: AgentInput): Promise<string> {
  const agent = new LlmAgent({
    name: spec.name,
    model,
    instruction: () => spec.instruction,
    outputSchema: spec.schema,
    includeContents: 'none',
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    generateContentConfig: { temperature: 0 },
  });
  const runner = new InMemoryRunner({ agent, appName: 'churn-preventer' });
  const parts: Part[] = [{ text: input.text }];
  if (input.image) parts.push({ inlineData: { mimeType: input.image.mimeType, data: input.image.data.toString('base64') } });
  let text: string | null = null;
  for await (const event of runner.runEphemeral({ userId: 'agent-service', newMessage: { role: 'user', parts } })) {
    if (event.errorCode || event.errorMessage) {
      const msg = `${event.errorCode ?? 'error'}: ${event.errorMessage ?? ''}`.slice(0, 300);
      throw new ModelCallError(msg, RETRYABLE.test(msg));
    }
    if (isFinalResponse(event)) {
      const t = (event.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (t.trim() !== '') text = t;
    }
  }
  if (text === null) throw new ModelCallError('the model returned no text', true);
  return text;
}

/** Parse the model's JSON, tolerating a fenced code block around it. */
export function parseJsonText(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return JSON.parse(fenced?.[1] ?? text);
}

export async function runStructured<S extends z.ZodObject>(
  spec: AgentSpec<S>,
  model: BaseLlm,
  input: AgentInput,
  validate: (out: z.infer<S>) => string[],
  opts: RunOptions = {},
): Promise<RunResult<z.infer<S>>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const maxBackoff = opts.maxBackoffRetries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  const hash = promptHash(model.model, spec.instruction, input);
  let lastError = 'not run';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const turn: AgentInput =
      attempt === 1
        ? input
        : { ...input, text: `${input.text}\n\nYour previous answer was rejected by the validator: ${lastError}\nReturn corrected JSON that follows every rule.` };
    let text: string | null = null;
    for (let retry = 0; ; retry++) {
      try {
        text = await callOnce(spec as unknown as AgentSpec<z.ZodObject>, model, turn);
        break;
      } catch (err) {
        const retryable = err instanceof ModelCallError ? err.retryable : RETRYABLE.test(String(err));
        lastError = `model call failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
        if (!retryable || retry >= maxBackoff) break;
        await sleep((opts.backoffMs ?? 1000) * 2 ** retry);
      }
    }
    if (text === null) break; // a model failure is not a validation problem: do not burn the retry turn
    let parsed: unknown;
    try {
      parsed = parseJsonText(text);
    } catch {
      lastError = 'the answer was not valid JSON';
      continue;
    }
    const result = spec.schema.safeParse(parsed);
    if (!result.success) {
      lastError = `schema: ${result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`;
      continue;
    }
    const problems = validate(result.data);
    if (problems.length === 0) {
      return { output: result.data, run: { agent: spec.name, model: model.model, prompt_hash: hash, attempts, ok: true, error: null, ms: now() - started, at: started } };
    }
    lastError = problems.join('; ');
  }
  return { output: null, run: { agent: spec.name, model: model.model, prompt_hash: hash, attempts, ok: false, error: lastError.slice(0, 500), ms: now() - started, at: started } };
}
