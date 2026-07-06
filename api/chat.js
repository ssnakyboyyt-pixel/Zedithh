// api/chat.js
// Vercel Serverless Function — runs on the server, never in the browser.
// Keeps the OpenRouter API key secret. The frontend calls /api/chat instead
// of calling OpenRouter directly, so the key can never be viewed via
// "View Source" or dev tools.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY' });
  }

  const { messages, models, temperature = 0.7, max_tokens = 1300 } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const pool = Array.isArray(models) && models.length > 0
    ? models
    : ['deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free'];

  // Try each free model in order until one responds successfully.
  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://zedith.app',
          'X-Title': 'Zedith',
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
      });

      if (!r.ok) continue; // try the next model in the pool

      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        return res.status(200).json({ text: text.trim(), model, tried: i + 1 });
      }
    } catch (e) {
      continue; // network hiccup on this model — try the next one
    }
  }

  // Every model in the pool failed or was rate-limited.
  return res.status(200).json({
    text: null,
    error: true,
    tried: pool.length,
  });
}
