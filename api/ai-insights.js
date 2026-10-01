const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const WINDOW_SECONDS = Number(process.env.AI_RATE_WINDOW_SECONDS || 60);
const MAX_REQUESTS = Number(process.env.AI_RATE_MAX_REQUESTS || 6);
const memoryCounters = new Map();

function send(res, status, body, headers = {}) {
  // Use the Node response primitives supported by Vercel's serverless runtime.
  // Chaining res.status().set() is not supported on every runtime version.
  res.statusCode = status;
  for (const [name, value] of Object.entries({ 'Content-Type': 'application/json', ...headers })) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

async function rateLimit(key) {
  const now = Date.now();
  const windowId = Math.floor(now / (WINDOW_SECONDS * 1000));
  const windowKey = `${key}:${windowId}`;
  const retryAfter = Math.ceil(((windowId + 1) * WINDOW_SECONDS * 1000 - now) / 1000);

  // Bucketed keys prevent a missed Redis expiry from permanently locking out an IP.
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const baseUrl = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
    const response = await fetch(`${baseUrl}/incr/${encodeURIComponent(windowKey)}`, { headers });
    const data = await response.json();
    if (!response.ok || data.error || !Number.isFinite(Number(data.result))) throw new Error(data.error || 'Upstash returned an invalid rate-limit response.');
    const count = Number(data.result);
    const expireResponse = await fetch(`${baseUrl}/expire/${encodeURIComponent(windowKey)}/${Math.max(WINDOW_SECONDS * 2, 60)}`, { headers });
    if (!expireResponse.ok) console.error('Could not expire the Upstash rate-limit key.');
    return { allowed: count <= MAX_REQUESTS, retryAfter };
  }
  const item = memoryCounters.get(windowKey);
  const active = item || { count: 0, resetAt: (windowId + 1) * WINDOW_SECONDS * 1000 };
  active.count += 1;
  memoryCounters.set(windowKey, active);
  return { allowed: active.count <= MAX_REQUESTS, retryAfter };
}

function textFrom(content) {
  return (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
}

async function readProviderResponse(response, provider) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const excerpt = text.replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`${provider} returned HTTP ${response.status} with non-JSON content${excerpt ? `: ${excerpt}` : '.'}`);
  }
}

const SYSTEM_PROMPT = 'You are GradeIQ, an accurate academic adviser for Nigerian university students. Use web search when current, university-specific, or factual research would improve an answer. Reason carefully, do not invent sources or policies, and give practical, concise guidance. Do not expose private reasoning.';

function isOpenAICompatible() {
  const format = (process.env.AI_API_FORMAT || '').toLowerCase();
  return format === 'openai' || (!format && Boolean(process.env.AI_API_KEY) && !process.env.ANTHROPIC_API_KEY);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  if (!process.env.AI_API_KEY && !process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: 'Server configuration is incomplete. Add AI_API_KEY (OpenAI-compatible provider) or ANTHROPIC_API_KEY in Vercel Environment Variables.' });
  if (process.env.AI_API_FORMAT && !['openai', 'anthropic'].includes(process.env.AI_API_FORMAT.toLowerCase())) return send(res, 500, { error: 'AI_API_FORMAT must be either openai or anthropic.' });

  let limit;
  try {
    limit = await rateLimit(`gradeiq:ai:${clientIp(req)}`);
  } catch (error) {
    console.error('AI rate-limit check failed:', error);
    return send(res, 503, { error: 'The rate-limit service is unavailable. Check the Upstash REST URL and token in Vercel.' });
  }
  if (!limit.allowed) return send(res, 429, { error: 'Too many AI requests. Please try again shortly.' }, { 'Retry-After': String(limit.retryAfter) });

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 4) return send(res, 400, { error: 'Invalid messages payload.' });
  const safeMessages = messages.map(({ role, content }) => ({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content || '').slice(0, 6000) }));

  if (!isOpenAICompatible() && !(process.env.ANTHROPIC_API_KEY || (process.env.AI_API_KEY && (process.env.AI_API_FORMAT || '').toLowerCase() === 'anthropic'))) {
    return send(res, 500, { error: 'Anthropic mode requires ANTHROPIC_API_KEY. For an OpenAI-compatible API key, set AI_API_FORMAT=openai and configure AI_API_BASE_URL and AI_MODEL.' });
  }

  const payload = {
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: 1400,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: safeMessages,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]
  };

  try {
    if (isOpenAICompatible()) {
      if (!process.env.AI_API_KEY) return send(res, 500, { error: 'AI_API_FORMAT=openai requires AI_API_KEY.' });
      const baseUrl = (process.env.AI_API_BASE_URL || 'https://vyceai.com/v1').replace(/\/$/, '');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
        body: JSON.stringify({
          model: process.env.AI_MODEL || DEFAULT_MODEL,
          max_tokens: 1400,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...safeMessages]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.status === 504) return send(res, 504, { error: 'Vyce AI timed out before completing this request. Try again with a shorter course name or later.' });
      const data = await readProviderResponse(response, `AI provider at ${baseUrl}/chat/completions`);
      if (!response.ok) return send(res, response.status, { error: data.error?.message || data.message || 'VyceAI could not complete this request.' }, response.headers.get('retry-after') ? { 'Retry-After': response.headers.get('retry-after') } : {});
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return send(res, 502, { error: 'VyceAI returned no usable text.' });
      return send(res, 200, { choices: [{ message: { content } }], usage: data.usage });
    }

    let data;
    let conversation = safeMessages;
    // Server-side web search can return pause_turn while Claude continues its
    // research. Resume the same turn, with a bounded loop to cap latency/cost.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ ...payload, messages: conversation })
      });
      data = await readProviderResponse(response, 'Anthropic');
      if (!response.ok) return send(res, response.status, { error: data.error?.message || 'Claude could not complete this request.' }, response.headers.get('retry-after') ? { 'Retry-After': response.headers.get('retry-after') } : {});
      if (data.stop_reason !== 'pause_turn') break;
      conversation = [...conversation, { role: 'assistant', content: data.content }];
    }
    const content = textFrom(data.content);
    if (!content) return send(res, 502, { error: 'Claude returned no usable text.' });
    // Maintain the existing browser response shape while switching providers.
    return send(res, 200, { choices: [{ message: { content } }], usage: data.usage });
  } catch (error) {
    console.error('AI insights request failed:', error);
    if (error.name === 'AbortError') return send(res, 504, { error: 'The AI provider took too long to respond. Please try again.' });
    return send(res, 502, { error: `Could not reach the AI provider. ${error.message || 'Please try again.'}` });
  }
}
