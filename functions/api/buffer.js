// ============================================================================
// Buffer autopost — pushes new blog posts from /blog/feed.xml into the user's
// Buffer queue via the Buffer GraphQL API (https://api.buffer.com/graphql).
//
// Trigger:
//   POST /api/buffer/sync?key=<OUTREACH_KEY>         (manual / from blog agent)
//   GET  /api/buffer/sync?key=<OUTREACH_KEY>&dry=1   (preview, no writes)
//   scheduled cron "17 */2 * * *"                    (belt-and-suspenders 2h)
//
// Requires Worker secret:
//   BUFFER_ACCESS_TOKEN  — Buffer personal access token from the developer
//                          console (https://developers.buffer.com/). This
//                          works ONLY with the new GraphQL API; the legacy
//                          REST API rejects "public API tokens".
//
// KV state:
//   buffer:v2:posted:<guid>  -> {ts, results:[{channel, service, ok, postId, error?}]}
//     Prevents double-posting on retry or cron re-run.
// ============================================================================

const GRAPHQL_URL = 'https://api.buffer.com/graphql';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const authed = (url, env) =>
  env.OUTREACH_KEY && url.searchParams.get('key') === env.OUTREACH_KEY;

// -----------------------------------------------------------------------------
// GraphQL helper.
// -----------------------------------------------------------------------------
async function gql(token, query, variables = {}) {
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`buffer ${r.status}: ${body.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error(`buffer non-JSON: ${body.slice(0, 300)}`); }
  if (parsed.errors && parsed.errors.length) {
    throw new Error(`buffer graphql: ${parsed.errors.map(e => e.message).join('; ').slice(0, 300)}`);
  }
  return parsed.data;
}

// -----------------------------------------------------------------------------
// Feed parsing — /blog/feed.xml → [{title, link, guid, description, image, category}]
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
// Per-service copy. No emojis (brand preference).
// -----------------------------------------------------------------------------
function composeCopy(item, service) {
  const url = item.link;
  const title = item.title;
  const desc = item.description;
  switch ((service || '').toLowerCase()) {
    case 'twitter': {
      const room = 280 - 24; // leave room for t.co URL
      let text = title;
      if (text.length > room) text = text.slice(0, room - 1) + '…';
      return `${text} ${url}`;
    }
    case 'facebook':
      return `${title}\n\n${desc}\n\n${url}`;
    case 'linkedin':
      return `${title}\n\n${desc}\n\nRead the full playbook: ${url}\n\n— Kristen at Lakeside Ink & Threadz, Onalaska TX`;
    case 'pinterest': {
      let d = desc;
      if (d.length > 480) d = d.slice(0, 479) + '…';
      return `${title}\n\n${d}`;
    }
    case 'instagram':
      return `${title}\n\n${desc}\n\nLink in bio → lakesidethreadz.com/blog`;
    case 'googlebusiness':
      // GBP truncates hard at ~1500 chars, prefers concise + link.
      return `${title}\n\n${desc}\n\nRead more: ${url}`;
    default:
      return `${title}\n\n${desc}\n\n${url}`;
  }
}

// -----------------------------------------------------------------------------
// GraphQL queries & mutation.
// -----------------------------------------------------------------------------
const Q_ACCOUNT = `{ account { id organizations { id name } } }`;

const Q_CHANNELS = `
  query($input: ChannelsInput!) {
    channels(input: $input) { id name service serviceId }
  }
`;

// PostActionPayload union: PostActionSuccess | NotFoundError | UnauthorizedError
//   | UnexpectedError | RestProxyError | ValidationError (…).
// All error branches carry a `message` field, so we destructure via a common
// inline fragment on Error interface + specific fragment for success.
const M_CREATE_POST = `
  mutation($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess { post { id status createdAt } }
      ... on NotFoundError { message }
      ... on UnauthorizedError { message }
      ... on UnexpectedError { message }
      ... on RestProxyError { message }
      ... on ValidationError { message }
    }
  }
`;

async function createBufferPost(token, channel, item) {
  const text = composeCopy(item, channel.service);
  const assets = [];
  if (item.link) {
    assets.push({
      link: {
        url: item.link,
        title: item.title,
        description: item.description,
        thumbnailUrl: item.image || undefined,
      },
    });
  }
  const input = {
    channelId: channel.id,
    text,
    assets,
    mode: 'addToQueue',
    schedulingType: 'automatic',
  };
  const data = await gql(token, M_CREATE_POST, { input });
  const r = data.createPost;
  if (r && r.post && r.post.id) return { ok: true, postId: r.post.id, status: r.post.status };
  return { ok: false, error: (r && (r.userFriendlyMessage || r.message)) || 'unknown createPost response' };
}

// -----------------------------------------------------------------------------
// Core sync — invoked from HTTP handler + scheduled().
// -----------------------------------------------------------------------------
export async function runBufferSync(env, opts = {}) {
  if (!env.BUFFER_ACCESS_TOKEN) return { ok: false, error: 'BUFFER_ACCESS_TOKEN not set' };
  if (!env.STATUS) return { ok: false, error: 'STATUS KV not bound' };
  const dryRun = !!opts.dryRun;
  const token = env.BUFFER_ACCESS_TOKEN;

  // 1. Feed.
  const feedRes = await env.ASSETS.fetch(new Request('https://lakesidethreadz.com/blog/feed.xml'));
  if (!feedRes.ok) return { ok: false, error: `feed fetch ${feedRes.status}` };
  const items = parseFeed(await feedRes.text());

  // 2. Unposted.
  const fresh = [];
  for (const it of items) {
    const seen = await env.STATUS.get(`buffer:v2:posted:${it.guid}`);
    if (!seen) fresh.push(it);
  }
  if (!fresh.length) return { ok: true, posted: 0, feed_items: items.length, note: 'nothing new' };

  // 3. Org + channels.
  let acct, channels;
  try {
    acct = await gql(token, Q_ACCOUNT);
    const orgId = acct && acct.account && acct.account.organizations && acct.account.organizations[0] && acct.account.organizations[0].id;
    if (!orgId) return { ok: false, error: 'no Buffer organization on account' };
    const ch = await gql(token, Q_CHANNELS, { input: { organizationId: orgId } });
    channels = ch.channels || [];
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!channels.length) return { ok: false, error: 'no Buffer channels connected' };

  // 4. Post each fresh item to every channel.
  const results = [];
  for (const it of fresh) {
    const perChannel = [];
    for (const ch of channels) {
      try {
        if (dryRun) {
          perChannel.push({ channel: ch.name, service: ch.service, dryRun: true, preview: composeCopy(it, ch.service).slice(0, 140) });
        } else {
          const r = await createBufferPost(token, ch, it);
          perChannel.push({ channel: ch.name, service: ch.service, ...r });
        }
      } catch (e) {
        perChannel.push({ channel: ch.name, service: ch.service, ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }
    // Only stamp KV if at least one channel succeeded — if every channel
    // failed we want cron to retry this item next run instead of skipping
    // it forever. Partial success is still marked (per-channel retry would
    // require per-channel keys; not worth the complexity right now).
    const anySuccess = perChannel.some(r => r.ok === true);
    if (!dryRun && anySuccess) {
      await env.STATUS.put(
        `buffer:v2:posted:${it.guid}`,
        JSON.stringify({ ts: Date.now(), title: it.title, results: perChannel }),
        { expirationTtl: 60 * 60 * 24 * 365 },
      );
    }
    results.push({ guid: it.guid, title: it.title, perChannel, marked: !dryRun && anySuccess });
  }
  return {
    ok: true,
    posted: fresh.length,
    feed_items: items.length,
    channels: channels.map(c => ({ name: c.name, service: c.service })),
    dryRun,
    results,
  };
}

// -----------------------------------------------------------------------------
// HTTP handler — admin-gated by OUTREACH_KEY.
// GET  /api/buffer/sync?key=...&dry=1   preview
// POST /api/buffer/sync?key=...         actually post
// -----------------------------------------------------------------------------
export async function bufferSyncHandler({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);

  // ?reset=1 clears every buffer:v2:posted:* key so the next sync retries every
  // item. Use this once after fixing a mutation bug that stamped failures as
  // posted; otherwise let cron handle steady state.
  if (url.searchParams.get('reset') === '1' && env.STATUS) {
    let deleted = 0;
    let cursor;
    do {
      const res = await env.STATUS.list({ prefix: 'buffer:v2:posted:', cursor });
      for (const k of res.keys) { await env.STATUS.delete(k.name); deleted++; }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
    return json({ ok: true, reset: true, deleted });
  }

  const dryRun = request.method === 'GET' || url.searchParams.get('dry') === '1';
  const out = await runBufferSync(env, { dryRun });
  return json(out, out.ok ? 200 : 500);
}
