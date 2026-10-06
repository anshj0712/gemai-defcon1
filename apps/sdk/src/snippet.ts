import { init, type CpClient } from './index.js';

/**
 * One-tag install. The bundle (bundle/cp-sdk.js) starts itself from its own script tag:
 *
 *   <script src="cp-sdk.js" data-site-key="pk_live_..." data-collector="https://collector.example"
 *           data-release="git:abc123" data-consent="pending"></script>
 *
 * The page then calls `window.cp.grantConsent()` from its consent banner.
 */
declare global {
  interface Window {
    cp?: CpClient;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
const d = script?.dataset;
if (d?.siteKey && d.collector) {
  window.cp = init({
    siteKey: d.siteKey,
    collectorUrl: d.collector,
    ...(d.release ? { release: d.release } : {}),
    consent: d.consent === 'granted' ? 'granted' : 'pending',
    ...(d.sampleRate ? { sampleRate: Number(d.sampleRate) } : {}),
  });
}
