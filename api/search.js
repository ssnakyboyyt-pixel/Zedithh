// api/search.js
// Vercel Serverless Function — runs on the server, never in the browser.
// Performs a REAL web search using the Tavily API (https://tavily.com) and
// returns a list of real results with real URLs. Keeps the API key secret
// on the server side.
//
// Requires env var: TAVILY_API_KEY
// Get a free key at https://app.tavily.com (generous free tier, built for
// LLM/agent use — good long-term fit for this app).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, max_results = 5 } = req.body || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Server has no search provider key configured (TAVILY_API_KEY)' });
  }

  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        include_answer: false,
        max_results: Math.min(Math.max(Number(max_results) || 5, 1), 10),
      }),
    });

    if (!r.ok) {
      let bodyText = '';
      try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
      return res.status(200).json({ results: [], error: `tavily: HTTP ${r.status} ${bodyText}` });
    }

    const data = await r.json();
    const results = (data?.results || []).map(item => ({
      title: item.title || item.url,
      url: item.url,
      snippet: (item.content || '').slice(0, 500),
    })).filter(item => item.url);

    // Pre-built context block the client can drop straight into a system/user
    // message so the model is grounded in REAL results instead of guessing.
    // This is what actually fixes "hallucinated sources" — the model never
    // has to invent a URL because real ones are already in its context.
    const searchContext = results.length
      ? `Web search results for "${query}" (use ONLY these sources; cite the URL for any fact you use; if these don't answer the question, say so instead of guessing):\n\n` +
        results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
      : `Web search for "${query}" returned no results. Tell the user you couldn't find current information rather than guessing.`;

    return res.status(200).json({ results, query, searchContext });
  } catch (e) {
    return res.status(200).json({ results: [], error: 'network error: ' + e.message });
  }
}
