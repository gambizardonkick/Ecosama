/**
 * Vercel serverless function: live posts from X for @616019.
 *
 * Why this exists: X's client-side timeline widget (platform.twitter.com/widgets.js)
 * no longer renders public profile timelines — the endpoint it calls returns an empty
 * body, and publish.twitter.com/oembed redirects to an error page. The syndication
 * endpoint below still works, but only server-side, so we proxy it here.
 *
 * Caveat: this is X's undocumented syndication endpoint, not the official API. It
 * currently returns the latest post plus the pinned post (2 max) and could change
 * without notice. The frontend degrades to a "view on X" link if this fails.
 */

const https = require('https');

const SCREEN_NAME = '616019';
const SOURCE = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${SCREEN_NAME}?dnt=true&lang=en`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Use the https module rather than global fetch. Cloudflare (which fronts this
 * endpoint) buckets undici's connection fingerprint as a bot and returns 429
 * with x-rate-limit-remaining: 0, while an https.request from the same process,
 * same IP and same headers gets 200 with quota to spare. Verified side by side.
 */
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      timeout: 8000,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects < 3) {
        res.resume();
        return resolve(get(new URL(headers.location, url).toString(), redirects + 1));
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: statusCode, body }));
    });

    req.on('timeout', () => req.destroy(new Error('upstream timed out')));
    req.on('error', reject);
    req.end();
  });
}

function buildText(tweet) {
  let text = tweet.full_text || tweet.text || '';
  const links = [];

  // Drop the trailing t.co that just points at the attached media.
  const media = (tweet.extended_entities && tweet.extended_entities.media)
    || (tweet.entities && tweet.entities.media) || [];
  for (const m of media) {
    if (m.url) text = text.split(m.url).join('');
  }

  // Swap t.co shorteners for their readable form.
  const urls = (tweet.entities && tweet.entities.urls) || [];
  for (const u of urls) {
    if (!u.url) continue;
    text = text.split(u.url).join(u.display_url);
    links.push({ display: u.display_url, href: u.expanded_url });
  }

  return { text: text.replace(/\s+\n/g, '\n').trim(), links };
}

function shapeMedia(tweet) {
  const media = (tweet.extended_entities && tweet.extended_entities.media)
    || (tweet.entities && tweet.entities.media) || [];

  return media.slice(0, 4).map((m) => ({
    type: m.type === 'animated_gif' ? 'gif' : m.type,
    thumb: m.media_url_https,
    width: m.original_info && m.original_info.width,
    height: m.original_info && m.original_info.height,
  })).filter((m) => m.thumb);
}

function shapeTweet(tweet) {
  if (!tweet || !tweet.id_str) return null;
  const { text, links } = buildText(tweet);

  return {
    id: tweet.id_str,
    text,
    links,
    media: shapeMedia(tweet),
    created_at: tweet.created_at,
    url: tweet.permalink
      ? `https://x.com${tweet.permalink}`
      : `https://x.com/${SCREEN_NAME}/status/${tweet.id_str}`,
    likes: tweet.favorite_count || 0,
    replies: tweet.reply_count || 0,
    reposts: tweet.retweet_count || 0,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const upstream = await get(SOURCE);
    if (upstream.status !== 200) throw new Error(`upstream responded ${upstream.status}`);

    const html = upstream.body;
    const blob = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!blob) throw new Error('timeline payload not found in response');

    const data = JSON.parse(blob[1]);
    const pageProps = (data.props && data.props.pageProps) || {};
    const entries = (pageProps.timeline && pageProps.timeline.entries) || [];

    const posts = entries
      .filter((e) => e.type === 'tweet' && e.content && e.content.tweet)
      .map((e) => shapeTweet(e.content.tweet))
      .filter(Boolean);

    const author = entries.find((e) => e.content && e.content.tweet && e.content.tweet.user);
    const u = author ? author.content.tweet.user : null;

    // Poll X at most once per 10 min per region; keep serving the last good copy
    // for an hour while revalidating, and for a day if X starts failing.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600, stale-if-error=86400');

    return res.status(200).json({
      ok: true,
      user: u ? {
        name: u.name,
        screen_name: u.screen_name,
        // _normal is 48px; _400x400 is the full-size crop.
        avatar: (u.profile_image_url_https || '').replace('_normal', '_400x400'),
        followers: u.followers_count,
      } : null,
      posts,
    });
  } catch (err) {
    // Fail with a real error status and no-store, so the CDN keeps serving the
    // last good payload (stale-if-error) instead of caching this failure.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, error: String((err && err.message) || err), posts: [] });
  }
};
