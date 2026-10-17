import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme, type ThemePref } from './theme';

const NEXT: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' };
const LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** One button that cycles Light → Dark → System; the tooltip says which is on and what comes next. */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const Icon = ICON[pref];
  const label = `Theme: ${LABEL[pref]}. Switch to ${LABEL[NEXT[pref]]}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="text-topbar-muted hover:bg-topbar-active hover:text-topbar-foreground dark:hover:bg-topbar-active" aria-label={label} onClick={() => setPref(NEXT[pref])}>
          <Icon key={pref} aria-hidden="true" className="motion-pop" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
