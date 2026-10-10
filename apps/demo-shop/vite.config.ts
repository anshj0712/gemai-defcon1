import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

/**
 * Synthetic store backend: a coupon check and a checkout endpoint, served by the Vite dev server.
 * All data is synthetic. Bug flags travel in the x-demo-bugs header.
 */
function mockApi(): Plugin {
  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}') as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    name: 'demo-shop-api',
    configureServer(server) {
      server.middlewares.use('/api/coupon', async (req, res) => {
        const { code } = await readJson(req);
        await wait(150);
        if (String(code ?? '').toUpperCase() === 'SAVE10') send(res, 200, { ok: true, percent: 10 });
        else send(res, 200, { ok: false, reason: 'unknown_code' });
      });
      server.middlewares.use('/api/checkout', async (req, res) => {
        const { region } = await readJson(req);
        const bugs = String(req.headers['x-demo-bugs'] ?? '');
        await wait(300);
        if (bugs.includes('checkout_error') && region === 'Northeast') send(res, 500, { ok: false, error: 'payment_gateway_unavailable' });
        else send(res, 200, { ok: true, order_id: `CP-${Math.floor(100000 + Math.random() * 900000)}` });
      });
    },
  };
}

export default defineConfig({
  plugins: [mockApi()],
  resolve: { conditions: ['source'] },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // Which bugs are live is set on the dashboard and kept by the API, so the shop asks it (no CORS).
    proxy: { '/v1/demo': 'http://127.0.0.1:8082' },
  },
});
