// api/config.js
// Vercel Serverless Function — runs on the server, never in the browser.
// Serves ONLY the public Supabase URL + anon key to the client at page load,
// so the frontend never has these values hardcoded in the HTML source.
// The anon key is safe to expose publicly (it's protected by Supabase Row
// Level Security) — this route just keeps it out of the static file source
// and lets you change environments (live vs dev) via env vars only.

export default function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return res.status(500).json({ error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY env vars' });
  }

  // Safe to cache briefly on the client/edge since these values rarely change.
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ url, anonKey });
}
