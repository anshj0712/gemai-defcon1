import { DesktopIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTheme, type ThemePref } from './theme';

const OPTIONS: { value: ThemePref; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'Match my system', icon: DesktopIcon },
];

/** The theme as a small menu: the button shows what is on, the menu lists all three. */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const current = OPTIONS.find((o) => o.value === pref) ?? OPTIONS[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="text-topbar-muted hover:bg-topbar-active hover:text-topbar-foreground aria-expanded:bg-topbar-active aria-expanded:text-topbar-foreground dark:hover:bg-topbar-active" aria-label={`Theme: ${current.label}`}>
          <current.icon key={pref} aria-hidden="true" className="motion-pop" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
          {OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              <o.icon aria-hidden="true" />
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
