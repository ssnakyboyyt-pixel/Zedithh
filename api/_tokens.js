// api/youtube/_tokens.js
// Shared helper (not a route itself). Loads the user's stored YouTube
// tokens and transparently refreshes the access token if it has expired,
// writing the new token back to Supabase so future requests reuse it.

import { createClient } from '@supabase/supabase-js';

export function getServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('server_not_configured');
  return createClient(supabaseUrl, serviceKey);
}

export async function getValidAccessToken(userId) {
  const supabase = getServiceClient();
  const { data: row, error } = await supabase
    .from('youtube_connections')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error('lookup_failed: ' + error.message);
  if (!row) return null; // not connected

  const expiresAt = new Date(row.expires_at).getTime();
  const isExpired = Date.now() > (expiresAt - 60_000); // refresh 60s early

  if (!isExpired) return { accessToken: row.access_token, row };

  // Refresh the token.
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('server_not_configured');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    // Refresh token itself is likely revoked/expired — caller should treat
    // this as "needs to reconnect".
    throw new Error('refresh_failed: ' + (data.error_description || data.error || 'unknown'));
  }

  const newExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  const { error: updateErr } = await supabase
    .from('youtube_connections')
    .update({ access_token: data.access_token, expires_at: newExpiresAt, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (updateErr) throw new Error('token_save_failed: ' + updateErr.message);

  return { accessToken: data.access_token, row: { ...row, access_token: data.access_token, expires_at: newExpiresAt } };
}
