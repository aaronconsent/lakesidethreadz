// ============================================================================
// B2B uniform outreach engine — Cloudflare Worker + KV + Resend.
//
// Ported from deuceswildpokertx-mirror/site/functions/api/outreach.js (2026-07).
// Same architecture: 3-touch cold sequence with weekday-only sends, engagement
// auto-enrolls into a monthly seasonal newsletter, one-click unsub, CAN-SPAM
// compliant headers + footer.
//
// Pitch: custom embroidered/DTF uniform program for local East-TX businesses.
//   Touch 1: intro + soft pitch to a decision-maker
//   Touch 2: short follow-up with concrete offer
//   Touch 3: last note — no pressure, keeps the door open
//
// Storage: STATUS KV namespace, keys prefixed "outreach:" / "newsletter:".
//   outreach:prospect:<id>  -> {email,name,org,category,city,status,touches:[{n,ts}],engaged?,engagedAt?,added}
//   outreach:suppress:<email lowercased> -> reason ("unsub"|"bounce"|"complaint")
//   outreach:log:<YYYY-MM-DD> -> {sent:n}
//   newsletter:sub:<email> -> {added,source,name,org}
//   newsletter:content:<YYYY-MM> -> {subject, text}
//   newsletter:sent:<YYYY-MM> -> {sent, skipped, ts}
//
// Sending: Resend API. Deliverability guardrails:
//   DAILY_CAP (default 10), cron only Tue-Fri, 3-touch max, suppression checked
//   before every send, List-Unsubscribe header + CAN-SPAM footer every email.
//
// CTA: /quote (existing 8-step calculator) + phone.
// ============================================================================

const FROM = 'Lakeside Ink & Threadz <hello@lakesidethreadz.com>';
const SITE = 'https://lakesidethreadz.com';
const PHONE_DISPLAY = '(346) 988-5449';
const ADDRESS = 'Lakeside Ink & Threadz, Onalaska, TX 77360';
// Days to wait after the previous touch before the next one goes out.
const TOUCH_GAP_DAYS = [0, 4, 5]; // touch1 immediately, touch2 +4d, touch3 +5d after that

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const authed = (url, env) =>
  env.OUTREACH_KEY && url.searchParams.get('key') === env.OUTREACH_KEY;

// ---------------------------------------------------------------------------
// Email templates — B2B uniform program, short and human, no jargon.
// ---------------------------------------------------------------------------
function renderTouch(n, p, unsubUrl) {
  const org = p.org || 'your team';
  const first = (p.name || '').split(' ')[0] || 'there';
  const category = (p.category || '').toLowerCase();
  // Personalize the second sentence by category when we have one.
  let hook = '';
  if (category.includes('hvac') || category.includes('plumb') || category.includes('electric') || category.includes('roof') || category.includes('landscape')) {
    hook = 'Your crew is the first thing customers see at the job site — a matching embroidered polo or work shirt tells them the pro they hired showed up.';
  } else if (category.includes('marina') || category.includes('boat') || category.includes('lake') || category.includes('fish')) {
    hook = 'Lake-adjacent businesses live and die by looking legit at the dock — matching PFG shirts or embroidered hats set your team apart from the weekend crowd.';
  } else if (category.includes('restaurant') || category.includes('bar') || category.includes('cafe') || category.includes('coffee') || category.includes('food')) {
    hook = 'A branded polo or apron on every server does more brand work than any Instagram post — customers notice, and staff feel like a team.';
  } else if (category.includes('church') || category.includes('ministry')) {
    hook = "Matching shirts for VBS, mission trips, or staff make a Sunday feel intentional — and they're cheaper per piece than you'd think.";
  } else if (category.includes('real estate') || category.includes('realtor') || category.includes('property')) {
    hook = 'Branded polos at open houses and closings turn every showing into a soft advertisement — clients remember the agent who looked like a pro.';
  } else {
    hook = 'Matching branded apparel on your team quietly reinforces your brand on every job, every event, every day.';
  }

  const bodies = {
    1: {
      subject: `Custom uniforms for ${org}?`,
      text:
`Hi ${first},

We run Lakeside Ink & Threadz — a custom embroidery and DTF printing shop here in Onalaska, serving businesses around Lake Livingston and East Texas.

${hook}

We do no-minimum orders (embroider one polo or fifty), free digital proofs before any production starts, and a text-message reorder program so once your logo is on file, restocking is a one-text conversation. Volume discounts start at 12 pieces (8% off) and drop to 25% off at 100+.

If ${org} could use a small uniform program — or just wants to see what your logo looks like on a real polo — the fastest way is our instant calculator (${SITE}/quote — under 60 seconds for a real price) or just reply here.

Or call/text ${PHONE_DISPLAY} — we usually pick up.

Lakeside Ink & Threadz
Onalaska, TX`,
    },
    2: {
      subject: `Re: Custom uniforms for ${org}?`,
      text:
`Hi ${first},

Quick follow-up — the short version:

- Free digital proof of your logo on the exact garment before you commit
- No minimums, real volume discounts once you cross 12 pieces
- One-time $45 digitizing fee, then reorders are one text away
- 5-10 business day turnaround; rush available if the deadline's tight

Instant price: ${SITE}/quote
Or text ${PHONE_DISPLAY} with a rough count and I'll get you a number today.

Lakeside Ink & Threadz`,
    },
    3: {
      subject: `Last note from Lakeside`,
      text:
`Hi ${first},

Last note from us — no bad feelings if uniforms aren't on the roadmap right now. The offer doesn't expire: whenever ${org} is ready, one text or a 60-second quote at ${SITE}/quote gets you a price.

We also do church/ministry apparel, fishing tournament kits, wedding party gifts, and one-off custom pieces — same free-proof, no-minimum treatment.

${PHONE_DISPLAY} · ${SITE}

Lakeside Ink & Threadz
Onalaska, TX`,
    },
  };
  const b = bodies[n];
  return {
    subject: b.subject,
    text: `${b.text}

—
${ADDRESS}
Don't want these? Unsubscribe: ${unsubUrl}`,
  };
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------
async function listProspects(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.STATUS.list({ prefix: 'outreach:prospect:', cursor });
    for (const k of res.keys) {
      const v = await env.STATUS.get(k.name, 'json');
      if (v) out.push({ _key: k.name, ...v });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

const suppressed = (env, email) => env.STATUS.get('outreach:suppress:' + email.toLowerCase());

// ---------------------------------------------------------------------------
// The nightly sender — invoked from worker.js scheduled().
// ---------------------------------------------------------------------------
export async function runOutreach(env) {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY.startsWith('REPLACE')) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const cap = parseInt(env.DAILY_CAP || '10', 10);
  const today = new Date().toISOString().slice(0, 10);
  const log = (await env.STATUS.get('outreach:log:' + today, 'json')) || { sent: 0 };
  if (log.sent >= cap) return { ok: true, sent: 0, note: 'daily cap reached' };

  const prospects = await listProspects(env);
  const now = Date.now();
  let sent = 0;
  const results = [];

  for (const p of prospects) {
    if (log.sent + sent >= cap) break;
    if (p.status !== 'active') continue;
    if (!p.email || !p.email.includes('@')) continue;
    if (await suppressed(env, p.email)) continue;

    const touches = p.touches || [];
    const nextN = touches.length + 1;
    if (nextN > 3) continue;
    const gapMs = TOUCH_GAP_DAYS[nextN - 1] * 86400 * 1000;
    const lastTs = touches.length ? touches[touches.length - 1].ts : p.added || 0;
    if (touches.length && now - lastTs < gapMs) continue;

    const unsubUrl = `${SITE}/api/outreach/unsub?e=${btoa(p.email.toLowerCase())}`;
    const msg = renderTouch(nextN, p, unsubUrl);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [p.email],
        reply_to: env.OUTREACH_REPLY_TO || undefined,
        subject: msg.subject,
        text: msg.text,
        headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
      }),
    });

    if (r.ok) {
      touches.push({ n: nextN, ts: now });
      const status = nextN >= 3 ? 'done' : 'active';
      const { _key, ...rest } = p;
      await env.STATUS.put(_key, JSON.stringify({ ...rest, touches, status }));
      sent++;
      results.push({ email: p.email, touch: nextN });
    } else {
      const err = await r.text().catch(() => '');
      results.push({ email: p.email, error: err.slice(0, 120) });
      if (r.status === 422 || r.status === 400) {
        // hard reject — suppress so we never retry a bad address
        await env.STATUS.put('outreach:suppress:' + p.email.toLowerCase(), 'bounce');
      }
    }
  }

  await env.STATUS.put('outreach:log:' + today, JSON.stringify({ sent: log.sent + sent }));
  return { ok: true, sent, results };
}

// ---------------------------------------------------------------------------
// HTTP handlers (wired in worker.js)
// ---------------------------------------------------------------------------

// POST /api/outreach/prospects?key=…  body: {prospects:[{email,name,org,category,city}]}
export async function prospectsPost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.prospects)) return json({ error: 'prospects[] required' }, 400);
  let added = 0, skipped = 0;
  for (const p of body.prospects) {
    if (!p.email || !p.email.includes('@')) { skipped++; continue; }
    const id = p.email.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const key = 'outreach:prospect:' + id;
    if (await env.STATUS.get(key)) { skipped++; continue; } // no dupes
    await env.STATUS.put(key, JSON.stringify({
      email: p.email.trim(), name: p.name || '', org: p.org || '', category: p.category || '',
      city: p.city || '', status: 'active', touches: [], added: Date.now(),
    }));
    added++;
  }
  return json({ ok: true, added, skipped });
}

// GET /api/outreach/stats?key=…
export async function statsGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const prospects = await listProspects(env);
  const by = (f) => prospects.reduce((a, p) => ((a[f(p)] = (a[f(p)] || 0) + 1), a), {});
  const today = new Date().toISOString().slice(0, 10);
  const log = (await env.STATUS.get('outreach:log:' + today, 'json')) || { sent: 0 };
  return json({
    total: prospects.length,
    by_status: by((p) => p.status),
    by_touches: by((p) => (p.touches || []).length),
    sent_today: log.sent,
  });
}

// GET /api/outreach/run?key=…  (manual trigger, same as cron)
export async function runGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  return json(await runOutreach(env));
}

// GET /api/outreach/unsub?e=<b64 email>  (public — one-click, no confirmation step)
export async function unsubGet({ request, env }) {
  const url = new URL(request.url);
  let email = '';
  try { email = atob(url.searchParams.get('e') || '').toLowerCase(); } catch (e) { /* fall through */ }
  if (email && email.includes('@')) {
    await env.STATUS.put('outreach:suppress:' + email, 'unsub');
    await env.STATUS.delete('newsletter:sub:' + email);
    const id = email.replace(/[^a-z0-9]/g, '-');
    const key = 'outreach:prospect:' + id;
    const p = await env.STATUS.get(key, 'json');
    if (p) await env.STATUS.put(key, JSON.stringify({ ...p, status: 'unsubscribed' }));
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:sans-serif;background:#001E78;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:2rem"><h1 style="color:#F09600">You're unsubscribed.</h1><p>No more emails from Lakeside Ink &amp; Threadz.</p><p style="opacity:.7;font-size:.9rem;margin-top:2rem">If this was a mistake, email hello@lakesidethreadz.com and we'll fix it.</p></div>`,
    { headers: { 'Content-Type': 'text/html' } },
  );
}

// POST /api/outreach/webhook?key=…  (Resend events webhook)
// bounces/complaints -> suppress; opens/clicks -> mark engaged + auto-subscribe
// to the seasonal newsletter (newsletter:sub:<email>).
export async function webhookPost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const evt = await request.json().catch(() => null);
  const type = evt && evt.type;
  const email = ((evt && evt.data && evt.data.to && evt.data.to[0]) || '').toLowerCase();
  if (!email) return json({ ok: true });

  if (type === 'email.bounced' || type === 'email.complained') {
    await env.STATUS.put('outreach:suppress:' + email,
      type === 'email.bounced' ? 'bounce' : 'complaint');
    await env.STATUS.delete('newsletter:sub:' + email);
  }

  if (type === 'email.opened' || type === 'email.clicked') {
    if (!(await suppressed(env, email))) {
      const signal = type === 'email.clicked' ? 'click' : 'open';
      const id = email.replace(/[^a-z0-9]/g, '-');
      const pKey = 'outreach:prospect:' + id;
      const p = await env.STATUS.get(pKey, 'json');
      if (p && !p.engaged) await env.STATUS.put(pKey, JSON.stringify({ ...p, engaged: signal, engagedAt: Date.now() }));
      const sKey = 'newsletter:sub:' + email;
      const existing = await env.STATUS.get(sKey, 'json');
      if (!existing || (existing.source === 'open' && signal === 'click')) {
        await env.STATUS.put(sKey, JSON.stringify({ added: Date.now(), source: signal, name: (p && p.name) || '', org: (p && p.org) || '' }));
      }
    }
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Monthly seasonal newsletter — auto-sent to engaged prospects.
// Content is set per-month via contentPost (newsletter:content:<YYYY-MM>);
// if no issue was drafted, a seasonal-fallback template is used based on month.
// ---------------------------------------------------------------------------
function fallbackIssue(monthYYYYMM) {
  // Month 1-12; picks a seasonal focus with an evergreen tail so we're never
  // sending a totally-generic email even if the current issue wasn't drafted.
  const month = parseInt(monthYYYYMM.split('-')[1], 10);
  const seasons = {
    1: { subj: 'Uniform refresh for the new year?', body:
`January is when the smart operators quietly redo their team's look for the year:

• Refresh embroidered polos, work shirts, or hats before the busy season
• Add new hires to the standard uniform program
• Restock branded totes for events, trade shows, and giveaways

Reply or run a quick estimate at ${SITE}/quote — takes under a minute.` },
    2: { subj: 'Spring tournament + event apparel', body:
`Bass and crappie tournament season is warming up on Lake Livingston, and spring event calendars fill up fast. Now's the time to order:

• Tournament team kits with sponsor patches
• Spring festival, farmers market, and outdoor event tees
• Fresh business polos for the busy season

Quick quote: ${SITE}/quote` },
    3: { subj: 'Spring uniform + team apparel', body:
`Spring is when service crews swap out worn winter gear. If you're ordering fresh polos, hats, or work shirts, get in front of the rush:

• Restock existing uniform programs
• Add rain jackets and lightweight polos for warmer weather
• Team logos on new employees' first-day kits

${SITE}/quote — 60 seconds for a real number.` },
    4: { subj: 'Wedding + graduation season is here', body:
`April kicks off wedding and graduation season. We've got you covered:

• Bridal-party robes and monogrammed totes
• Groomsmen polos and custom Koozies
• Class shirts, senior-week tees, and grad-party gifts

${SITE}/quote for a fast estimate.` },
    5: { subj: 'VBS + summer camp shirts', body:
`Vacation Bible School and summer camps kick off in June and July — May is the right month to lock in your shirt order:

• VBS shirts for kids + volunteers
• Camp counselor polos and staff hats
• Ministry team gear for mission trips

Order 3 weeks before your event for a stress-free timeline. Rush available at +25%.

${SITE}/quote` },
    6: { subj: 'Summer tournament + lake apparel', body:
`Fishing tournaments, lake festivals, and summer events are in full swing. We're shipping:

• Tournament team kits (Columbia PFG, Huk, AFTCO) with sponsor patches
• Lake business branded apparel (marinas, guides, dock builders)
• Summer event polos and tees

${SITE}/quote for a fast estimate.` },
    7: { subj: 'Back-to-school + fall sports prep', body:
`It's not too early to think about fall:

• Back-to-school team shirts and coach polos
• Fall sports uniforms (order 4 weeks before season)
• Business uniform refresh before Q4

Get ahead of the fall rush: ${SITE}/quote` },
    8: { subj: 'Fall sports uniforms — last call', body:
`Fall football, volleyball, and cross-country seasons start in a few weeks. If you're a team or coach still needing:

• Custom team uniforms with player numbers ($3/pc)
• Coach polos and staff hats
• Booster club fan gear

Order this week to guarantee delivery before Week 1. ${SITE}/quote` },
    9: { subj: 'Company holiday gifts (yes, already)', body:
`September is when smart businesses start their holiday gifting order — good vendors book up by mid-November:

• Client thank-you gifts (monogrammed totes, custom Koozies)
• Employee holiday gift bundles (embroidered jackets, gift-boxed apparel)
• Custom promo items for holiday parties

${SITE}/quote — early birds get their pick of blank styles.` },
    10: { subj: 'Holiday embroidery + branded gifts', body:
`October = last comfortable window for holiday orders. Coming up:

• Custom company Christmas gifts for staff and clients
• Church holiday event apparel (Christmas, Advent, Living Nativity)
• Winter uniform additions — jackets, beanies, long-sleeve tees

${SITE}/quote before the rush.` },
    11: { subj: 'Deadline: December orders', body:
`If you need embroidered or DTF-printed apparel in your hands before Christmas, the order needs to be in by early December. Slots go fast this month:

• Company gifts for the holiday party
• Church volunteer appreciation
• Family-branded holiday shirts

Text ${PHONE_DISPLAY} or fire up ${SITE}/quote to lock in a slot.` },
    12: { subj: 'Ordering for the new year?', body:
`January is uniform-refresh season. Getting your quote in the last week of December means production starts on day one and you have your team looking sharp before the busy season.

• Full uniform program setups (one-time $45 digitizing, then one-text reorders)
• New employee gear kits
• Fresh branded merch for Q1 events

${SITE}/quote` },
  }[month] || seasons[1];
  return { subject: seasons.subj, text: seasons.body + `\n\nOr call/text ${PHONE_DISPLAY} — we usually pick up.\n\nLakeside Ink & Threadz` };
}

export async function runNewsletter(env) {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY.startsWith('REPLACE')) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (await env.STATUS.get('newsletter:sent:' + month)) {
    return { ok: true, sent: 0, note: 'already sent this month' };
  }
  const issue = (await env.STATUS.get('newsletter:content:' + month, 'json')) || fallbackIssue(month);

  const subs = [];
  let cursor;
  do {
    const res = await env.STATUS.list({ prefix: 'newsletter:sub:', cursor });
    for (const k of res.keys) subs.push(k.name.slice('newsletter:sub:'.length));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  let sent = 0, skipped = 0;
  for (const email of subs) {
    if (await suppressed(env, email)) { skipped++; continue; }
    const unsubUrl = `${SITE}/api/outreach/unsub?e=${btoa(email)}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        reply_to: env.OUTREACH_REPLY_TO || undefined,
        subject: issue.subject,
        text: `${issue.text}

—
${ADDRESS}
Unsubscribe: ${unsubUrl}`,
        headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
      }),
    });
    if (r.ok) sent++;
  }
  await env.STATUS.put('newsletter:sent:' + month, JSON.stringify({ sent, skipped, ts: Date.now() }));
  return { ok: true, sent, skipped, subscribers: subs.length };
}

// POST /api/newsletter/content?key=…  body: {subject, text, month?} (month defaults to current)
export async function newsletterContentPost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const b = await request.json().catch(() => null);
  if (!b || !b.subject || !b.text) return json({ error: 'subject + text required' }, 400);
  const month = b.month || new Date().toISOString().slice(0, 7);
  await env.STATUS.put('newsletter:content:' + month, JSON.stringify({ subject: b.subject, text: b.text }));
  return json({ ok: true, month });
}

// GET /api/newsletter/stats?key=…
export async function newsletterStatsGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const subs = [];
  let cursor;
  do {
    const res = await env.STATUS.list({ prefix: 'newsletter:sub:', cursor });
    for (const k of res.keys) subs.push(k.name.slice('newsletter:sub:'.length));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  const month = new Date().toISOString().slice(0, 7);
  return json({
    subscribers: subs.length,
    list: subs,
    sent_this_month: await env.STATUS.get('newsletter:sent:' + month, 'json'),
    content_ready: !!(await env.STATUS.get('newsletter:content:' + month)),
  });
}

// GET /api/newsletter/run?key=…  (manual trigger)
export async function newsletterRunGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  return json(await runNewsletter(env));
}
