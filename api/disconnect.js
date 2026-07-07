// api/youtube/disconnect.js
// Vercel Serverless Function.
// Revokes the stored Google token and deletes the row from Supabase.
// Auth: Supabase JWT in Authorization header, same as analytics.js.

import { createClient } from '@supabase/supabase-js';
import { getServiceClient } from './_tokens.js';

async function verifyUser(req) {
  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  try {
    const supabase = getServiceClient();
    const { data: row } = await supabase.from('youtube_connections').select('access_token').eq('user_id', user.id).maybeSingle();

    if (row?.access_token) {
      // Best-effort revoke with Google; don't fail disconnect if this fails.
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.access_token)}`, { method: 'POST' });
      } catch (_) {}
    }

    const { error: delErr } = await supabase.from('youtube_connections').delete().eq('user_id', user.id);
    if (delErr) return res.status(200).json({ ok: false, error: delErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
