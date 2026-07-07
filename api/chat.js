// api/chat.js
// Vercel Serverless Function — runs on the server, never in the browser.
// Tries Groq first (fast, generous free tier), then Gemini, then OpenRouter
// as a last resort. Keeps all API keys secret on the server side.
//
// IMPORTANT: messages sent from the client can have `content` as either:
//   - a plain string (normal text message), or
//   - an array of parts (vision message): [{type:'text',text}, {type:'image_url',image_url:{url}}]
// Each provider needs that array converted into ITS OWN format before sending.

function hasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
}

// ---------- Groq (OpenAI-compatible, but the free text models have NO vision support) ----------
async function tryGroq(messages, temperature, max_tokens, failures) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  if (hasImage(messages)) {
    failures.push('groq: skipped (free Groq models here do not support image input)');
    return null;
  }
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of models) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = (await r.text()).slice(0, 200); } catch (_) {}
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
  if (!key) return null;
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
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
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = (await r.text()).slice(0, 200); } catch (_) {}
        failures.push(`gemini/${model}: HTTP ${r.status} ${bodyText}`);
        continue;
      }
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
      if (text && text.trim()) return { text: text.trim(), model: `gemini/${model}` };
      failures.push(`gemini/${model}: empty response`);
    } catch (e) {
      failures.push(`gemini/${model}: ${e.message}`);
    }
  }
  return null;
}

// ---------- OpenRouter (OpenAI-compatible; vision models accept the array-content shape as-is) ----------
async function tryOpenRouter(messages, temperature, max_tokens, models, failures, needsVision) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const visionModels = ['meta-llama/llama-4-maverick:free', 'meta-llama/llama-4-scout:free', 'google/gemma-3-27b-it:free'];
  const textModels = ['deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free'];
  const pool = needsVision
    ? visionModels
    : (models && models.length ? models : textModels);
  for (const model of pool) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
        try { bodyText = (await r.text()).slice(0, 200); } catch (_) {}
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

  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Server has no AI provider keys configured (GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY)' });
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
    if (!result) result = await tryGemini(messages, temperature, max_tokens, failures);
    if (!result) result = await tryOpenRouter(messages, temperature, max_tokens, models, failures, false);
  }

  if (result) {
    return res.status(200).json({ text: result.text, model: result.model, tried: failures.length || 1 });
  }

  return res.status(200).json({
    text: null,
    error: failures.join(' | ').slice(0, 800),
    tried: failures.length,
  });
}
