// Pooled inference: alias resolution, fallback when a provider fails, and the
// health that the ⚡ Providers panel reports. Every network call is mocked —
// these tests never leave the machine.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chat, providerHealth, resetHealth, PROVIDERS } from '../src/providers.js';

const realFetch = globalThis.fetch;
const KEY_VARS = Object.values(PROVIDERS).map((p) => p.env);

function okBody(content) {
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}
function resp(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let calls;

// routes: { providerNameOrUrlNeedle: status }
function mockFetch(routes, okContent = 'OK') {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, model: JSON.parse(opts.body || '{}').model });
    const hit = Object.entries(routes).find(([needle]) => String(url).includes(needle));
    const status = hit ? hit[1] : 200;
    return status === 200 ? resp(200, okBody(okContent)) : resp(status, { error: { message: 'boom' } });
  };
}

beforeEach(() => {
  resetHealth();
  calls = [];
  for (const key of KEY_VARS) delete process.env[key]; // no inherited env
  process.env.GROQ_API_KEY = 'gsk_test';
  process.env.OPENROUTER_API_KEY = 'or_test';
});
afterEach(() => { globalThis.fetch = realFetch; });

const msg = [{ role: 'user', content: 'hi' }];

test('free:smart tries the top tier first, with that provider\'s primary model', async () => {
  mockFetch({});
  const r = await chat(msg, { model: 'free:smart' });

  assert.equal(r.provider, 'groq', 'tier A beats tier B');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.groq\.com/);
  assert.equal(calls[0].model, PROVIDERS.groq.models[0]);
  assert.equal(r.text, 'OK');
  assert.equal(r.cost, 0, 'free tier prices at zero');
});

test('a 429 falls through to the next provider in the plan', async () => {
  mockFetch({ groq: 429 });
  const r = await chat(msg, { model: 'free:smart' });

  assert.equal(r.provider, 'openrouter');
  assert.deepEqual(calls.map((c) => c.url.includes('groq') ? 'groq' : 'other'), ['groq', 'other'],
    'groq is tried first, then the fallback');
});

test('a 404 for a retired model falls through instead of failing the call', async () => {
  // This is what happened live: groq/llama-3.3-70b-versatile 404s, and the
  // request must still succeed on a healthy provider.
  mockFetch({ groq: 404 });
  const r = await chat(msg, { model: 'free:smart' });

  assert.equal(r.provider, 'openrouter');
  assert.equal(r.text, 'OK');
});

test('three straight failures take the provider out of rotation', async () => {
  mockFetch({ groq: 500 });

  for (let i = 0; i < 4; i++) await chat(msg, { model: 'free:smart' });

  const groqCalls = calls.filter((c) => c.url.includes('groq')).length;
  assert.equal(groqCalls, 3, 'groq is attempted until it earns a 60s cooldown, then skipped');

  const groq = providerHealth().find((p) => p.provider === 'groq');
  assert.equal(groq.configured, true, 'the key is still present');
  assert.equal(groq.healthy, false, 'but the panel must not report it as healthy');
});

test('a success resets the failure counter', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, model: JSON.parse(opts.body || '{}').model });
    if (String(url).includes('groq')) {
      // fail, fail, succeed, fail, fail
      const groqCount = calls.filter((c) => c.url.includes('groq')).length;
      return groqCount === 3 ? resp(200, okBody('recovered')) : resp(500, {});
    }
    return resp(200, okBody('other'));
  };

  for (let i = 0; i < 5; i++) await chat(msg, { model: 'free:smart' });

  const groqCalls = calls.filter((c) => c.url.includes('groq')).length;
  assert.equal(groqCalls, 5,
    'the success at call 3 must clear the counter, or calls 4-5 would never be attempted');
});

test('an explicit provider/model keeps model ids that contain slashes', async () => {
  mockFetch({});
  const r = await chat(msg, { model: 'groq/openai/gpt-oss-120b' });

  assert.equal(r.provider, 'groq');
  assert.equal(calls[0].model, 'openai/gpt-oss-120b',
    'splitting on every slash would have requested model "openai"');
});

test('a bare model id containing a slash routes to a provider that serves it', async () => {
  mockFetch({});
  const r = await chat(msg, { model: PROVIDERS.groq.models[0] });

  assert.equal(r.provider, 'groq');
  assert.equal(calls[0].model, 'openai/gpt-oss-120b');
});

test('an unserved model says so instead of claiming no providers exist', async () => {
  mockFetch({});
  await assert.rejects(
    chat(msg, { model: 'totally-unknown-model' }),
    /No candidate for model.*Try "free:smart"/s
  );
});

test('an explicit provider/model that 404s reports the attempt, not an empty pool', async () => {
  mockFetch({ groq: 404 });
  await assert.rejects(
    chat(msg, { model: 'groq/definitely-not-a-model' }),
    /All providers failed: groq: 404/
  );
});

test('no configured providers fails with an actionable message', async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(chat(msg, { model: 'free:smart' }), /No providers configured.*\.env/s);
});

test('providerHealth distinguishes configured from healthy', async () => {
  mockFetch({ groq: 401 });
  for (let i = 0; i < 3; i++) await chat(msg, { model: 'free:smart' });

  const health = providerHealth();
  const groq = health.find((p) => p.provider === 'groq');
  const openrouter = health.find((p) => p.provider === 'openrouter');
  assert.equal(groq.configured, true);
  assert.equal(groq.healthy, false, '401s must not leave the panel green');
  assert.equal(openrouter.configured, true);
  assert.equal(openrouter.healthy, true);

  const unconfigured = health.find((p) => p.provider === 'cerebras');
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.healthy, false, 'no key means never healthy');
});
