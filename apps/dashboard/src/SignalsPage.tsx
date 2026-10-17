import { useEffect, useState } from 'react';
import { ActivityIcon, PlayIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { fetchSignals, type SignalRowView } from './api';
import { PageHeader, SymptomChip } from './components/common';
import { time } from './format';

const DESCRIPTION = 'Every detector hit, newest first; each opens the replay at its moment. Refreshes every 5 s.';

/** Newest signals first; each row opens the session replay at that moment. Refreshes every 5 s. */
export function SignalsPage() {
  const [signals, setSignals] = useState<SignalRowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchSignals().then(
        (r) => alive && (setSignals(r.signals), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (error) {
    return (
      <>
        <PageHeader title="Signals" description={DESCRIPTION} />
        <Alert variant="destructive">
          <AlertTitle>Could not load signals</AlertTitle>
          <AlertDescription>
            {error}. Is the API running? Try <code>pnpm dev</code>.
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (!signals) {
    return (
      <>
        <PageHeader title="Signals" description={DESCRIPTION} />
        <Skeleton className="h-96 rounded-xl" aria-busy="true" aria-label="Loading signals" />
      </>
    );
  }
  if (signals.length === 0) {
    return (
      <>
        <PageHeader title="Signals" description={DESCRIPTION} />
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ActivityIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No signals yet</EmptyTitle>
            <EmptyDescription>
              Open the demo shop at <a href="http://localhost:5173/?bugs=dead_button">localhost:5173/?bugs=dead_button</a>, accept the banner, add something to the cart, and click <strong>Apply Coupon</strong> six or more times.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Signals" description={DESCRIPTION}>
        <span className="text-[13px] text-muted-foreground tabular-nums">{signals.length} shown · synthetic sessions</span>
      </PageHeader>
      <Card className="gap-0 py-1">
        <Table className="signals">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Time</TableHead>
              <TableHead>Symptom</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Element</TableHead>
              <TableHead>Session</TableHead>
              <TableHead>Release</TableHead>
              <TableHead className="pr-4 text-right">Replay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {signals.map((s) => (
              <TableRow key={s.signal_id}>
                <TableCell className="pl-4 tabular-nums">{time(s.event_time)}</TableCell>
                <TableCell title={s.detector}>
                  <SymptomChip detector={s.detector} />
                </TableCell>
                <TableCell className="font-mono text-xs">{s.route}</TableCell>
                <TableCell>
                  <code>{s.element_selector ?? '-'}</code>
                </TableCell>
                <TableCell>
                  <code>{s.session_id.slice(0, 14)}…</code>
                </TableCell>
                <TableCell className="text-muted-foreground">{s.release}</TableCell>
                <TableCell className="pr-4 text-right">
                  <a className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'no-underline')} href={`#/sessions/${s.session_id}?signal=${s.signal_id}`}>
                    <PlayIcon data-icon="inline-start" aria-hidden="true" />
                    Watch replay
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
