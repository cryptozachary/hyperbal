import express from 'express';
import { config } from './config.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));
  app.use(express.static('public'));
  return app;
}

// Start only when run directly (not when imported by tests).
if (process.argv[1]?.endsWith('server.js')) {
  const app = createApp();
  app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));
}
