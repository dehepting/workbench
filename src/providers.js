// Pooled free-tier inference router.
//
// All providers speak the OpenAI chat-completions protocol, so routing is just:
//   1. resolve the requested model alias to an ordered list of provider candidates
//   2. try each one; on 429/402/5xx, mark it unhealthy and fall through to the next
//   3. track rolling latency + failure counts so smart/fast/cheap aliases actually mean something
//
// Keys come from environment variables (or .env via src/env.js). They are never
// stored in the DB, logged, or exposed through the API — only provider *health* is.

export const PROVIDERS = {
  groq: {
    base: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', tier: 'A',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-30b-a3b-thinking-2507'],
  },
  cerebras: {
    base: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', tier: 'A',
    models: ['qwen3-235b', 'gpt-oss-120b', 'llama-3.3-70b'],
  },
  google: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GOOGLE_API_KEY', tier: 'A',
    models: ['gemini-2.5-flash', 'gemma-3-27b-it'],
  },
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY', tier: 'A',
    models: ['nvidia/llama-3.3-nemotron-70b-ffp', 'deepseek-ai/deepseek-r1-0528'],
  },
  mistral: {
    base: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', tier: 'A',
    models: ['mistral-small-latest', 'codestral-latest'],
  },
  openrouter: {
    base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', tier: 'B',
    models: ['openrouter/free'],
  },
  zai: {
    base: 'https://api.z.ai/api/paas/v1', env: 'ZAI_API_KEY', tier: 'B',
    models: ['glm-4.5', 'glm-4.5-air'],
  },
  dashscope: {
    base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY', tier: 'B',
    models: ['qwen3-235b-a22b', 'qwen-plus'],
  },
  deepinfra: {
    base: 'https://api.deepinfra.com/v1/openai', env: 'DEEPINFRA_API_KEY', tier: 'B',
    models: ['deepseek-ai/deepseek-v3', 'meta-llama/Llama-3.3-70B-Instruct'],
  },
  sambanova: {
    base: 'https://api.sambanova.ai/v1', env: 'SAMBANOVA_API_KEY', tier: 'B',
    models: ['Meta-Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-R1'],
  },
  together: {
    base: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY', tier: 'C',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  },
  fireworks: {
    base: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY', tier: 'C',
    models: ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
  },
  siliconflow: {
    base: 'https://api.siliconflow.cn/v1', env: 'SILICONFLOW_API_KEY', tier: 'C',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  hyperbolic: {
    base: 'https://api.hyperbolic.ai/v1', env: 'HYPERBOLIC_API_KEY', tier: 'C',
    models: ['deepseek-ai/deepseek-v3', 'meta-llama/Meta-Llama-3.1-70B-Instruct'],
  },
  perplexity: {
    base: 'https://api.perplexity.ai', env: 'PERPLEXITY_API_KEY', tier: 'C',
    models: ['sonar'],
  },
};

// $ per 1M tokens [input, output] — used to estimate ledger cost.
// Shared with src/board.js so both paths price a model the same way.
export const PRICES = {
  groq: [0, 0], cerebras: [0, 0], google: [0, 0], nvidia: [0, 0], mistral: [0, 0],
  openrouter: [0, 0], zai: [0, 0], sambanova: [0, 0],
  deepinfra: [0.03, 0.05], dashscope: [0.4, 1.2], together: [0.88, 0.88],
  fireworks: [0.9, 0.9], siliconflow: [0.14, 0.14], hyperbolic: [0.4, 0.8], perplexity: [1, 1],
};
export const DEFAULT_PRICE = [0.15, 0.6];

// Rolling health per provider.
const health = {}; // { provider: { fails, avgLatency, lastFailAt } }

function keyOf(p) { return process.env[p.env] || null; }

function healthOf(name) {
  return health[name] ||= { fails: 0, avgLatency: null, lastFailAt: 0 };
}

function isSick(name) {
  const h = healthOf(name);
  return h.fails >= 3 && Date.now() - h.lastFailAt < 60_000; // 60s cooldown after 3 straight fails
}

function markFail(name) {
  const h = healthOf(name);
  h.fails += 1;
  h.lastFailAt = Date.now();
}

function markOk(name, latencyMs) {
  const h = healthOf(name);
  h.fails = 0;
  h.avgLatency = h.avgLatency == null ? latencyMs : Math.round(h.avgLatency * 0.8 + latencyMs * 0.2);
}

function configured() {
  return Object.entries(PROVIDERS)
    .filter(([name, p]) => keyOf(p) && !isSick(name))
    .map(([name, p]) => ({ name, base: p.base, apiKey: keyOf(p), models: p.models, tier: p.tier }));
}

// Resolve a model request to an ordered candidate list.
function resolveCandidates(model = 'free:smart') {
  const pool = configured();
  if (!pool.length) return [];

  // Explicit "provider/model" — go straight there.
  const slash = model.includes('/') && !model.startsWith('free:') ? model.split('/') : null;
  if (slash && PROVIDERS[slash[0]] && keyOf(PROVIDERS[slash[0]])) {
    const p = PROVIDERS[slash[0]];
    return [{ name: slash[0], base: p.base, apiKey: keyOf(p), models: [slash[1]], tier: p.tier, modelId: slash[1] }];
  }

  // Explicit bare model name — every provider that serves it.
  if (!model.startsWith('free:')) {
    const serving = pool.filter(p => p.models.includes(model));
    return serving.map(p => ({ ...p, modelId: model }));
  }

  // Aliases.
  const byLatency = [...pool].sort((a, b) => (healthOf(a.name).avgLatency ?? 1e9) - (healthOf(b.name).avgLatency ?? 1e9));
  switch (model) {
    case 'free:fast':
      return byLatency.map(p => ({ ...p, modelId: p.models[0] }));
    case 'free:cheap': {
      const byFails = [...pool].sort((a, b) => healthOf(a.name).fails - healthOf(b.name).fails);
      return byFails.map(p => ({ ...p, modelId: p.models[p.models.length - 1] }));
    }
    case 'free:a': { // top tier only
      const a = pool.filter(p => p.tier === 'A');
      return (a.length ? a : pool).sort((x, y) => x.tier.localeCompare(y.tier)).map(p => ({ ...p, modelId: p.models[0] }));
    }
    case 'free:s': { // second tier
      const b = pool.filter(p => p.tier === 'B');
      return (b.length ? b : pool).sort((x, y) => x.tier.localeCompare(y.tier)).map(p => ({ ...p, modelId: p.models[0] }));
    }
    default: { // free:smart / free:best / free:free — best tier, then lowest latency
      return [...pool]
        .sort((a, b) => a.tier.localeCompare(b.tier) || (healthOf(a.name).avgLatency ?? 1e9) - (healthOf(b.name).avgLatency ?? 1e9))
        .map(p => ({ ...p, modelId: p.models[0] }));
    }
  }
}

function estimateCost(provider, tokensIn, tokensOut) {
  const [pin, pout] = PRICES[provider] ?? DEFAULT_PRICE;
  return +(((tokensIn / 1e6) * pin) + ((tokensOut / 1e6) * pout)).toFixed(6);
}

export async function chat(messages, { model = 'free:smart', max_tokens = 2048, temperature = 0.7 } = {}) {
  const plan = resolveCandidates(model);
  if (!plan.length) {
    throw new Error('No providers configured. Add API keys to your .env file — see .env.example');
  }

  const errors = [];
  for (const cand of plan) {
    const modelId = cand.modelId ?? cand.models[0];
    const t0 = Date.now();
    try {
      const res = await fetch(`${cand.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cand.apiKey}` },
        body: JSON.stringify({ model: modelId, messages, max_tokens, temperature }),
      });

      // Rate limits, exhausted credits, and upstream hiccups → try the next provider.
      if (res.status === 429 || res.status === 402 || res.status >= 500) {
        markFail(cand.name);
        errors.push(`${cand.name}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        errors.push(`${cand.name}: ${res.status} ${body.slice(0, 120)}`);
        continue;
      }

      const data = await res.json();
      markOk(cand.name, Date.now() - t0);
      const usage = data.usage ?? {};
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        tokens_in: usage.prompt_tokens ?? 0,
        tokens_out: usage.completion_tokens ?? 0,
        model: modelId,
        provider: cand.name,
        cost: estimateCost(cand.name, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0),
      };
    } catch (e) {
      markFail(cand.name);
      errors.push(`${cand.name}: ${e.message}`);
    }
  }
  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// Health report for the API/dashboard. Keys are never included.
export function providerHealth() {
  return Object.entries(PROVIDERS).map(([name, p]) => {
    const h = health[name] ?? { fails: 0, avgLatency: null, lastFailAt: 0 };
    return {
      provider: name,
      tier: p.tier,
      configured: !!keyOf(p),
      healthy: !!keyOf(p) && !isSick(name),
      avg_latency_ms: h.avgLatency,
      fails: h.fails,
      models: p.models,
    };
  });
}
