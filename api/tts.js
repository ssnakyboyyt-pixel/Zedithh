// /api/tts.js
// Vercel serverless function. Calls Gemini's native TTS model
// (gemini-2.5-flash-preview-tts) server-side so the Gemini API key is
// never exposed to the browser. Add GEMINI_API_KEY in your Vercel
// project's Environment Variables (same key used for /api/generate-image).
//
// Gemini TTS returns raw 24kHz 16-bit mono PCM audio, so this function
// wraps it in a proper WAV header before sending it back — the browser
// can then play it directly as audio/wav with no extra client-side work.

export const GEMINI_VOICES = [
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe',
  'Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome',
  'Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux',
  'Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia',
  'Sadaltager','Sulafat',
];

function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing text' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long (max 2000 characters)' });
  }
  const voiceName = GEMINI_VOICES.includes(voice) ? voice : 'Kore';

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[tts] GEMINI_API_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: text.trim() }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('[tts] Gemini error:', data);
      const msg = data?.error?.message || 'Voice generation failed';
      return res.status(geminiRes.status).json({ error: msg });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.data);

    if (!audioPart) {
      console.error('[tts] No audio in response:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'No audio returned. Try again.' });
    }

    const pcmBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
    const wavBuffer = pcmToWav(pcmBuffer);
    const audioUrl = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;

    return res.status(200).json({ audioUrl, voice: voiceName });
  } catch (err) {
    console.error('[tts] Unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
}
