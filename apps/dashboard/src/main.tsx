import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (fontsource): Geist for the UI, Geist Mono for selectors and ids, Newsreader for page titles.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/newsreader/opsz.css';
// Order matters: the player's CSS, then Tailwind and the tokens (layered), then the player overrides (unlayered).
import 'rrweb-player/dist/style.css';
import './index.css';
import './replay.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App';
import { ThemeProvider } from './theme';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
