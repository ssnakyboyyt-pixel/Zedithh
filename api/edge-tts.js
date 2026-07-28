// /api/edge-tts.js
// Vercel serverless function. Uses Microsoft Edge's free online TTS service
// via the open-source @andresaya/edge-tts package — no API key, no billing,
// no published rate limit (unlike Gemini TTS which is capped at 15/day free).
//
// IMPORTANT CAVEAT: this is an unofficial wrapper around Microsoft Edge's
// internal "Read Aloud" service, not a sanctioned public API. It could stop
// working without notice if Microsoft changes something on their end. Keep
// this in mind if usage becomes business-critical.
//
// Install first: npm install @andresaya/edge-tts

import { EdgeTTS } from '@andresaya/edge-tts';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing text' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'Text too long (max 5000 characters)' });
  }

  const voiceName = (voice && typeof voice === 'string') ? voice : 'en-US-JennyNeural';

  try {
    const tts = new EdgeTTS();
    await tts.synthesize(text.trim(), voiceName, {
      rate: '0%',
      pitch: '0Hz',
      volume: '0%',
    });

    // Confirmed API: tts.toBase64() returns the synthesized audio as a
    // base64 string after synthesize() completes.
    const base64Audio = tts.toBase64();
    if (!base64Audio) {
      throw new Error('No audio data returned from Edge TTS');
    }

    const audioUrl = `data:audio/mpeg;base64,${base64Audio}`;
    return res.status(200).json({ audioUrl, voice: voiceName });
  } catch (err) {
    console.error('[edge-tts] Generation failed:', err);
    return res.status(500).json({ error: err.message || 'Voice generation failed' });
  }
}
