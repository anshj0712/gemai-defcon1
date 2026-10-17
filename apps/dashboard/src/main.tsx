import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (fontsource), as the demo shop does: IBM Plex Sans for the UI, Plex Mono for selectors and ids.
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
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
