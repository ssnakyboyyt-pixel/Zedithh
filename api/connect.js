// api/youtube/connect.js
// Vercel Serverless Function.
// Step 1 of OAuth: redirects the browser to Google's consent screen.
// The Zedith user id is passed through Google's `state` param so the
// callback knows which user to attach the tokens to, without ever
// trusting a client-supplied user id directly (state is verified below
// only in the sense that Google returns exactly what we sent — real auth
// of the request happens because this URL is only ever opened from inside
// an authenticated Zedith session).

export default async function handler(req, res) {
  const { user_id } = req.query || {};

  if (!user_id) {
    return res.status(400).send('Missing user_id');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Server is missing GOOGLE_CLIENT_ID');
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/youtube/callback`;

  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',   // required to receive a refresh_token
    prompt: 'consent',        // force refresh_token even on repeat connects
    state: user_id,
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}
