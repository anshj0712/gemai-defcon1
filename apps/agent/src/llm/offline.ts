import { BaseLlm, type LlmRequest, type LlmResponse } from "@google/adk";
import type {
  JudgeOutput,
  JurorOutput,
  RankOutput,
  RootCauseOutput,
  TriageOutput,
} from "@cp/schema";
import { INPUT_MARKER } from "../agents/prompts.js";
import { offlineRuleAuthor, offlineRuleSuggester } from "./offline-rules.js";
import { offlineChurnAnalyst } from "./offline-watch.js";

/**
 * A deterministic stand-in for Gemini, used when no GOOGLE_API_KEY is configured (local demo, CI).
 * It is a real ADK model (BaseLlm), so the agents, schemas, validator, and pipeline run unchanged;
 * it composes grounded, templated answers from the evidence in the request and never looks at
 * images (its visual check is always not_checked). Findings record its model id, and the dashboard
 * labels the text as templated, so nothing it writes is mistaken for Gemini output.
 */
export const OFFLINE_MODEL_ID = "offline-stand-in";

interface Item {
  id: string;
  kind: string;
  text: string;
  data?: Record<string, string | number | boolean | null>;
}

interface Payload {
  evidence?: Item[];
  triage?: TriageOutput | null;
  base_rule_ids?: string[];
  rule_set?: { id: string }[];
  /** Jury turns. */
  role?: string;
  report?: {
    triage?: TriageOutput | null;
    revenue?: { status?: string };
  } | null;
  decision?: string;
  mean_score?: number;
  threshold?: number;
}

function readPayload(req: LlmRequest): Payload {
  const text = (req.contents.at(-1)?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  const at = text.indexOf(INPUT_MARKER);
  if (at < 0) return {};
  const json = text
    .slice(at + INPUT_MARKER.length)
    .split("\n\nYour previous answer")[0]!;
  try {
    return JSON.parse(json) as Payload;
  } catch {
    return {};
  }
}

const ids = (items: Item[], kind: string) =>
  items.filter((i) => i.kind === kind).map((i) => i.id);
const str = (v: unknown, fallback: string) =>
  typeof v === "string" && v !== "" ? v : fallback;
const num = (v: unknown) => (typeof v === "number" ? v : null);

function facts(p: Payload) {
  const items = p.evidence ?? [];
  const issue = items.find((i) => i.kind === "issue");
  const signals = items.filter((i) => i.kind === "signal");
  const errors = items.filter((i) => i.kind === "error");
  const impact = items.find((i) => i.kind === "impact");
  const shot = items.find((i) => i.kind === "screenshot");
  const d = issue?.data ?? {};
  const kind = str(d.kind, "element");
  const route = str(d.route, "the page");
  const anchor = str(d.anchor, "the control");
  const detectors = new Set(signals.map((s) => str(s.data?.detector, "")));
  const firstErr = errors[0]
    ? str(errors[0].data?.signature, "an error")
    : null;
  const issueId = issue?.id ?? items[0]?.id ?? "E1";
  return {
    items,
    issue,
    signals,
    errors,
    impact,
    shot,
    kind,
    route,
    anchor,
    detectors,
    firstErr,
    issueId,
  };
}

function triage(p: Payload): TriageOutput {
  const f = facts(p);
  const sigIds = ids(f.items, "signal").slice(0, 3);
  const errIds = ids(f.items, "error").slice(0, 2);
  const impactIds = f.impact ? [f.impact.id] : [];
  const cite = (...groups: string[][]) =>
    [...new Set([f.issueId, ...groups.flat()])].slice(0, 6);

  if (f.kind === "invariant") {
    const sig = f.signals[0]?.data ?? {};
    const rule = str(sig.rule_title, str(f.issue?.data?.anchor, "A data rule"));
    return {
      title: `${rule} on ${f.route}`.slice(0, 90),
      category: "pricing_error",
      confidence: 0.5,
      summary: {
        text: `Shoppers on ${f.route} see a total that breaks the rule "${rule}", with no error or frustration signal to warn anyone.`,
        evidence_ids: cite(sigIds.slice(0, 1), impactIds),
      },
      likely_cause: {
        text: "The displayed total is computed differently from the line items it should add up to, for example a line quantity or discount left out of the sum.",
        evidence_ids: cite(sigIds),
      },
      repro_steps: [
        {
          step: `Add products to the bag and open ${f.route}.`,
          evidence_ids: [f.issueId],
        },
        {
          step: "Change a line quantity or apply a discount, as the flagged sessions did.",
          evidence_ids: sigIds.slice(0, 2),
        },
        {
          step: "Compare the shown total with the sum of the line totals minus the discount.",
          evidence_ids: sigIds.slice(0, 1),
        },
      ],
    };
  }

  const v = f.signals[0]?.data ?? {};
  const clicks = num(
    f.signals.find((s) => s.data?.detector === "rage_click")?.data?.clicks,
  );
  const answered = num(
    f.signals.find((s) => s.data?.detector === "response_decay")?.data
      ?.answered_before,
  );
  const checkout = /checkout|payment/.test(f.route);
  if (f.firstErr) {
    return {
      title: `${f.anchor} fails with an error on ${f.route}`.slice(0, 90),
      category: checkout ? "checkout_blocker" : "error_spike",
      confidence: 0.5,
      summary: {
        text: `Pressing ${f.anchor} on ${f.route} throws "${f.firstErr}" and shoppers press it again and again${checkout ? " without being able to finish the order" : ""}.`,
        evidence_ids: cite(errIds, sigIds.slice(0, 1), impactIds),
      },
      likely_cause: {
        text: `The request or handler behind ${f.anchor} fails ("${f.firstErr}"), so the click has no visible effect.`,
        evidence_ids: cite(errIds, sigIds.slice(0, 1)),
      },
      repro_steps: [
        {
          step: `Fill the bag and go to ${f.route}.`,
          evidence_ids: [f.issueId],
        },
        {
          step: `Use the same inputs as the flagged sessions, then press ${f.anchor}${clicks ? ` (they pressed it ${clicks} times)` : ""}.`,
          evidence_ids: sigIds.slice(0, 2),
        },
        {
          step: `Watch the console and network panel for "${f.firstErr}".`,
          evidence_ids: errIds.slice(0, 1),
        },
      ],
    };
  }
  return {
    title: `${f.anchor} stops responding on ${f.route}`.slice(0, 90),
    category: "broken_control",
    confidence: 0.5,
    summary: {
      text: `Shoppers press ${f.anchor} on ${f.route} and nothing happens${answered ? ` after it worked ${answered} times` : ""}.`,
      evidence_ids: cite(sigIds, impactIds),
    },
    likely_cause: {
      text: `The click handler of ${f.anchor} stops doing anything${answered ? " after repeated use" : ""}: no DOM change, navigation, or request follows within ${num(v.window_ms) ?? 800} ms.`,
      evidence_ids: cite(sigIds),
    },
    repro_steps: [
      {
        step: `Open ${f.route} with items in the bag.`,
        evidence_ids: [f.issueId],
      },
      {
        step: `Press ${f.anchor}${answered ? ` more than ${answered} times, about a second apart` : ""}.`,
        evidence_ids: sigIds.slice(0, 2),
      },
      {
        step: "Check that the page, network panel, and console show no response to the later presses.",
        evidence_ids: sigIds.slice(0, 1),
      },
    ],
  };
}

function rootCause(p: Payload): RootCauseOutput {
  const f = facts(p);
  const t = p.triage;
  const sigIds = ids(f.items, "signal").slice(0, 3);
  return {
    hypothesis: t
      ? { text: t.likely_cause.text, evidence_ids: t.likely_cause.evidence_ids }
      : {
          text: `A defect in ${f.anchor} on ${f.route}.`,
          evidence_ids: [f.issueId, ...sigIds].slice(0, 4),
        },
    visual_check: "not_checked",
    visual_notes: {
      text: "The offline stand-in does not inspect images. Set GOOGLE_API_KEY to run the Gemini visual check.",
      evidence_ids: [f.shot?.id ?? f.issueId],
    },
    suggested_fix_area:
      f.kind === "invariant"
        ? `The total calculation behind ${f.anchor}`
        : `The click handler and request behind ${f.anchor} on ${f.route}`,
  };
}

function ranker(p: Payload): RankOutput {
  const f = facts(p);
  const known = new Set((p.rule_set ?? []).map((r) => r.id));
  const base = (p.base_rule_ids ?? []).filter((id) => known.has(id));
  const ruleIds = base.length ? base.slice(0, 3) : [...known].slice(0, 1);
  return {
    rule_ids: ruleIds,
    tier_move: "none",
    move_rule_id: "",
    reason: {
      text: `The deterministic match (${ruleIds.join(", ")}) fits the evidence; the offline stand-in proposes no move.`,
      evidence_ids: [f.issueId],
    },
  };
}

/** A juror's stand-in: a score from plain counts in the evidence, never from reading the report's words. */
function juror(p: Payload): JurorOutput {
  const f = facts(p);
  const cite = [f.issueId];
  const repro = p.report?.triage?.repro_steps?.length ?? 0;
  const byRole: Record<string, [number, string]> = {
    evidence_auditor: [
      0.85,
      "Every cited id was supplied and checked by code; the offline stand-in does not read the claims themselves.",
    ],
    skeptic: [
      Math.min(0.95, 0.6 + 0.06 * f.signals.length),
      `${f.signals.length} detector signal(s) back this issue; the offline stand-in cannot weigh innocent explanations.`,
    ],
    impact_analyst: [
      f.impact && p.report?.revenue?.status === "ok" ? 0.8 : 0.65,
      f.impact
        ? "An impact figure is in the evidence."
        : "No impact figure is in the evidence.",
    ],
    repro_reviewer: [
      Math.min(0.9, 0.5 + 0.1 * repro),
      `The report has ${repro} repro step(s).`,
    ],
  };
  const [score, text] = byRole[p.role ?? ""] ?? [0.5, "Unknown role."];
  return {
    score,
    rationale: { text: `Offline stand-in: ${text}`, evidence_ids: cite },
  };
}

function judge(p: Payload): JudgeOutput {
  const f = facts(p);
  const mean =
    typeof p.mean_score === "number" ? Math.round(p.mean_score * 100) : 0;
  return {
    ruling: {
      text: `Offline stand-in ruling: the report was ${p.decision ?? "decided"} with the jurors averaging ${mean}%. Set GOOGLE_API_KEY for a written ruling from Gemini.`,
      evidence_ids: [f.issueId],
    },
  };
}

export class OfflineLlm extends BaseLlm {
  constructor() {
    super({ model: OFFLINE_MODEL_ID });
  }

  override async *generateContentAsync(
    req: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const agent = String(req.config?.labels?.adk_agent_name ?? "");
    const payload = readPayload(req);
    const out =
      agent === "triage"
        ? triage(payload)
        : agent === "root_cause"
          ? rootCause(payload)
          : agent === "ranker"
            ? ranker(payload)
            : agent === "juror"
              ? juror(payload)
              : agent === "judge"
                ? judge(payload)
                : agent === "rule_author"
                  ? offlineRuleAuthor(
                      payload as Parameters<typeof offlineRuleAuthor>[0],
                    )
                  : agent === "rule_suggester"
                    ? offlineRuleSuggester(
                        payload as Parameters<typeof offlineRuleSuggester>[0],
                      )
                    : agent === "churn_analyst"
                      ? offlineChurnAnalyst(
                          payload as Parameters<typeof offlineChurnAnalyst>[0],
                        )
                      : null;
    if (!out) {
      yield {
        errorCode: "UNSUPPORTED",
        errorMessage: `offline stand-in has no answer for agent "${agent}"`,
      };
      return;
    }
    yield {
      content: { role: "model", parts: [{ text: JSON.stringify(out) }] },
    };
  }

  override connect(): never {
    throw new Error("the offline stand-in has no live mode");
  }
}
