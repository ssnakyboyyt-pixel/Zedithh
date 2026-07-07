// api/youtube/callback.js
// Vercel Serverless Function.
// Step 2 of OAuth: Google redirects here with a `code`. We exchange it for
// access + refresh tokens, fetch the channel's basic info, store everything
// server-side in Supabase (service role key — never exposed to the browser),
// then redirect the user back into the Zedith app.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { code, state, error: oauthError } = req.query || {};
  const appUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

  if (oauthError) {
    return res.redirect(302, `${appUrl}/index.html?yt_error=${encodeURIComponent(oauthError)}#analytics`);
  }
  if (!code || !state) {
    return res.redirect(302, `${appUrl}/index.html?yt_error=missing_code#analytics`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!clientId || !clientSecret || !supabaseUrl || !serviceKey) {
    return res.redirect(302, `${appUrl}/index.html?yt_error=server_not_configured#analytics`);
  }

  const redirectUri = `${appUrl}/api/youtube/callback`;

  try {
    // Exchange the authorization code for tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.redirect(302, `${appUrl}/index.html?yt_error=${encodeURIComponent(tokenData.error_description || 'token_exchange_failed')}#analytics`);
    }

    const { access_token, refresh_token, expires_in, scope } = tokenData;
    if (!refresh_token) {
      // Happens if the user had already granted access before and Google
      // didn't re-issue a refresh_token. Ask them to reconnect with consent.
      return res.redirect(302, `${appUrl}/index.html?yt_error=no_refresh_token_please_reconnect#analytics`);
    }

    // Fetch the channel's basic info to display immediately and store.
    const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const chData = await chRes.json();
    const channel = chData?.items?.[0];

    const supabase = createClient(supabaseUrl, serviceKey);
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

    const { error: upsertErr } = await supabase.from('youtube_connections').upsert({
      user_id: state,
      access_token,
      refresh_token,
      expires_at: expiresAt,
      scope,
      channel_id: channel?.id || null,
      channel_title: channel?.snippet?.title || null,
      channel_thumbnail: channel?.snippet?.thumbnails?.default?.url || null,
      updated_at: new Date().toISOString(),
    });

    if (upsertErr) {
      return res.redirect(302, `${appUrl}/index.html?yt_error=${encodeURIComponent('storage_failed: ' + upsertErr.message)}#analytics`);
    }

    return res.redirect(302, `${appUrl}/index.html?yt_connected=1#analytics`);
  } catch (e) {
    return res.redirect(302, `${appUrl}/index.html?yt_error=${encodeURIComponent(e.message)}#analytics`);
  }
}
