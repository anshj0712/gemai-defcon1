import { useCallback, useEffect, useState } from 'react';
import type { ProbeDoc, ProbePreview, RecordedProbeSpec } from '@cp/schema';
import { GearSixIcon, EyeIcon, PlayIcon, PlusIcon, DetectiveIcon, UserIcon, XIcon } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { addProbe, ApiError, disableProbe, fetchProbes, previewProbe, type ProbesView, type ProbeStatsView } from './api';
import { Module } from './components/common';
import { ago, time } from './format';
import { probeValue } from './lib/probes';

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
      <p className="m-0 text-[13px]">
        Read on <b className="tabular-nums">{p.sessions_with_value}</b> of {p.sessions_scanned} recent sessions ({p.snapshots} snapshots), on {p.routes.join(', ')}. Values{' '}
        <b className="tabular-nums">
          {p.values ? (p.values.min === p.values.max ? probeValue(spec.name, p.values.min, spec.kind) : `${probeValue(spec.name, p.values.min, spec.kind)} – ${probeValue(spec.name, p.values.max, spec.kind)}`) : '–'}
        </b>
        {p.values && p.values.min !== p.values.max && <> (median {probeValue(spec.name, p.values.median, spec.kind)})</>}.
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

/** A table of probes: name (and selector), pages, the values seen, and how often. */
function ProbeTable({ rows, registry, onStop, busy }: { rows: ProbeStatsView[]; registry: Map<string, ProbeDoc>; onStop?: (name: string) => void; busy: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Probe</TableHead>
          <TableHead>Pages</TableHead>
          <TableHead>Values</TableHead>
          <TableHead className="text-right">Snapshots</TableHead>
          {onStop && <TableHead className="text-right">Status</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => {
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
              {onStop && (
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    {doc && <ProbeDocBadge d={doc} />}
                    {doc?.status === 'active' && (
                      <Button variant="outline" size="xs" disabled={busy} onClick={() => onStop(p.name)}>
                        Stop reading
                      </Button>
                    )}
                  </div>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Registered probes with no value read yet (or stopped): name, selector and status. */
function RegistryOnly({ docs }: { docs: ProbeDoc[] }) {
  if (docs.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
      {docs.map((d) => (
        <li key={d.name} className="flex flex-wrap items-center gap-2">
          <code>{d.name}</code>
          <span className="font-mono text-xs text-muted-foreground">{d.spec.selector}</span>
          <span className="text-xs text-muted-foreground">{d.spec.routes?.join(', ') ?? 'every page'}</span>
          <span className="text-xs text-muted-foreground">· {d.status === 'active' ? 'no value read yet' : 'not read'}</span>
          <ProbeDocBadge d={d} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Probes: the numbers rules compare, by where they come from. Probes the agent found and probes the merchant added
 * are separate modules; probes that come for free (site code and network requests) sit apart as automatic.
 */
export function ProbesPanel({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<ProbesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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
  const stop = (name: string) => void act(`off-${name}`, async () => (await disableProbe(name), await load(), onChanged?.()));

  if (loadError && !view) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load tracked numbers ({loadError}).</AlertDescription>
      </Alert>
    );
  }
  if (!view) return <Skeleton className="h-48 rounded-xl" aria-busy="true" aria-label="Loading probes" />;

  const registry = new Map(view.registry.map((d) => [d.name, d]));
  const recorded = view.catalog.probes.filter((p) => p.source === 'recorded');
  const bySource = (source: ProbeDoc['source']) => ({
    rows: recorded.filter((p) => registry.get(p.name)?.source === source),
    idle: view.registry.filter((d) => d.source === source && !recorded.some((p) => p.name === d.name)),
  });
  const agent = bySource('agent');
  const own = bySource('merchant');
  const declared = view.catalog.probes.filter((p) => p.source === 'declared');
  const requests = view.catalog.probes.filter((p) => p.source === 'request');
  const routes = view.catalog.routes;
  const canSave = preview !== null && preview.p.sessions_with_value > 0 && JSON.stringify(preview.spec) === JSON.stringify(cleanSpec());

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] text-muted-foreground">The numbers rules compare, read from the last {view.sessions} sessions. Recorded probes read the page shoppers saw, so they also work on sessions recorded before them.</p>

      <Module origin="agent" icon={DetectiveIcon} title="Found by the agent" count={agent.rows.length + agent.idle.length} description="Numbers on your pages the agent found shoppers leaving over, registered when you approved its rule.">
        {agent.rows.length + agent.idle.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">None yet. Approving an agent hypothesis that proposes a new probe registers it here.</p>
        ) : (
          <>
            {agent.rows.length > 0 && <ProbeTable rows={agent.rows} registry={registry} onStop={stop} busy={busy !== null} />}
            <RegistryOnly docs={agent.idle} />
          </>
        )}
      </Module>

      <Module
        origin="human"
        icon={UserIcon}
        title="Added by you"
        count={own.rows.length + own.idle.length}
        description="Numbers on your pages that you chose to track."
        action={
          <Button size="sm" variant={adding ? 'outline' : 'default'} onClick={() => setAdding(!adding)} aria-expanded={adding}>
            {adding ? <XIcon data-icon="inline-start" aria-hidden="true" /> : <PlusIcon data-icon="inline-start" aria-hidden="true" />}
            {adding ? 'Close' : 'Track a number'}
          </Button>
        }
      >
        {adding && (
          <div className="motion-reveal flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
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
                <FieldLabel htmlFor="probe-selector">Where on the page (CSS selector)</FieldLabel>
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
            <FieldDescription>Selectors: tag, #id, .class, [attr] or [attr="value"], and descendant or &gt; combinators. Nothing new is collected from shoppers.</FieldDescription>
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
                    setAdding(false);
                    await load();
                    onChanged?.();
                  })
                }
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
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
          </div>
        )}
        {own.rows.length + own.idle.length === 0 ? (
          !adding && <p className="m-0 text-[13px] text-muted-foreground">None yet. Point at a number the page shows, and a rule can use it at once.</p>
        ) : (
          <>
            {own.rows.length > 0 && <ProbeTable rows={own.rows} registry={registry} onStop={stop} busy={busy !== null} />}
            <RegistryOnly docs={own.idle} />
          </>
        )}
      </Module>

      <Module origin="system" icon={GearSixIcon} title="Automatic" count={declared.length + requests.length} description="Numbers every session reports without setup: the store's own probes, and every network call (how long it took, how it ended).">
        <Tabs defaultValue="declared">
          <TabsList>
            <TabsTrigger value="declared">
              In site code <span className="text-muted-foreground tabular-nums">{declared.length}</span>
            </TabsTrigger>
            <TabsTrigger value="request">
              Requests <span className="text-muted-foreground tabular-nums">{requests.length}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="declared" className="motion-reveal pt-2">
            {declared.length ? <ProbeTable rows={declared} registry={registry} busy={busy !== null} /> : <p className="m-0 text-[13px] text-muted-foreground">None seen in recent sessions.</p>}
          </TabsContent>
          <TabsContent value="request" className="motion-reveal pt-2">
            {requests.length ? <ProbeTable rows={requests} registry={registry} busy={busy !== null} /> : <p className="m-0 text-[13px] text-muted-foreground">None seen in recent sessions.</p>}
          </TabsContent>
        </Tabs>
      </Module>
    </div>
  );
}

function ProbeDocBadge({ d }: { d: ProbeDoc }) {
  return (
    <Badge
      className={d.status === 'active' ? 'bg-success-muted text-success' : 'bg-muted text-muted-foreground'}
      title={`v${d.version} · ${d.source === 'agent' ? 'proposed by the agent' : 'added by a merchant'} · approved by ${d.approved_by} ${ago(d.updated_at)}`}
    >
      {d.status === 'active' ? 'live' : 'stopped'}
    </Badge>
  );
}
