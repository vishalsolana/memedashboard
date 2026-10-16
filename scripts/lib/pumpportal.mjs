// PumpPortal free data feed: live pump.fun token creations and migrations.
// Docs: https://pumpportal.fun/data-api/real-time
// One connection, subscribed to both streams. No key needed.

export const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';
export const SUBSCRIBE = [{ method: 'subscribeNewToken' }, { method: 'subscribeMigration' }];

// -> { type: 'create' | 'bond', mint, signature, at, name, symbol }
//  | { type: 'info', text } for confirmations and errors, or null to ignore.
export function parseEvent(raw, nowSec) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  if (!msg.mint) {
    const text = msg.message ?? msg.error ?? msg.errors;
    return text ? { type: 'info', text: String(typeof text === 'string' ? text : JSON.stringify(text)) } : null;
  }
  const at = toSeconds(msg.timestamp) ?? nowSec;
  const base = { mint: msg.mint, signature: msg.signature ?? null, at, name: msg.name ?? null, symbol: msg.symbol ?? null };
  if (msg.txType === 'create') {
    // The new-token stream can include other launchpads; count pump.fun only.
    if (msg.pool && msg.pool !== 'pump') return null;
    return { type: 'create', ...base };
  }
  // We only subscribe to creations and migrations, so anything else with a mint
  // is a migration (txType "migrate" in current payloads).
  if (msg.txType && !/migrat/i.test(msg.txType)) return null;
  return { type: 'bond', ...base };
}

function toSeconds(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}
