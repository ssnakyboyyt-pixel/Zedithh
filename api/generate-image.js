// /api/generate-image.js
// Vercel serverless function. Calls Gemini 2.5 Flash Image (free tier,
// ~500 requests/day) server-side so the Gemini API key is never exposed
// to the browser. Add GEMINI_API_KEY in your Vercel project's
// Environment Variables (same key used for /api/tts).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Missing prompt' });
  }
  if (prompt.length > 800) {
    return res.status(400).json({ error: 'Prompt too long' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[generate-image] GEMINI_API_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt.trim() }] }],
          generationConfig: { responseModalities: ['image', 'text'] },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('[generate-image] Gemini error:', data);
      let msg = data?.error?.message || 'Image generation failed';
      if (geminiRes.status === 404) {
        msg = `Model "gemini-2.5-flash-image" not available for this API key (404). This usually means the key's Google Cloud project doesn't have this model enabled, or it needs billing enabled even on the free tier. Original error: ${msg}`;
      }
      return res.status(geminiRes.status).json({ error: msg });
    }

    // Find the first inline image part in the response.
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.data);

    if (!imagePart) {
      console.error('[generate-image] No image in response:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'No image returned. Try rephrasing your request.' });
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    const base64 = imagePart.inlineData.data;
    const imageUrl = `data:${mimeType};base64,${base64}`;

    return res.status(200).json({ imageUrl });
  } catch (err) {
    console.error('[generate-image] Unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
}
