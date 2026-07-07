// api/youtube/analytics.js
// Vercel Serverless Function.
// Fetches everything the Analytics dashboard needs in one call: channel
// stats, recent videos, top-performing videos (via YouTube Analytics API),
// views/likes/comments/watch-time for the last 28 days.
// Auth: expects a Supabase JWT in the Authorization header so we know which
// user's tokens to use — never trusts a client-supplied user id directly.

import { createClient } from '@supabase/supabase-js';
import { getValidAccessToken } from './_tokens.js';

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

function ymd(d) { return d.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  let tokenInfo;
  try {
    tokenInfo = await getValidAccessToken(user.id);
  } catch (e) {
    return res.status(200).json({ connected: false, needsReconnect: true, error: e.message });
  }

  if (!tokenInfo) return res.status(200).json({ connected: false });

  const { accessToken, row } = tokenInfo;
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  try {
    // 1) Channel snippet + statistics (subscribers, total views, video count, avatar, name)
    const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true', { headers: authHeaders });
    const chData = await chRes.json();
    if (!chRes.ok) throw new Error(chData?.error?.message || 'channel fetch failed');
    const channel = chData.items?.[0];
    if (!channel) throw new Error('no channel found for this account');

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;

    // 2) Recent videos from the uploads playlist
    let recentVideos = [];
    if (uploadsPlaylistId) {
      const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=12`, { headers: authHeaders });
      const plData = await plRes.json();
      if (plRes.ok) {
        const videoIds = (plData.items || []).map(it => it.contentDetails.videoId).filter(Boolean);
        if (videoIds.length) {
          const vRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(',')}`, { headers: authHeaders });
          const vData = await vRes.json();
          if (vRes.ok) {
            recentVideos = (vData.items || []).map(v => ({
              id: v.id,
              title: v.snippet.title,
              thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
              publishedAt: v.snippet.publishedAt,
              views: Number(v.statistics?.viewCount || 0),
              likes: Number(v.statistics?.likeCount || 0),
              comments: Number(v.statistics?.commentCount || 0),
              duration: v.contentDetails?.duration || null,
            }));
          }
        }
      }
    }

    // 3) YouTube Analytics: last 28 days — views, watch time, likes, comments, subs gained
    const end = new Date();
    const start = new Date(); start.setDate(start.getDate() - 28);
    const analyticsUrl = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    analyticsUrl.searchParams.set('ids', 'channel==MINE');
    analyticsUrl.searchParams.set('startDate', ymd(start));
    analyticsUrl.searchParams.set('endDate', ymd(end));
    analyticsUrl.searchParams.set('metrics', 'views,estimatedMinutesWatched,likes,comments,subscribersGained,averageViewDuration');
    const anRes = await fetch(analyticsUrl.toString(), { headers: authHeaders });
    const anData = await anRes.json();

    let last28 = { views: 0, watchTimeMinutes: 0, likes: 0, comments: 0, subscribersGained: 0, averageViewDuration: 0 };
    if (anRes.ok && anData.rows && anData.rows[0]) {
      const [views, mins, likes, comments, subsGained, avgDur] = anData.rows[0];
      last28 = { views, watchTimeMinutes: mins, likes, comments, subscribersGained: subsGained, averageViewDuration: avgDur };
    }

    // 4) Top performing videos in the last 28 days (by views), via YouTube Analytics
    const topUrl = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    topUrl.searchParams.set('ids', 'channel==MINE');
    topUrl.searchParams.set('startDate', ymd(start));
    topUrl.searchParams.set('endDate', ymd(end));
    topUrl.searchParams.set('metrics', 'views,likes,comments,averageViewDuration');
    topUrl.searchParams.set('dimensions', 'video');
    topUrl.searchParams.set('sort', '-views');
    topUrl.searchParams.set('maxResults', '5');
    const topRes = await fetch(topUrl.toString(), { headers: authHeaders });
    const topData = await topRes.json();

    let topVideos = [];
    if (topRes.ok && topData.rows?.length) {
      const ids = topData.rows.map(r => r[0]);
      const metaRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}`, { headers: authHeaders });
      const metaData = await metaRes.json();
      const metaById = Object.fromEntries((metaData.items || []).map(v => [v.id, v.snippet]));
      topVideos = topData.rows.map(r => ({
        id: r[0],
        title: metaById[r[0]]?.title || r[0],
        thumbnail: metaById[r[0]]?.thumbnails?.medium?.url || metaById[r[0]]?.thumbnails?.default?.url,
        views: r[1], likes: r[2], comments: r[3], averageViewDuration: r[4],
      }));
    }

    const totalViews = Number(channel.statistics?.viewCount || 0);
    const totalVideos = Number(channel.statistics?.videoCount || 0);
    const averageViews = totalVideos > 0 ? Math.round(totalViews / totalVideos) : 0;

    return res.status(200).json({
      connected: true,
      channel: {
        id: channel.id,
        title: channel.snippet?.title,
        avatar: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url,
        subscribers: Number(channel.statistics?.subscriberCount || 0),
        subscribersHidden: !!channel.statistics?.hiddenSubscriberCount,
        totalViews,
        totalVideos,
        averageViews,
      },
      recentVideos,
      topVideos,
      last28,
    });
  } catch (e) {
    return res.status(200).json({ connected: true, error: e.message });
  }
}
