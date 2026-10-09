// Lofty client. The load-bearing behaviour here is the ULID guard: the real
// API answers a wrong-but-plausible propertyId with HTTP 200 and an EMPTY
// order book, which reads as "nobody is bidding" and would silently poison
// every downstream analysis. Rejecting it loudly is the whole point.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOrderBook, fetchPropertyInfo, apiKeyStatus } from '../src/lofty.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ULID = '01K1VKTF50B18YPKEKKMNT988E';

test('order book requires the ULID, not a numeric or asset id', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };

  for (const bad of ['12345', '0x1f', ULID.slice(0, -1), 'asset-1', null, undefined, '']) {
    await assert.rejects(fetchOrderBook(bad), /ULID/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(called, false, 'a bad id must never reach the network — the empty-book answer looks valid');

  await fetchOrderBook(ULID); // the real one passes
  assert.equal(called, true);
});

test('property info applies the same guard', async () => {
  await assert.rejects(fetchPropertyInfo('dao_app_99'), /ULID/);
});

test('the guard explains the trap rather than just failing', async () => {
  // Whoever hits this error needs to know WHY, or they'll "fix" it by
  // passing the id they actually have.
  await assert.rejects(fetchOrderBook('12345'), /silently return an empty book/);
});

test('key status never exposes the key', async () => {
  const status = await apiKeyStatus();
  const serialized = JSON.stringify(status);
  assert.ok(!/lofty_live_|lofty_test_/.test(serialized), 'no key material in status');
  assert.equal(typeof status.configured, 'boolean');
});
