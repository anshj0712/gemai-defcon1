import { NodeType } from '@rrweb/types';
import type { DomIndexEntry, NormalizerState } from '@cp/schema';

/**
 * A compact index of interactive elements, keyed by rrweb node id, plus aliases from descendants to
 * their nearest interactive ancestor (a click on a <span> inside a <button> resolves to the button).
 * It is carried across chunks because rrweb clicks reference node ids from an earlier snapshot.
 */

/** Attributes that shape selectors and interactivity. Everything else (values, text, href targets) is ignored. */
const KEPT_ATTRS = ['id', 'class', 'data-testid', 'data-test', 'data-cy', 'name', 'type', 'role', 'href', 'disabled', 'aria-disabled', 'onclick'];

const INTERACTIVE_TAGS = new Set(['button', 'select', 'summary']);
const INTERACTIVE_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image', 'checkbox', 'radio']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option']);

/** Past this many entries the oldest (lowest) node ids are dropped; rrweb ids only grow. */
export const MAX_INDEX_ENTRIES = 5000;

export function emptyState(): NormalizerState {
  return { nodes: {}, alias: {}, path: null, route: null };
}

type RawAttrs = Record<string, unknown>;

export function pickAttrs(raw: RawAttrs | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const k of KEPT_ATTRS) {
    const v = raw[k];
    if (v === undefined || v === null || v === false) continue;
    // href is only needed as a presence flag; never keep the URL.
    out[k] = k === 'href' ? '' : v === true ? '' : String(v);
  }
  return out;
}

export function isInteractive(tag: string, attrs: Record<string, string>): boolean {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'a' && 'href' in attrs) return true;
  if (tag === 'input' && INTERACTIVE_INPUT_TYPES.has((attrs.type ?? 'text').toLowerCase())) return true;
  if (attrs.role && INTERACTIVE_ROLES.has(attrs.role.toLowerCase())) return true;
  return 'onclick' in attrs;
}

export function isDisabled(attrs: Record<string, string>): boolean {
  return 'disabled' in attrs || attrs['aria-disabled'] === 'true';
}

const quote = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;

/** Node-local selector: tag, then id or test id, else name and up to three classes, then type and role. */
export function selectorFor(tag: string, attrs: Record<string, string>): string {
  let s = tag;
  const testAttr = ['data-testid', 'data-test', 'data-cy'].find((a) => attrs[a]);
  if (attrs.id) s += `#${attrs.id}`;
  if (testAttr) s += `[${testAttr}=${quote(attrs[testAttr] ?? '')}]`;
  if (!attrs.id && !testAttr) {
    if (attrs.name) s += `[name=${quote(attrs.name)}]`;
    const classes = (attrs.class ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
    for (const c of classes) s += `.${c}`;
  }
  if (tag === 'input' && attrs.type) s += `[type=${quote(attrs.type)}]`;
  if (attrs.role) s += `[role=${quote(attrs.role)}]`;
  return s;
}

export function makeEntry(tag: string, attrs: Record<string, string>): DomIndexEntry {
  return { selector: selectorFor(tag, attrs), tag, interactive: isInteractive(tag, attrs), disabled: isDisabled(attrs), attrs };
}

/** The interactive element a node belongs to, if any. */
export function resolveTarget(state: NormalizerState, nodeId: number): { id: number; entry: DomIndexEntry } | null {
  const direct = state.nodes[nodeId];
  if (direct) return { id: nodeId, entry: direct };
  const ancestor = state.alias[nodeId];
  if (ancestor === undefined) return null;
  const entry = state.nodes[ancestor];
  return entry ? { id: ancestor, entry } : null;
}

function ancestorOf(state: NormalizerState, parentId: number | null): number | null {
  if (parentId === null) return null;
  if (state.nodes[parentId]) return parentId;
  return state.alias[parentId] ?? null;
}

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: RawAttrs;
  childNodes?: SerializedNode[];
}

function isNode(v: unknown): v is SerializedNode {
  return typeof v === 'object' && v !== null && typeof (v as SerializedNode).id === 'number' && typeof (v as SerializedNode).type === 'number';
}

/** Index a serialized subtree whose parent resolves to `ancestor` (an interactive node id or null). */
export function indexSubtree(state: NormalizerState, root: unknown, ancestor: number | null): void {
  const stack: [unknown, number | null][] = [[root, ancestor]];
  while (stack.length > 0) {
    const [node, anc] = stack.pop()!;
    if (!isNode(node)) continue;
    let childAncestor = anc;
    if (node.type === NodeType.Element && node.tagName) {
      const tag = node.tagName.toLowerCase();
      const attrs = pickAttrs(node.attributes);
      if (isInteractive(tag, attrs)) {
        state.nodes[node.id] = makeEntry(tag, attrs);
        childAncestor = node.id;
      } else if (anc !== null) {
        state.alias[node.id] = anc;
      }
    }
    for (const child of node.childNodes ?? []) stack.push([child, childAncestor]);
  }
}

export interface MutationRecordLike {
  adds?: { parentId: number; node: unknown }[];
  removes?: { id: number }[];
  attributes?: { id: number; attributes: RawAttrs }[];
}

/** Apply one rrweb mutation record to the index. */
export function applyMutation(state: NormalizerState, m: MutationRecordLike): void {
  for (const r of m.removes ?? []) {
    delete state.nodes[r.id];
    delete state.alias[r.id];
  }
  // rrweb does not promise that a parent is listed before its children, so visit parents first.
  const adds = m.adds ?? [];
  const byId = new Map<number, (typeof adds)[number]>();
  for (const a of adds) if (isNode(a.node)) byId.set(a.node.id, a);
  const done = new Set<number>();
  const visit = (add: (typeof adds)[number], depth: number): void => {
    if (!isNode(add.node) || done.has(add.node.id)) return;
    done.add(add.node.id);
    const parentAdd = byId.get(add.parentId);
    if (parentAdd && depth < 256) visit(parentAdd, depth + 1);
    indexSubtree(state, add.node, ancestorOf(state, add.parentId));
  };
  for (const a of adds) visit(a, 0);

  for (const a of m.attributes ?? []) {
    const current = state.nodes[a.id];
    if (!current) continue;
    const attrs = { ...current.attrs };
    for (const [k, v] of Object.entries(a.attributes)) {
      if (!KEPT_ATTRS.includes(k)) continue;
      if (v === null || v === undefined || v === false) delete attrs[k];
      else attrs[k] = k === 'href' ? '' : v === true ? '' : typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    }
    const entry = makeEntry(current.tag, attrs);
    if (entry.interactive) state.nodes[a.id] = entry;
    else delete state.nodes[a.id];
  }
}

/** Bound the index size so long sessions with heavy DOM churn cannot grow it without limit. */
export function pruneState(state: NormalizerState, max = MAX_INDEX_ENTRIES): void {
  for (const map of [state.nodes, state.alias] as Record<string, unknown>[]) {
    const keys = Object.keys(map);
    if (keys.length <= max) continue;
    const ids = keys.map(Number).sort((a, b) => a - b);
    for (const id of ids.slice(0, ids.length - max)) delete map[id];
  }
}
