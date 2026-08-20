import 'dotenv/config';

function clean(v) {
  return (v ?? '').trim();
}

export const config = {
  port: Number(clean(process.env.PORT)) || 3005,
  hlApiUrl: clean(process.env.HL_API_URL) || 'https://api.hyperliquid.xyz/info',
  hlWsUrl: clean(process.env.HL_WS_URL) || 'wss://api.hyperliquid.xyz/ws',
  defaultWallet: clean(process.env.DEFAULT_WALLET).toLowerCase(),
  dbPath: clean(process.env.DB_PATH) || './data/hyperliquid.db',
  snapshotMinIntervalMs: Number(clean(process.env.SNAPSHOT_MIN_INTERVAL_MS)) || 60000,
};
