// /api/channel-explorer.js
// Vercel serverless function. Looks up a PUBLIC YouTube channel by URL,
// @handle, or name using YouTube Data API v3, server-side only — the
// API key never reaches the browser. No OAuth, no user login to YouTube;
// this is for researching other channels, not the user's own analytics.

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

function extractChannelHint(input) {
  const t = (input || '').trim();
  // Direct channel ID (UC...)
  const idMatch = t.match(/(?:channel\/)?(UC[a-zA-Z0-9_-]{22})/);
  if (idMatch) return { type: 'id', value: idMatch[1] };
  // @handle, with or without full URL
  const handleMatch = t.match(/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) return { type: 'handle', value: '@' + handleMatch[1] };
  // /c/CustomName or /user/Username legacy URLs
  const legacyMatch = t.match(/youtube\.com\/(?:c|user)\/([a-zA-Z0-9_-]+)/);
  if (legacyMatch) return { type: 'query', value: legacyMatch[1] };
  // Otherwise treat the whole input as a search query (channel name, topic, etc.)
  return { type: 'query', value: t };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { input } = req.body || {};
  if (!input || typeof input !== 'string' || !input.trim()) {
    return res.status(400).json({ error: 'Missing channel URL, @handle, or name' });
  }

  const apiKey = process.env.YOUTUBE_DATA_API_V3;
  if (!apiKey) {
    console.error('[channel-explorer] YOUTUBE_DATA_API_V3 not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const hint = extractChannelHint(input);
    let channelId = null;

    // Step 1: resolve to a channel ID.
    if (hint.type === 'id') {
      channelId = hint.value;
    } else if (hint.type === 'handle') {
      // channels.list supports forHandle directly — no search quota cost.
      const r = await fetch(`${YT_BASE}/channels?part=id&forHandle=${encodeURIComponent(hint.value)}&key=${apiKey}`);
      const j = await r.json();
      if (j.items?.[0]) channelId = j.items[0].id;
    }

    if (!channelId) {
      // Fall back to search.list for a name/query/legacy-URL slug.
      const q = hint.value;
      const r = await fetch(`${YT_BASE}/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(q)}&key=${apiKey}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'YouTube search failed');
      if (!j.items?.[0]) {
        return res.status(404).json({ error: 'No public YouTube channel found for that input.' });
      }
      channelId = j.items[0].snippet.channelId;
    }

    // Step 2: channels.list — full channel details + statistics + uploads playlist.
    const chRes = await fetch(`${YT_BASE}/channels?part=snippet,statistics,contentDetails,brandingSettings&id=${channelId}&key=${apiKey}`);
    const chJson = await chRes.json();
    if (!chRes.ok) throw new Error(chJson.error?.message || 'YouTube channel lookup failed');
    const ch = chJson.items?.[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found.' });

    const uploadsPlaylistId = ch.contentDetails?.relatedPlaylists?.uploads;

    // Step 3: recent uploads via the uploads playlist (cheaper than search.list).
    let videoItems = [];
    if (uploadsPlaylistId) {
      const plRes = await fetch(`${YT_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=15&key=${apiKey}`);
      const plJson = await plRes.json();
      if (plRes.ok) videoItems = plJson.items || [];
    }

    const videoIds = videoItems.map(v => v.contentDetails?.videoId).filter(Boolean);
    let videoStats = {};
    if (videoIds.length) {
      const vRes = await fetch(`${YT_BASE}/videos?part=statistics,snippet,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`);
      const vJson = await vRes.json();
      if (vRes.ok) {
        (vJson.items || []).forEach(v => { videoStats[v.id] = v; });
      }
    }

    const recentVideos = videoItems.map(item => {
      const vid = item.contentDetails?.videoId;
      const stats = videoStats[vid];
      return {
        id: vid,
        title: item.snippet?.title || '',
        thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
        views: stats?.statistics?.viewCount ? Number(stats.statistics.viewCount) : null,
        likes: stats?.statistics?.likeCount ? Number(stats.statistics.likeCount) : null,
        comments: stats?.statistics?.commentCount ? Number(stats.statistics.commentCount) : null,
        duration: stats?.contentDetails?.duration || null,
      };
    }).filter(v => v.id);

    const channel = {
      id: ch.id,
      title: ch.snippet?.title || '',
      description: ch.snippet?.description || '',
      thumbnail: ch.snippet?.thumbnails?.high?.url || ch.snippet?.thumbnails?.default?.url || '',
      customUrl: ch.snippet?.customUrl || null,
      publishedAt: ch.snippet?.publishedAt || null,
      country: ch.snippet?.country || null,
      subscriberCount: ch.statistics?.hiddenSubscriberCount ? null : Number(ch.statistics?.subscriberCount || 0),
      viewCount: Number(ch.statistics?.viewCount || 0),
      videoCount: Number(ch.statistics?.videoCount || 0),
      banner: ch.brandingSettings?.image?.bannerExternalUrl || null,
    };

    return res.status(200).json({ channel, recentVideos });
  } catch (err) {
    console.error('[channel-explorer] Error:', err);
    return res.status(500).json({ error: err.message || 'Unexpected server error' });
  }
}
