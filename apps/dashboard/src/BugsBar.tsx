import { useEffect, useState } from 'react';
import { ToggleRightIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { fetchDemoBugs, putDemoBugs, type DemoBugsView } from './api';
import { CAUGHT, groupBugs } from './lib/bugs';


/** Agent-caught bugs in violet, rule-caught in blue, detectors neutral. */
const caughtClass = (c: string) =>
  c === 'agent' || c === 'agent_rule' ? 'bg-agent-muted text-agent' : c === 'builtin_rule' || c === 'merchant_rule' ? 'bg-info-muted text-info' : 'bg-muted text-muted-foreground';

/**
 * Which bugs are live in the synthetic demo shop: a status strip under the top bar, and a side sheet with a switch
 * for each, grouped by the churn reason it stands for. The shop follows within a couple of seconds. Hidden when
 * the API has no demo routes.
 */
export function BugsBar() {
  const [view, setView] = useState<DemoBugsView | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetchDemoBugs()
        .then((v) => !stop && (setView(v), setError(false)))
        .catch(() => !stop && setError(true));
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  if (!view) return null;

  const save = (next: string[]) => {
    setView({ ...view, bugs: next });
    putDemoBugs(next)
      .then(setView)
      .catch(() => setError(true));
  };
  const toggle = (id: string) => save(view.bugs.includes(id) ? view.bugs.filter((b) => b !== id) : [...view.bugs, id]);

  const live = view.known.filter((k) => view.bugs.includes(k.id));
  return (
    <div className={cn('border-b', live.length ? 'border-danger-border bg-danger-muted text-money' : 'bg-muted text-muted-foreground')}>
      <div className="mx-auto flex max-w-[1320px] items-center gap-3 px-6 py-1.5 text-[13px]">
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', live.length ? 'bg-destructive' : 'bg-muted-foreground/50')} />
        <span className="min-w-0 truncate font-medium" title={live.map((b) => b.label).join(', ')}>
          {live.length ? `${live.length} bug${live.length > 1 ? 's' : ''} live in the shop: ${live.map((b) => b.label).join(', ')}` : 'No bugs live in the shop'}
        </span>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="xs" className="ml-auto">
              <ToggleRightIcon data-icon="inline-start" aria-hidden="true" />
              Switch bugs
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[480px] sm:max-w-[480px]">
            <SheetHeader>
              <SheetTitle>Bugs in the demo shop</SheetTitle>
              <SheetDescription>Switch a bug on and the synthetic shop follows within about 2 seconds, for new clicks.</SheetDescription>
            </SheetHeader>
            <div className="flex gap-2 px-4">
              <Button size="sm" variant="outline" onClick={() => save(view.known.map((k) => k.id))}>
                All on
              </Button>
              <Button size="sm" variant="outline" onClick={() => save([])}>
                All off
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4">
              {groupBugs(view).map((g) => (
                <FieldSet key={g.reason}>
                  <FieldLegend variant="label">{g.label}</FieldLegend>
                  <FieldGroup className="gap-3">
                    {g.bugs.map((k) => (
                      <Field key={k.id} orientation="horizontal">
                        <Switch id={`bug-${k.id}`} checked={view.bugs.includes(k.id)} onCheckedChange={() => toggle(k.id)} />
                        <FieldContent>
                          <FieldLabel htmlFor={`bug-${k.id}`} className="flex-wrap">
                            {k.label}
                            {k.caught && (
                              <Badge className={caughtClass(k.caught)} title={k.caught_detail}>
                                {CAUGHT[k.caught] ?? k.caught}
                              </Badge>
                            )}
                          </FieldLabel>
                          <FieldDescription>{k.detail}</FieldDescription>
                        </FieldContent>
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              ))}
            </div>
            {error && (
              <Alert variant="destructive" className="mx-4 w-auto">
                <AlertDescription>Could not reach the API; the last state is shown.</AlertDescription>
              </Alert>
            )}
            <SheetFooter>
              <p className="m-0 text-xs text-muted-foreground">
                A shop tab opened with ?bugs= keeps its own setting. Not covered: competitor offers and discount-only shoppers are not page defects. All data is synthetic.
              </p>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
