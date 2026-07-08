// api/chat.js
// Vercel Serverless Function — runs on the server, never in the browser.
// Fallback chain: Groq -> Cerebras -> Gemini -> OpenRouter.
// All four have genuinely free tiers with NO credit card required, which
// matters a lot when the person running this can't add a card themselves.
// Keeps all API keys secret on the server side.
//
// IMPORTANT: messages sent from the client can have `content` as either:
//   - a plain string (normal text message), or
//   - an array of parts (vision message): [{type:'text',text}, {type:'image_url',image_url:{url}}]
// Each provider needs that array converted into ITS OWN format before sending.

function hasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
}

// Sanitize messages before sending to a TEXT-ONLY provider (Groq/Cerebras).
// Strips image parts and flattens any array-content into a plain string, so a
// message shape that's valid for Gemini/OpenRouter can never crash Groq/Cerebras
// with "messages[n].content must be a string".
function toTextOnlyMessages(messages) {
  return messages.map(m => {
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter(p => p && p.type === 'text')
        .map(p => p.text || '')
        .join('\n')
        .trim();
      return { role: m.role, content: text || '[image omitted]' };
    }
    if (typeof m.content !== 'string') {
      return { role: m.role, content: m.content == null ? '' : String(m.content) };
    }
    return m;
  });
}

// Wrap a fetch with a hard timeout so one hung provider can't stall the whole chain.
async function fetchWithTimeout(url, options, ms = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Retry once on 429 (rate limit) with a short backoff before giving up on a model.
async function fetchWithRetry(url, options, ms = 15000) {
  let r = await fetchWithTimeout(url, options, ms);
  if (r.status === 429) {
    await new Promise(res => setTimeout(res, 1200));
    r = await fetchWithTimeout(url, options, ms);
  }
  return r;
}

// ---------- Groq (OpenAI-compatible, but the free text models have NO vision support) ----------
async function tryGroq(messages, temperature, max_tokens, failures) {
  const key = process.env.GROQ_API_KEY;
  if (!key) { failures.push('groq: no GROQ_API_KEY set on server'); return null; }
  if (hasImage(messages)) {
    failures.push('groq: skipped (free Groq models here do not support image input)');
    return null;
  }
  const safeMessages = toTextOnlyMessages(messages);
  const models = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
  for (const model of models) {
    try {
      const r = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: safeMessages, temperature, max_tokens }),
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
        failures.push(`groq/${model}: HTTP ${r.status} ${bodyText}`);
        continue;
      }
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return { text: text.trim(), model: `groq/${model}` };
      failures.push(`groq/${model}: empty response`);
    } catch (e) {
      failures.push(`groq/${model}: ${e.message}`);
    }
  }
  return null;
}

// ---------- Cerebras (OpenAI-compatible, no card needed, 1M free tokens/day) ----------
async function tryCerebras(messages, temperature, max_tokens, failures) {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) { failures.push('cerebras: no CEREBRAS_API_KEY set on server'); return null; }
  if (hasImage(messages)) {
    failures.push('cerebras: skipped (no vision support on free-tier models)');
    return null;
  }
  const safeMessages = toTextOnlyMessages(messages);
  const models = ['llama3.1-8b', 'llama-3.3-70b'];
  for (const model of models) {
    try {
      const r = await fetchWithRetry('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: safeMessages, temperature, max_tokens }),
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
        failures.push(`cerebras/${model}: HTTP ${r.status} ${bodyText}`);
        continue;
      }
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return { text: text.trim(), model: `cerebras/${model}` };
      failures.push(`cerebras/${model}: empty response`);
    } catch (e) {
      failures.push(`cerebras/${model}: ${e.message}`);
    }
  }
  return null;
}

// ---------- Gemini (needs its own contents/parts/inlineData shape) ----------
function dataUrlToInlineData(url) {
  // "data:image/png;base64,AAAA..." -> {mimeType:'image/png', data:'AAAA...'}
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(url || '');
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function toGeminiContents(messages) {
  const convo = messages.filter(m => m.role !== 'system');
  return convo.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text || '' });
        } else if (part.type === 'image_url') {
          const inline = dataUrlToInlineData(part.image_url?.url);
          if (inline) parts.push({ inlineData: inline });
        }
      }
      return { role, parts: parts.length ? parts : [{ text: '' }] };
    }
    return { role, parts: [{ text: m.content || '' }] };
  });
}

async function tryGemini(messages, temperature, max_tokens, failures) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { failures.push('gemini: no GEMINI_API_KEY set on server'); return null; }
  // gemini-1.5-flash is deprecated/404s on v1beta now — use current model names.
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest'];
  const systemMsg = messages.find(m => m.role === 'system');
  const contents = toGeminiContents(messages);
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const body = {
        contents,
        generationConfig: { temperature, maxOutputTokens: max_tokens },
      };
      if (systemMsg) {
        const sysText = Array.isArray(systemMsg.content)
          ? systemMsg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
          : systemMsg.content;
        body.systemInstruction = { parts: [{ text: sysText }] };
      }
      const r = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
        failures.push(`gemini/${model}: HTTP ${r.status} ${bodyText}`);
        continue;
      }
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
      if (text && text.trim()) return { text: text.trim(), model: `gemini/${model}` };
      const blockReason = data?.promptFeedback?.blockReason;
      const finishReason = data?.candidates?.[0]?.finishReason;
      failures.push(`gemini/${model}: empty response${blockReason ? ` (blocked: ${blockReason})` : ''}${finishReason ? ` (finish: ${finishReason})` : ''}`);
    } catch (e) {
      failures.push(`gemini/${model}: ${e.message}`);
    }
  }
  return null;
}

// ---------- OpenRouter (OpenAI-compatible; vision models accept the array-content shape as-is) ----------
async function tryOpenRouter(messages, temperature, max_tokens, models, failures, needsVision) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { failures.push('openrouter: no OPENROUTER_API_KEY set on server'); return null; }
  const visionModels = [
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
  ];
  const textModels = ['deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free'];
  const pool = needsVision
    ? visionModels
    : (models && models.length ? models : textModels);
  for (const model of pool) {
    try {
      const r = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://zedith.app',
          'X-Title': 'Zedith',
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
        failures.push(`openrouter/${model}: HTTP ${r.status} ${bodyText}`);
        continue;
      }
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return { text: text.trim(), model: `openrouter/${model}` };
      failures.push(`openrouter/${model}: empty response`);
    } catch (e) {
      failures.push(`openrouter/${model}: ${e.message}`);
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, models, temperature = 0.7, max_tokens = 1300 } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!process.env.GROQ_API_KEY && !process.env.CEREBRAS_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Server has no AI provider keys configured (GROQ_API_KEY, CEREBRAS_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY)' });
  }

  const needsVision = hasImage(messages);
  const failures = [];
  let result = null;

  // Vision requests: Gemini is fastest/most reliable for this, try it first.
  if (needsVision) {
    result = await tryGemini(messages, temperature, max_tokens, failures);
    if (!result) result = await tryOpenRouter(messages, temperature, max_tokens, models, failures, true);
  } else {
    result = await tryGroq(messages, temperature, max_tokens, failures);
    if (!result) result = await tryCerebras(messages, temperature, max_tokens, failures);
    if (!result) result = await tryGemini(messages, temperature, max_tokens, failures);
    if (!result) result = await tryOpenRouter(messages, temperature, max_tokens, models, failures, false);
  }

  if (result) {
    return res.status(200).json({ text: result.text, model: result.model, tried: failures.length || 1 });
  }

  return res.status(200).json({
    text: null,
    error: failures.join(' | ').slice(0, 1500),
    tried: failures.length,
  });
}
