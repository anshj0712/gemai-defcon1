import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme, type ThemePref } from './theme';

const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** One button that cycles System → Light → Dark; the tooltip says which is on and what comes next. */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const Icon = ICON[pref];
  const label = `Theme: ${LABEL[pref]}. Switch to ${LABEL[NEXT[pref]]}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={() => setPref(NEXT[pref])}>
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
