// The only file that knows route strings. Everything else asks by name.

async function request(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const getConfig = () => request('/api/config');
export const getAccount = (address) => request(`/api/account/${address}`);
export const getHistory = (address, since = 0) => request(`/api/history/${address}?since=${since}`);
export const getRange = (address) => request(`/api/range/${address}`);
export const getAgents = (address) => request(`/api/agents/${address}`);
export const getWallets = () => request('/api/wallets');
export const addWallet = (address) => request('/api/wallets', json({ address }));
export const deleteWallet = (address) => request(`/api/wallets/${address}`, { method: 'DELETE' });

export const getFills = (address, { limit, offset, closesOnly }) =>
  request(`/api/fills/${address}?limit=${limit}&offset=${offset}&closesOnly=${closesOnly}`);

export const backfill = (address, resume) => {
  const q = resume ? `?fillsFrom=${resume.fills}&fundingFrom=${resume.funding}` : '';
  return request(`/api/backfill/${address}${q}`, { method: 'POST' });
};

// Content-Disposition on the server makes this a download rather than a navigation.
export const exportUrl = (address, params) => `/api/export/${address}.csv?${params}`;
