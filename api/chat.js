// api/chat.js
// Vercel Serverless Function — runs on the server, never in the browser.
// Tries Groq first (fast, generous free tier), then Gemini, then OpenRouter
// as a last resort. Keeps all API keys secret on the server side.

async function tryGroq(messages, temperature, max_tokens, failures) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];
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

async function tryGemini(messages, temperature, max_tokens, failures) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  // Gemini uses a different message format: split system prompt out, map roles.
  const systemMsg = messages.find(m => m.role === 'system');
  const convo = messages.filter(m => m.role !== 'system');
  const contents = convo.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const body = {
        contents,
        generationConfig: { temperature, maxOutputTokens: max_tokens },
      };
      if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
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

async function tryOpenRouter(messages, temperature, max_tokens, models, failures) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const pool = models && models.length ? models : [
    'deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free',
  ];
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

  const failures = [];
  let result = null;
  let triedCount = 0;

  result = await tryGroq(messages, temperature, max_tokens, failures);
  triedCount = failures.length;
  if (!result) {
    result = await tryGemini(messages, temperature, max_tokens, failures);
    triedCount = failures.length;
  }
  if (!result) {
    result = await tryOpenRouter(messages, temperature, max_tokens, models, failures);
    triedCount = failures.length;
  }

  if (result) {
    return res.status(200).json({ text: result.text, model: result.model, tried: triedCount || 1 });
  }

  // Every provider failed.
  return res.status(200).json({
    text: null,
    error: failures.join(' | ').slice(0, 800),
    tried: triedCount,
  });
}
