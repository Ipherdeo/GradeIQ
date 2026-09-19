const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const WINDOW_SECONDS = Number(process.env.AI_RATE_WINDOW_SECONDS || 60);
const MAX_REQUESTS = Number(process.env.AI_RATE_MAX_REQUESTS || 6);
const memoryCounters = new Map();

function send(res, status, body, headers = {}) {
  res.status(status).set({ 'Content-Type': 'application/json', ...headers }).send(JSON.stringify(body));
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

async function rateLimit(key) {
  // Upstash is durable across Vercel function instances. The local fallback still
  // protects development and deployments where UPSTASH_REDIS_REST_URL is absent.
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const url = `${process.env.UPSTASH_REDIS_REST_URL}/incr/${encodeURIComponent(key)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    const { result: count } = await response.json();
    if (count === 1) await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/expire/${encodeURIComponent(key)}/${WINDOW_SECONDS}`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    return { allowed: count <= MAX_REQUESTS, retryAfter: WINDOW_SECONDS };
  }
  const now = Date.now();
  const item = memoryCounters.get(key);
  const active = item && item.resetAt > now ? item : { count: 0, resetAt: now + WINDOW_SECONDS * 1000 };
  active.count += 1;
  memoryCounters.set(key, active);
  return { allowed: active.count <= MAX_REQUESTS, retryAfter: Math.ceil((active.resetAt - now) / 1000) };
}

function textFrom(content) {
  return (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: 'Server configuration is incomplete.' });

  const limit = await rateLimit(`gradeiq:ai:${clientIp(req)}`);
  if (!limit.allowed) return send(res, 429, { error: 'Too many AI requests. Please try again shortly.' }, { 'Retry-After': String(limit.retryAfter) });

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 4) return send(res, 400, { error: 'Invalid messages payload.' });
  const safeMessages = messages.map(({ role, content }) => ({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content || '').slice(0, 6000) }));

  const payload = {
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: 1400,
    thinking: { type: 'adaptive' },
    system: 'You are GradeIQ, an accurate academic adviser for Nigerian university students. Use web search when current, university-specific, or factual research would improve an answer. Reason carefully, do not invent sources or policies, and give practical, concise guidance. Do not expose private reasoning.',
    messages: safeMessages,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]
  };

  try {
    let data;
    let conversation = safeMessages;
    // Server-side web search can return pause_turn while Claude continues its
    // research. Resume the same turn, with a bounded loop to cap latency/cost.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ ...payload, messages: conversation })
      });
      data = await response.json();
      if (!response.ok) return send(res, response.status, { error: data.error?.message || 'Claude could not complete this request.' });
      if (data.stop_reason !== 'pause_turn') break;
      conversation = [...conversation, { role: 'assistant', content: data.content }];
    }
    const content = textFrom(data.content);
    if (!content) return send(res, 502, { error: 'Claude returned no usable text.' });
    // Maintain the existing browser response shape while switching providers.
    return send(res, 200, { choices: [{ message: { content } }], usage: data.usage });
  } catch (error) {
    return send(res, 502, { error: 'Could not reach Claude. Please try again.' });
  }
}
