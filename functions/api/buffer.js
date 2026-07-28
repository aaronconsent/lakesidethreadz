// ============================================================================
// Buffer autopost — pushes new blog posts from /blog/feed.xml into the
// user's Buffer queue via the Buffer v1 API.
//
// Trigger:
//   POST /api/buffer/sync?key=<OUTREACH_KEY>   (manual / from blog agent)
//   scheduled event with cron "17 */2 * * *"   (belt-and-suspenders every 2h)
//
// Requires Worker secret:
//   BUFFER_ACCESS_TOKEN  — Buffer personal access token from
//                          https://publish.buffer.com/account/apps
//
// KV state:
//   buffer:posted:<guid>  -> {ts, profileIds:[...], updateIds:[...]}
//     Prevents double-posting on retry / cron re-run.
// ============================================================================

const BUFFER_BASE = 'https://api.bufferapp.com/1';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const authed = (url, env) =>
  env.OUTREACH_KEY && url.searchParams.get('key') === env.OUTREACH_KEY;

// -----------------------------------------------------------------------------
// Parse /blog/feed.xml into [{guid, link, title, description, category, pubDate, image}]
// -----------------------------------------------------------------------------
function parseFeed(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const get = (block, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
    return m ? decodeXML(m[1].trim()) : '';
  };
  const attr = (block, tag, name) => {
    const re = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`);
    const m = re.exec(block);
    return m ? m[1] : '';
  };
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const b = m[1];
    items.push({
      title: get(b, 'title'),
      link: get(b, 'link'),
      guid: get(b, 'guid') || get(b, 'link'),
      description: get(b, 'description'),
      category: get(b, 'category'),
      pubDate: get(b, 'pubDate'),
      image: attr(b, 'enclosure', 'url'),
    });
  }
  return items;
}

function decodeXML(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// -----------------------------------------------------------------------------
// Compose channel-appropriate copy. Skips emojis per brand preference.
// -----------------------------------------------------------------------------
function composeCopy(item, service) {
  const url = item.link;
  const title = item.title;
  const desc = item.description;
  switch ((service || '').toLowerCase()) {
    case 'twitter': {
      // 280 chars total. Leave room for URL (t.co ~23) + space.
      const room = 280 - 24;
      let text = title;
      if (text.length > room) text = text.slice(0, room - 1) + '…';
      return `${text} ${url}`;
    }
    case 'facebook':
    case 'facebookgroup':
    case 'facebookpage': {
      return `${title}\n\n${desc}\n\n${url}`;
    }
    case 'linkedin':
    case 'linkedin_business':
    case 'linkedin_page': {
      return `${title}\n\n${desc}\n\nRead the full playbook: ${url}\n\n— Kristen at Lakeside Ink & Threadz, Onalaska TX`;
    }
    case 'pinterest': {
      // Pinterest description shows well; keep <= 500 chars.
      let d = desc;
      if (d.length > 480) d = d.slice(0, 479) + '…';
      return `${title}\n\n${d}`;
    }
    case 'instagram': {
      return `${title}\n\n${desc}\n\nLink in bio → lakesidethreadz.com/blog`;
    }
    default:
      return `${title}\n\n${desc}\n\n${url}`;
  }
}

// -----------------------------------------------------------------------------
// Buffer API helpers
// -----------------------------------------------------------------------------
async function bufferProfiles(token) {
  const r = await fetch(`${BUFFER_BASE}/profiles.json?access_token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`profiles ${r.status}: ${await r.text()}`);
  return r.json();
}

async function bufferCreateUpdate(token, item, profile) {
  const text = composeCopy(item, profile.service);
  const params = new URLSearchParams();
  params.set('access_token', token);
  params.append('profile_ids[]', profile.id);
  params.set('text', text);
  params.set('shorten', 'false');
  // Attach OG image as the update's media. Buffer displays it as the card.
  if (item.image) {
    params.set('media[link]', item.link);
    params.set('media[picture]', item.image);
    params.set('media[thumbnail]', item.image);
    params.set('media[title]', item.title);
    params.set('media[description]', item.description);
  }
  const r = await fetch(`${BUFFER_BASE}/updates/create.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`update ${r.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return { raw: body }; }
}

// -----------------------------------------------------------------------------
// Core sync — invoked from HTTP handler + scheduled().
// -----------------------------------------------------------------------------
export async function runBufferSync(env, opts = {}) {
  if (!env.BUFFER_ACCESS_TOKEN) {
    return { ok: false, error: 'BUFFER_ACCESS_TOKEN not set' };
  }
  if (!env.STATUS) {
    return { ok: false, error: 'STATUS KV not bound' };
  }
  const dryRun = !!opts.dryRun;

  // 1. Fetch feed from same origin via assets.
  const feedRes = await env.ASSETS.fetch(new Request('https://lakesidethreadz.com/blog/feed.xml'));
  if (!feedRes.ok) return { ok: false, error: `feed fetch ${feedRes.status}` };
  const xml = await feedRes.text();
  const items = parseFeed(xml);

  // 2. Filter to unposted.
  const fresh = [];
  for (const it of items) {
    const key = `buffer:posted:${it.guid}`;
    const seen = await env.STATUS.get(key);
    if (!seen) fresh.push(it);
  }
  if (!fresh.length) return { ok: true, posted: 0, feed_items: items.length, note: 'nothing new' };

  // 3. Fetch profiles once.
  let profiles;
  try {
    profiles = await bufferProfiles(env.BUFFER_ACCESS_TOKEN);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!Array.isArray(profiles) || !profiles.length) {
    return { ok: false, error: 'no Buffer profiles connected' };
  }

  // 4. Post each fresh item to every profile. Mark KV even on partial failure
  //    so we don't double-post the succeeded profiles on retry.
  const results = [];
  for (const it of fresh) {
    const perProfile = [];
    for (const p of profiles) {
      try {
        if (dryRun) {
          perProfile.push({ profile: p.service, id: p.id, dryRun: true });
        } else {
          const r = await bufferCreateUpdate(env.BUFFER_ACCESS_TOKEN, it, p);
          perProfile.push({ profile: p.service, id: p.id, ok: true, updateId: (r.updates && r.updates[0] && r.updates[0].id) || null });
        }
      } catch (e) {
        perProfile.push({ profile: p.service, id: p.id, ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }
    if (!dryRun) {
      await env.STATUS.put(
        `buffer:posted:${it.guid}`,
        JSON.stringify({ ts: Date.now(), title: it.title, results: perProfile }),
        { expirationTtl: 60 * 60 * 24 * 365 },
      );
    }
    results.push({ guid: it.guid, title: it.title, perProfile });
  }
  return { ok: true, posted: fresh.length, feed_items: items.length, profiles: profiles.length, dryRun, results };
}

// -----------------------------------------------------------------------------
// HTTP handler — admin-gated by OUTREACH_KEY.
// GET  /api/buffer/sync?key=...&dry=1   preview
// POST /api/buffer/sync?key=...         actually post
// -----------------------------------------------------------------------------
export async function bufferSyncHandler({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const dryRun = request.method === 'GET' || url.searchParams.get('dry') === '1';
  const out = await runBufferSync(env, { dryRun });
  return json(out, out.ok ? 200 : 500);
}
