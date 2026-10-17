import { useCallback, useEffect, useState } from 'react';
import type { ProbeDoc, ProbePreview, ProbeSource, RecordedProbeSpec } from '@cp/schema';
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { addProbe, ApiError, disableProbe, fetchProbes, previewProbe, type ProbesView, type ProbeStatsView } from './api';
import { SyntheticNote } from './components/common';
import { ago, time } from './format';
import { probeValue } from './lib/probes';

const SOURCE_LABEL: Record<ProbeSource, string> = { declared: 'In site code', request: 'Requests', recorded: 'Recorded' };
const SOURCE_HINT: Record<ProbeSource, string> = {
  declared: "Declared in the store's SDK setup: the browser reads the element and sends only the number.",
  request: 'Automatic: every network call, as how long it took (_ms) and how it ended (_status).',
  recorded: 'Read from the recorded page by a selector, added here or proposed by the agent. Nothing new leaves the browser, and it also reads sessions recorded before it existed.',
};

/** Examples for the demo shop (synthetic): two numbers the shop shows but never declared as probes. */
export const PROBE_EXAMPLES: { label: string; spec: RecordedProbeSpec }[] = [
  { label: 'Delivery fee at checkout', spec: { name: 'delivery_fee', selector: '#delivery-fee', routes: ['/checkout'], kind: 'money' } },
  { label: 'Delivery estimate (days)', spec: { name: 'delivery_days', selector: '#delivery-eta', routes: ['/product/:id'], kind: 'count' } },
];

/** Radix Select has no empty value: "every page" is this sentinel. */
const EVERY_PAGE = '__every_page__';

function range(p: ProbeStatsView, kind?: 'money' | 'count'): string {
  return p.min === p.max ? probeValue(p.name, p.min, kind) : `${probeValue(p.name, p.min, kind)} – ${probeValue(p.name, p.max, kind)}`;
}

const replayLink = (sessionId: string) => (
  <a className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'no-underline')} href={`#/sessions/${sessionId}`}>
    <PlayIcon data-icon="inline-start" aria-hidden="true" />
    Watch replay
  </a>
);

function PreviewBlock({ p, spec }: { p: ProbePreview; spec: RecordedProbeSpec }) {
  if (p.sessions_with_value === 0) {
    return (
      <Alert className="border-synthetic-border bg-synthetic-muted text-synthetic">
        <AlertTitle>It reads nothing yet.</AlertTitle>
        <AlertDescription className="text-synthetic">
          {spec.selector} matched no number in the last {p.sessions_scanned} sessions{spec.routes?.length ? ` on ${spec.routes.join(', ')}` : ''}. Check the selector and the page.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-3">
      <p className="m-0 flex flex-wrap items-center gap-1 text-[13px]">
        Read on <b className="tabular-nums">{p.sessions_with_value}</b> of {p.sessions_scanned} recent sessions ({p.snapshots} snapshots), on {p.routes.join(', ')}. Values{' '}
        <b className="tabular-nums">
          {p.values ? (p.values.min === p.values.max ? probeValue(spec.name, p.values.min, spec.kind) : `${probeValue(spec.name, p.values.min, spec.kind)} – ${probeValue(spec.name, p.values.max, spec.kind)}`) : '–'}
        </b>
        {p.values && p.values.min !== p.values.max && <> (median {probeValue(spec.name, p.values.median, spec.kind)})</>}. <SyntheticNote />
      </p>
      {p.samples.length > 0 && (
        <Table>
          <TableBody>
            {p.samples.map((s) => (
              <TableRow key={s.session_id}>
                <TableCell className="tabular-nums">{time(s.event_time)}</TableCell>
                <TableCell className="font-mono text-xs">{s.route}</TableCell>
                <TableCell className="tabular-nums">{probeValue(spec.name, s.value, spec.kind)}</TableCell>
                <TableCell className="text-right">{replayLink(s.session_id)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * Probes: every number the store's sessions report, by where it comes from, and a form to add a recorded probe
 * (a selector read from the recorded page). Rules compare probes; a new probe can be used by a rule at once.
 */
export function ProbesPanel({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<ProbesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<RecordedProbeSpec>({ name: '', selector: '', kind: 'money' });
  const [preview, setPreview] = useState<{ spec: RecordedProbeSpec; p: ProbePreview } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    () =>
      fetchProbes().then(
        (v) => {
          setView(v);
          setLoadError(null);
        },
        (e: Error) => setLoadError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  };

  const edit = (next: Partial<RecordedProbeSpec>) => {
    setSpec((s) => ({ ...s, ...next }));
    setPreview(null);
  };
  const cleanSpec = (): RecordedProbeSpec => ({ name: spec.name.trim(), selector: spec.selector.trim(), kind: spec.kind, ...(spec.routes?.length ? { routes: spec.routes } : {}) });

  const registry = new Map((view?.registry ?? []).map((d) => [d.name, d]));
  const groups: ProbeSource[] = ['declared', 'request', 'recorded'];
  const routes = view?.catalog.routes ?? [];
  const canSave = preview !== null && preview.p.sessions_with_value > 0 && JSON.stringify(preview.spec) === JSON.stringify(cleanSpec());

  return (
    <section className="mt-6 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="m-0 text-lg font-semibold tracking-tight">Probes</h2>
        <span className="text-[13px] text-muted-foreground">The numbers rules compare. {view ? `From the last ${view.sessions} sessions.` : ''}</span>
      </div>
      {loadError && !view && (
        <Alert variant="destructive">
          <AlertDescription>Could not load probes ({loadError}).</AlertDescription>
        </Alert>
      )}
      {view && (
        <Card className="gap-3 px-5">
          <Tabs defaultValue="declared">
            <TabsList>
              {groups.map((g) => (
                <TabsTrigger key={g} value={g}>
                  {SOURCE_LABEL[g]}
                  <span className="text-muted-foreground tabular-nums">{view.catalog.probes.filter((p) => p.source === g).length + (g === 'recorded' ? view.registry.filter((d) => !view.catalog.probes.some((p) => p.name === d.name)).length : 0)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {groups.map((g) => {
              const list = view.catalog.probes.filter((p) => p.source === g);
              const recordedOff = g === 'recorded' ? view.registry.filter((d) => !list.some((p) => p.name === d.name)) : [];
              return (
                <TabsContent key={g} value={g} className="flex flex-col gap-2 pt-2">
                  <p className="m-0 text-[13px] text-muted-foreground">{SOURCE_HINT[g]}</p>
                  {list.length === 0 && recordedOff.length === 0 ? (
                    <p className="m-0 text-[13px] text-muted-foreground">{g === 'recorded' ? 'None yet. Add one below, or approve one the agent proposes.' : 'None seen in recent sessions.'}</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Probe</TableHead>
                          <TableHead>Pages</TableHead>
                          <TableHead>Values</TableHead>
                          <TableHead className="text-right">Snapshots</TableHead>
                          {g === 'recorded' && <TableHead className="text-right">Status</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {list.map((p) => {
                          const doc = registry.get(p.name);
                          return (
                            <TableRow key={p.name}>
                              <TableCell>
                                <code>{p.name}</code>
                                {doc && <span className="ml-2 font-mono text-xs text-muted-foreground">{doc.spec.selector}</span>}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">{p.routes.join(', ')}</TableCell>
                              <TableCell className="tabular-nums">{range(p, doc?.spec.kind)}</TableCell>
                              <TableCell className="text-right text-muted-foreground tabular-nums">{p.snapshots}</TableCell>
                              {g === 'recorded' && (
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    {doc && <ProbeDocBadge d={doc} />}
                                    {doc?.status === 'active' && (
                                      <Button variant="outline" size="xs" disabled={busy !== null} onClick={() => void act(`off-${p.name}`, async () => (await disableProbe(p.name), await load(), onChanged?.()))}>
                                        Stop reading
                                      </Button>
                                    )}
                                  </div>
                                </TableCell>
                              )}
                            </TableRow>
                          );
                        })}
                        {recordedOff.map((d) => (
                          <TableRow key={d.name}>
                            <TableCell>
                              <code>{d.name}</code> <span className="ml-2 font-mono text-xs text-muted-foreground">{d.spec.selector}</span>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{d.spec.routes?.join(', ') ?? 'every page'}</TableCell>
                            <TableCell className="text-muted-foreground">{d.status === 'active' ? 'no value read yet' : 'not read'}</TableCell>
                            <TableCell />
                            <TableCell className="text-right">
                              <ProbeDocBadge d={d} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </Card>
      )}

      <Card className="gap-3 px-5">
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add a probe
            {open ? <ChevronUpIcon data-icon="inline-end" aria-hidden="true" /> : <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />}
          </Button>
          <span className="text-[13px] text-muted-foreground">Point at a number the page shows, and rules can use it at once.</span>
        </div>
        {open && (
          <>
            <p className="m-0 text-[13px] text-muted-foreground">
              It is read from the sessions already recorded (text was masked in the browser), so it works on past sessions too, and nothing new is collected from shoppers.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PROBE_EXAMPLES.map((ex) => (
                <Button key={ex.label} variant="outline" size="xs" onClick={() => edit(ex.spec)}>
                  {ex.label}: <code>{ex.spec.selector}</code>
                </Button>
              ))}
            </div>
            <FieldGroup className="grid gap-3 md:grid-cols-4">
              <Field>
                <FieldLabel htmlFor="probe-name">Name</FieldLabel>
                <Input id="probe-name" value={spec.name} onChange={(e) => edit({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="delivery_fee" maxLength={64} />
              </Field>
              <Field>
                <FieldLabel htmlFor="probe-selector">CSS selector</FieldLabel>
                <Input id="probe-selector" className="font-mono" value={spec.selector} onChange={(e) => edit({ selector: e.target.value })} placeholder="#delivery-fee" maxLength={200} />
              </Field>
              <Field>
                <FieldLabel htmlFor="probe-page">Page</FieldLabel>
                <Select value={spec.routes?.[0] ?? EVERY_PAGE} onValueChange={(v) => edit({ routes: v === EVERY_PAGE ? [] : [v] })}>
                  <SelectTrigger id="probe-page" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={EVERY_PAGE}>Every page</SelectItem>
                      {[...new Set([...routes, ...(spec.routes ?? [])])].map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="probe-kind">Kind</FieldLabel>
                <Select value={spec.kind} onValueChange={(v) => edit({ kind: v as RecordedProbeSpec['kind'] })}>
                  <SelectTrigger id="probe-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="money">Money</SelectItem>
                      <SelectItem value="count">Number (first whole number)</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <FieldDescription>Selectors: tag, #id, .class, [attr] or [attr="value"], and descendant or &gt; combinators.</FieldDescription>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy !== null || !spec.name || !spec.selector}
                onClick={() =>
                  void act('preview', async () => {
                    const s = cleanSpec();
                    setPreview({ spec: s, p: (await previewProbe(s)).preview });
                  })
                }
              >
                <EyeIcon data-icon="inline-start" aria-hidden="true" />
                {busy === 'preview' ? 'Reading recent sessions…' : 'Preview'}
              </Button>
              <Button
                disabled={busy !== null || !canSave}
                title={canSave ? undefined : 'Preview first: a probe must read something'}
                onClick={() =>
                  void act('save', async () => {
                    await addProbe(cleanSpec());
                    setPreview(null);
                    setSpec({ name: '', selector: '', kind: 'money' });
                    await load();
                    onChanged?.();
                  })
                }
              >
                {busy === 'save' ? 'Saving…' : 'Save probe'}
              </Button>
            </div>
            {preview && <PreviewBlock p={preview.p} spec={preview.spec} />}
            {error && (
              <Alert variant="destructive">
                <AlertTitle>That did not work.</AlertTitle>
                <AlertDescription>
                  <span>{error.message}</span>
                  {error instanceof ApiError && error.code === 'probe_reads_nothing' && <span>Open a replay of a session on that page to check the element.</span>}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

function ProbeDocBadge({ d }: { d: ProbeDoc }) {
  return (
    <Badge
      className={d.status === 'active' ? (d.source === 'agent' ? 'bg-agent-muted text-agent' : 'bg-success-muted text-success') : 'bg-muted text-muted-foreground'}
      title={`v${d.version} · ${d.source === 'agent' ? 'proposed by the agent' : 'added by a merchant'} · approved by ${d.approved_by} ${ago(d.updated_at)}`}
    >
      {d.status === 'active' ? (d.source === 'agent' ? 'agent · live' : 'live') : 'stopped'}
    </Badge>
  );
}
