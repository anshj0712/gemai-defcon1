import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'rrweb-player/dist/style.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
