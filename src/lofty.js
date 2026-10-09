import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Lofty exposes two unrelated APIs on the same host:
//
//   /prod      — the website's own backend. Currently serves three read
//                endpoints with no auth at all. Undocumented, and its terms
//                prohibit scraping, so treat it as a favour that can be
//                withdrawn: cache it, stay low-volume, and design so that
//                losing it is a config change rather than a rewrite.
//
//   /public/v1 — the official API, reached with a lofty_live_… key generated
//                in the dashboard. Requires a KYC'd account. This is the
//                sanctioned surface: using it is being a customer, not a
//                scraper. It is also the ONLY route to account-scoped data —
//                holdings, balance, trades — which /prod cannot provide.
//
// The SDK ships read-only and trading-enabled keys behind one credential. We
// only ever read, and we never send this key anywhere but api.lofty.ai.
const KEYCHAIN_SERVICE = 'workbench';
const KEYCHAIN_ACCOUNT = 'lofty-api-key';

const PROD = 'https://api.lofty.ai/prod';
const PUBLIC = 'https://api.lofty.ai/public/v1';

export async function getApiKey() {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null; // no entry — the user hasn't generated a key yet
  }
}

export async function saveApiKey(key) {
  if (!key?.trim()) throw new Error('key required');
  await execFileP('security', [
    'add-generic-password', '-U',
    '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE,
    '-w', key.trim(),
  ]);
}

// Presence only. Never log or return the key itself.
export async function apiKeyStatus() {
  const key = await getApiKey();
  if (!key) return { configured: false, scope: null };
  return { configured: true, scope: key.startsWith('lofty_test_') ? 'sandbox' : 'production' };
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function getJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Lofty ${res.status} ${url.replace('https://api.lofty.ai', '')}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- /prod: public market data, no key ----------

// The universe. ~3MB for 83 properties — callers must cache this.
export function fetchMarketplace(pageSize = 200) {
  return getJson(`${PROD}/properties/v2/marketplace?pageSize=${pageSize}`);
}

// Order-level depth. propertyId MUST be the ULID `id`:
// passing assetId or dao_app_id returns 200 with an empty book, which reads as
// "no bids" and is silently wrong. Callers should treat an empty book on a
// property that has traded as a fetch error, not a market fact.
export async function fetchOrderBook(ulid) {
  if (!/^01[A-Z0-9]{24}$/.test(ulid || '')) {
    throw new Error(`order book needs the property ULID, got "${ulid}" — assetId/dao_app_id silently return an empty book`);
  }
  return getJson(`${PROD}/exchange/v2/getpropertyorderbook?propertyId=${ulid}`);
}

// Full trade history plus lastPrice, tradeVolume, coc and capRate.
export async function fetchPropertyInfo(ulid) {
  if (!/^01[A-Z0-9]{24}$/.test(ulid || '')) {
    throw new Error(`property info needs the property ULID, got "${ulid}"`);
  }
  return getJson(`${PROD}/exchange/v2/getpropertyinfo?propertyId=${ulid}`);
}

// ---------- /public/v1: account data, key required ----------

// These are why a key is worth having: nothing on /prod exposes a specific
// account's holdings, so without this the portfolio tracker is manual entry.
async function publicGet(path) {
  const key = await getApiKey();
  if (!key) throw new Error('No Lofty API key — generate one in Settings → API Keys and store it with: security add-generic-password -U -a lofty-api-key -s workbench -w');
  return getJson(`${PUBLIC}${path}`, { headers: authHeaders(key) });
}

export const fetchPositions = () => publicGet('/account/positions');
export const fetchBalance = () => publicGet('/account/balance');
export const fetchAccountTrades = () => publicGet('/account/trades');
export const fetchLpPositions = () => publicGet('/account/lp-positions');
