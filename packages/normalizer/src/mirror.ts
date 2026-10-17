import { NodeType } from '@rrweb/types';
import { parseProbeValue, type MirrorNode, type MirrorState, type ProbeKind, type RecordedProbeSpec } from '@cp/schema';

/**
 * A compact copy of the recorded page, rebuilt from rrweb's full snapshot and mutations, so recorded probes
 * (a CSS selector registered after the fact) can be read from sessions server-side: live in the processor
 * and retroactively in re-scans. It holds only what the recording already holds (text was masked in the
 * browser and scrubbed again at the collector), and only the parts a selector needs: tags, structural
 * attributes, text that has a digit, and the tree. Pure and JSON-serializable, so it is carried across chunks in
 * the session tail.
 */

/** Past this many nodes, additions are dropped (and `truncated` is set); demo pages hold a few hundred. */
export const MAX_MIRROR_NODES = 4000;
/** Text kept per text node. Probe values are short. */
export const MAX_TEXT = 80;
/** Subtrees kept as one opaque node: nothing a probe reads lives in them, and they are large. */
const SKIPPED_TAGS = new Set(['svg', 'script', 'style', 'noscript', 'iframe', 'canvas', 'video', 'audio', 'template', 'head', 'picture']);
/** Structure only. rrweb does not mask attributes, so free-text ones (aria-label, title, alt) are never kept. */
const KEPT_ATTRS = new Set(['id', 'class', 'name', 'role', 'type', 'hidden']);
const MAX_ATTRS = 12;
const MAX_ATTR_VALUE = 64;
/** An attribute value that could be an email or a long number (an account or phone) is dropped, not kept. */
const UNSAFE_VALUE = /@|\d{8,}/;

export function emptyMirror(): MirrorState {
  return { n: {}, root: null, size: 0 };
}

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
  textContent?: string;
}

const isNode = (v: unknown): v is SerializedNode => typeof v === 'object' && v !== null && typeof (v as SerializedNode).id === 'number' && typeof (v as SerializedNode).type === 'number';

function keptAttrs(raw: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_ATTRS) break;
    if (!(KEPT_ATTRS.has(k) || k.startsWith('data-'))) continue;
    if (v === null || v === undefined || v === false) continue;
    const value = (v === true ? '' : String(v)).slice(0, MAX_ATTR_VALUE);
    if (UNSAFE_VALUE.test(value)) continue;
    out[k] = value;
    n += 1;
  }
  return n > 0 ? out : undefined;
}

/**
 * Text kept for a text node: only text with a digit (numbers are all a probe reads), capped. Words never reach the
 * session tail, so the mirror holds no more of the page than its numbers and its structure.
 */
const capText = (s: string | null | undefined) => {
  const t = (s ?? '').slice(0, MAX_TEXT);
  return /\d/.test(t) ? t : '';
};

function removeSubtree(m: MirrorState, id: number): void {
  const node = m.n[id];
  if (!node) return;
  if (node.p !== null) {
    const parent = m.n[node.p];
    if (parent?.c) parent.c = parent.c.filter((c) => c !== id);
  }
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const n = m.n[cur];
    if (!n) continue;
    for (const c of n.c ?? []) stack.push(c);
    delete m.n[cur];
    m.size -= 1;
  }
  if (m.root === id) m.root = null;
}

/** Add a serialized subtree under `parentId` (null: a new document), placed before `beforeId` when given. */
function addSubtree(m: MirrorState, root: SerializedNode, parentId: number | null, beforeId: number | null): void {
  if (m.n[root.id]) removeSubtree(m, root.id);
  const stack: [SerializedNode, number | null][] = [[root, parentId]];
  let first = true;
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    let entry: MirrorNode | null = null;
    if (node.type === NodeType.Document) entry = { p: parent, t: '#document', c: [] };
    else if (node.type === NodeType.Element && node.tagName) {
      const tag = node.tagName.toLowerCase();
      const a = keptAttrs(node.attributes);
      entry = SKIPPED_TAGS.has(tag) ? { p: parent, t: tag, ...(a ? { a } : {}), s: 1 } : { p: parent, t: tag, ...(a ? { a } : {}), c: [] };
    } else if (node.type === NodeType.Text) entry = { p: parent, t: '#text', x: capText(node.textContent) };
    // Doctype, CDATA and comments carry nothing a probe reads.
    if (!entry) {
      first = false;
      continue;
    }
    if (m.size >= MAX_MIRROR_NODES) {
      m.truncated = true;
      return;
    }
    m.n[node.id] = entry;
    m.size += 1;
    if (parent !== null) {
      const p = m.n[parent];
      if (p?.c) {
        const at = first && beforeId !== null ? p.c.indexOf(beforeId) : -1;
        if (at >= 0) p.c.splice(at, 0, node.id);
        else p.c.push(node.id);
      }
    }
    first = false;
    if (entry.c) {
      // Children in document order: pushed in reverse so the first one is added (and appended) first.
      const kids = (node.childNodes ?? []).filter(isNode);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, node.id]);
    }
  }
}

/** A full snapshot starts a new document. */
export function mirrorSnapshot(node: unknown): MirrorState {
  const m = emptyMirror();
  if (!isNode(node)) return m;
  addSubtree(m, node, null, null);
  m.root = node.id;
  return m;
}

interface AddRecord {
  parentId: number;
  nextId?: number | null;
  node: unknown;
}

export interface MirrorMutation {
  adds?: AddRecord[];
  removes?: { id: number }[];
  texts?: { id: number; value: string | null }[];
  attributes?: { id: number; attributes: Record<string, unknown> }[];
}

/**
 * Apply one rrweb mutation record. As in rrweb's replayer, an add whose parent or next sibling is itself
 * still waiting in the same record is retried until it can be placed; what never can is appended (order
 * only matters for multi-value probes) or dropped (no parent).
 */
export function applyMirrorMutation(m: MirrorState, data: MirrorMutation): void {
  for (const r of data.removes ?? []) removeSubtree(m, r.id);

  let pending = (data.adds ?? []).filter((a) => isNode(a.node));
  const waiting = () => new Set(pending.map((a) => (a.node as SerializedNode).id));
  for (let pass = 0; pending.length > 0 && pass < 64; pass++) {
    const ids = waiting();
    const next: AddRecord[] = [];
    for (const add of pending) {
      const parent = m.n[add.parentId];
      if (!parent) {
        if (ids.has(add.parentId)) next.push(add);
        continue;
      }
      if (parent.s || !parent.c) continue; // inside a subtree the mirror does not keep
      const nextId = add.nextId ?? null;
      if (nextId !== null && !m.n[nextId] && ids.has(nextId)) {
        next.push(add);
        continue;
      }
      addSubtree(m, add.node as SerializedNode, add.parentId, nextId);
    }
    if (next.length === pending.length) {
      for (const add of next) {
        const parent = m.n[add.parentId];
        if (parent?.c && !parent.s) addSubtree(m, add.node as SerializedNode, add.parentId, null);
      }
      break;
    }
    pending = next;
  }

  for (const t of data.texts ?? []) {
    const node = m.n[t.id];
    if (node && node.t === '#text') node.x = capText(t.value);
  }
  for (const a of data.attributes ?? []) {
    const node = m.n[a.id];
    if (!node || node.t.startsWith('#')) continue;
    const attrs = { ...node.a };
    for (const [k, v] of Object.entries(a.attributes)) {
      if (!(KEPT_ATTRS.has(k) || k.startsWith('data-'))) continue;
      const value = v === null || v === undefined || v === false ? null : (v === true ? '' : String(v)).slice(0, MAX_ATTR_VALUE);
      if (value === null || UNSAFE_VALUE.test(value)) delete attrs[k];
      else attrs[k] = value;
    }
    if (Object.keys(attrs).length > 0) node.a = attrs;
    else delete node.a;
  }
}

// ---------------------------------------------------------------------------------------------
// Selectors: a small CSS subset (tag, #id, .class, [attr], [attr="v"], [attr^= *= $= "v"], descendant
// and child combinators). Anything else (pseudo-classes, lists, sibling combinators) is refused.
// ---------------------------------------------------------------------------------------------

interface AttrTest {
  name: string;
  op: 'exists' | '=' | '^=' | '*=' | '$=';
  value: string;
}
interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: AttrTest[];
}
export interface CompiledSelector {
  parts: Compound[];
  /** combinators[i] joins parts[i] and parts[i + 1]. */
  combinators: ('desc' | 'child')[];
}

const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*/;
const ATTR = /^\s*([A-Za-z_][A-Za-z0-9_:-]*)\s*(?:([\^*$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+)))?\s*$/;

export function compileSelector(selector: string): CompiledSelector | null {
  const s = selector.trim();
  if (!s || s.length > 200) return null;
  let i = 0;
  const parts: Compound[] = [];
  const combinators: ('desc' | 'child')[] = [];
  const ident = () => {
    const m = IDENT.exec(s.slice(i));
    if (!m) return '';
    i += m[0].length;
    return m[0];
  };
  for (;;) {
    const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
    let any = false;
    if (s[i] === '*') {
      i += 1;
      any = true;
    } else {
      const tag = ident();
      if (tag) {
        c.tag = tag.toLowerCase();
        any = true;
      }
    }
    for (;;) {
      const ch = s[i];
      if (ch === '#' || ch === '.') {
        i += 1;
        const v = ident();
        if (!v) return null;
        if (ch === '#') c.id = v;
        else c.classes.push(v);
        any = true;
      } else if (ch === '[') {
        const end = s.indexOf(']', i);
        if (end < 0) return null;
        const m = ATTR.exec(s.slice(i + 1, end));
        if (!m) return null;
        c.attrs.push({ name: m[1]!.toLowerCase(), op: (m[2] as AttrTest['op'] | undefined) ?? 'exists', value: m[3] ?? m[4] ?? m[5] ?? '' });
        i = end + 1;
        any = true;
      } else break;
    }
    if (!any) return null;
    parts.push(c);
    const ws = /^\s+/.exec(s.slice(i));
    if (ws) i += ws[0].length;
    if (i >= s.length) break;
    if (s[i] === '>') {
      i += 1;
      const ws2 = /^\s+/.exec(s.slice(i));
      if (ws2) i += ws2[0].length;
      combinators.push('child');
    } else if (ws) combinators.push('desc');
    else return null;
  }
  return { parts, combinators };
}

function matchCompound(node: MirrorNode, c: Compound): boolean {
  if (node.t.startsWith('#')) return false;
  if (c.tag && node.t !== c.tag) return false;
  const a = node.a ?? {};
  if (c.id !== null && a.id !== c.id) return false;
  if (c.classes.length > 0) {
    const cls = (a.class ?? '').split(/\s+/);
    if (!c.classes.every((x) => cls.includes(x))) return false;
  }
  for (const t of c.attrs) {
    const v = a[t.name];
    if (v === undefined) return false;
    if (t.op === '=' && v !== t.value) return false;
    if (t.op === '^=' && !v.startsWith(t.value)) return false;
    if (t.op === '*=' && !v.includes(t.value)) return false;
    if (t.op === '$=' && !v.endsWith(t.value)) return false;
  }
  return true;
}

function matchUp(m: MirrorState, parentId: number | null, k: number, sel: CompiledSelector): boolean {
  if (k < 0) return true;
  if (sel.combinators[k] === 'child') {
    const p = parentId !== null ? m.n[parentId] : undefined;
    return !!p && matchCompound(p, sel.parts[k]!) && matchUp(m, p.p, k - 1, sel);
  }
  for (let cur = parentId; cur !== null; ) {
    const p = m.n[cur];
    if (!p) return false;
    if (matchCompound(p, sel.parts[k]!) && matchUp(m, p.p, k - 1, sel)) return true;
    cur = p.p;
  }
  return false;
}

function matches(m: MirrorState, id: number, sel: CompiledSelector): boolean {
  const node = m.n[id];
  const last = sel.parts.length - 1;
  return !!node && matchCompound(node, sel.parts[last]!) && matchUp(m, node.p, last - 1, sel);
}

/** Element ids matching the selector, in document order (at most `limit`). */
export function queryMirror(m: MirrorState, sel: CompiledSelector, limit = 100): number[] {
  const out: number[] = [];
  if (m.root === null) return out;
  const stack = [m.root];
  while (stack.length > 0 && out.length < limit) {
    const id = stack.pop()!;
    const node = m.n[id];
    if (!node) continue;
    if (!node.t.startsWith('#') && matches(m, id, sel)) out.push(id);
    const kids = node.c ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

/** The text under a node, in document order, up to `limit` characters. */
export function textOf(m: MirrorState, id: number, limit = 200): string {
  let out = '';
  const stack = [id];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop()!;
    const node = m.n[cur];
    if (!node) continue;
    if (node.t === '#text') out += node.x ?? '';
    const kids = node.c ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out.slice(0, limit).replace(/\s+/g, ' ').trim();
}

const selectorCache = new Map<string, CompiledSelector | null>();
function compiled(selector: string): CompiledSelector | null {
  let c = selectorCache.get(selector);
  if (c === undefined) {
    c = compileSelector(selector);
    if (selectorCache.size > 500) selectorCache.clear();
    selectorCache.set(selector, c);
  }
  return c;
}

const MAX_VALUES = 100;

/** Read recorded probes on the current page. Probes limited to other routes, or matching nothing, are left out. */
export function readRecordedProbes(m: MirrorState, specs: readonly RecordedProbeSpec[], route: string | null): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  for (const spec of specs) {
    if (spec.routes && spec.routes.length > 0 && !(route && spec.routes.includes(route))) continue;
    const sel = compiled(spec.selector);
    if (!sel) continue;
    const list: number[] = [];
    for (const id of queryMirror(m, sel, MAX_VALUES)) {
      const v = parseProbeValue(textOf(m, id, 120), spec.kind);
      if (v !== null) list.push(v);
    }
    if (list.length > 0) values[spec.name] = list;
  }
  return values;
}

// ---------------------------------------------------------------------------------------------
// Discovery: numbers on the recorded page nobody probes yet (the churn watcher's candidates).
// ---------------------------------------------------------------------------------------------

/** Never a candidate: controls and form parts (their numbers are sizes, quantities typed, or labels). */
const NOT_CANDIDATE_INSIDE = new Set(['button', 'select', 'option', 'textarea', 'input', 'label', 'a']);
const UNSTABLE_CLASS = /^(on|off|active|selected|open|closed|hidden|show|visible|disabled|loading|focus|is-.+|has-.+)$|\d{3,}/;
const GENERATED_ID = /\d{3,}|[0-9a-f]{8,}/i;

export interface NumericCandidate {
  selector: string;
  kind: ProbeKind;
  /** One value per matching element, in document order. */
  values: number[];
}

const q = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;

/** A stable selector for one element: id, a test or probe attribute, or tag and classes; null when nothing is stable. */
function ownSelector(node: MirrorNode): string | null {
  const a = node.a ?? {};
  if (a.id && !GENERATED_ID.test(a.id) && IDENT.test(a.id)) return `${node.t}#${a.id}`;
  for (const k of ['data-testid', 'data-cp-probe', 'data-test']) if (a[k]) return `${node.t}[${k}=${q(a[k])}]`;
  const classes = (a.class ?? '')
    .split(/\s+/)
    .filter((c) => c && IDENT.test(c) && !UNSTABLE_CLASS.test(c))
    .slice(0, 2);
  return classes.length > 0 ? `${node.t}.${classes.join('.')}` : null;
}

/**
 * Elements whose own text is a short number ("₹499", "Arrives in 9–12 days"), deepest first: an element is a
 * candidate when its text has a digit, is at most 40 characters, and no child element's text has a digit.
 * Money when the text shows a currency, else a count (the first whole number).
 */
export function numericCandidates(m: MirrorState, limit = 150): NumericCandidate[] {
  if (m.root === null) return [];
  // Post-order: each node's text length and whether it (or a child element) holds a digit.
  const info = new Map<number, { len: number; digit: boolean; childDigit: boolean }>();
  const order: number[] = [];
  const stack = [m.root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = m.n[id];
    if (!node) continue;
    order.push(id);
    // Pre-order, in document order: children pushed in reverse so the first is visited first.
    const kids = node.c ?? [];
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const node = m.n[id]!;
    if (node.t === '#text') {
      const x = node.x ?? '';
      info.set(id, { len: x.trim().length, digit: /\d/.test(x), childDigit: false });
      continue;
    }
    let len = 0;
    let digit = false;
    let childDigit = false;
    for (const c of node.c ?? []) {
      const ci = info.get(c);
      if (!ci) continue;
      len += ci.len;
      digit ||= ci.digit;
      if (ci.digit && !m.n[c]!.t.startsWith('#')) childDigit = true;
    }
    info.set(id, { len, digit, childDigit });
  }
  const out: NumericCandidate[] = [];
  const bySelector = new Map<string, NumericCandidate>();
  for (const id of order) {
    if (out.length >= limit) break;
    const node = m.n[id]!;
    if (node.t.startsWith('#') || node.s) continue;
    const i = info.get(id);
    if (!i || !i.digit || i.childDigit || i.len > 40) continue;
    // A declared probe (the SDK already reports it) is not a new number, whatever selector would name it.
    if (node.a && 'data-cp-probe' in node.a) continue;
    // Not inside a control, and not hidden.
    let skip = false;
    for (let cur: number | null = id; cur !== null; cur = m.n[cur]?.p ?? null) {
      const n = m.n[cur];
      if (!n) break;
      if (NOT_CANDIDATE_INSIDE.has(n.t) || (n.a && 'hidden' in n.a)) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    let selector = ownSelector(node);
    if (!selector) {
      // An anonymous element under an anchored parent: "#order-summary span".
      const parent = node.p !== null ? m.n[node.p] : undefined;
      const anchor = parent && parent.a?.id && !GENERATED_ID.test(parent.a.id) ? `#${parent.a.id}` : null;
      if (!anchor) continue;
      selector = `${anchor} > ${node.t}`;
    }
    const text = textOf(m, id, 60);
    const existing = bySelector.get(selector);
    const kind: ProbeKind = existing?.kind ?? (/[₹$€£]|\brs\.?\s?\d|\binr\b/i.test(text) ? 'money' : 'count');
    const value = parseProbeValue(text, kind);
    if (value === null) continue;
    if (existing) {
      if (existing.values.length < 100) existing.values.push(value);
      continue;
    }
    const candidate: NumericCandidate = { selector, kind, values: [value] };
    bySelector.set(selector, candidate);
    out.push(candidate);
  }
  return out;
}
