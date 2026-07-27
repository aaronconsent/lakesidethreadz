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

// From = the owner's real name — 2-3× higher open + reply rate on cold vs a
// generic business-name From. Reply-to defaults to the same address so replies
// land in Kristen's Gmail (mobile push notifications = free SMS-equivalent).
const FROM = 'Kristen Coats <hello@lakesidethreadz.com>';
const SITE = 'https://lakesidethreadz.com';
const PHONE_DISPLAY = '(346) 988-5449';
// CAN-SPAM footer requires a valid physical postal address. Shop street is
// NOT public on the site (owner preference); it appears only in email footers.
const ADDRESS_STREET = '62 Main St';
const ADDRESS_LINE   = 'Lakeside Ink & Threadz · 62 Main St · Onalaska, TX 77360';
// Days to wait after the previous touch before the next one goes out.
const TOUCH_GAP_DAYS = [0, 4, 5]; // touch1 immediately, touch2 +4d, touch3 +5d after that

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const authed = (url, env) =>
  env.OUTREACH_KEY && url.searchParams.get('key') === env.OUTREACH_KEY;

// Convert a plain-text email body into a minimal HTML equivalent.
// Purpose: Resend can only inject open-pixel + click-tracking wrappers into
// HTML parts. Sending text-only kills engagement events (no opens/clicks →
// no auto-newsletter enrollment loop). Every send therefore includes both
// a text and an html part with the same content.
function textToHtml(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Linkify http/https URLs. Trailing sentence punctuation (,.;:!?)`") is NOT
  // part of the URL and must sit OUTSIDE the anchor — otherwise the recipient
  // clicks and hits /quote, or /quote. and gets a 404. Trim it off.
  html = html.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const trail = m.match(/[.,;:!?)"'\]]+$/);
    if (trail) {
      const url = m.slice(0, -trail[0].length);
      return `<a href="${url}" style="color:#001E78">${url}</a>${trail[0]}`;
    }
    return `<a href="${m}" style="color:#001E78">${m}</a>`;
  });
  // Linkify (346) 988-5449 style phone numbers
  html = html.replace(/\((\d{3})\)\s*(\d{3})-(\d{4})/g,
    '<a href="tel:+1$1$2$3" style="color:#001E78">($1) $2-$3</a>');
  // Paragraph breaks (double-newline) + soft breaks (single-newline)
  html = html.split(/\n\n+/).map(p => `<p style="margin:0 0 1em">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:600px">${html}</div>`;
}

// ---------------------------------------------------------------------------
// Email templates — Kristen's voice (warm, plain-spoken), tightened for cold
// touch #1 (~100 words), category-personalized hook per ICP.
// ---------------------------------------------------------------------------
function pickHook(category) {
  const c = (category || '').toLowerCase();
  // Medical / healthcare
  if (c.includes('doctor') || c.includes('physician') || c.includes('dental') || c.includes('orthodont')
      || c.includes('chiropract') || c.includes('veterinar') || c.includes('medical') || c.includes('optomet')
      || c.includes('physical therapy') || c.includes('urgent care') || c.includes('clinic') || c.includes('nurse')) {
    return "Matching embroidered polos or scrubs make a small office feel intentional — patients notice, staff feels like a team, and it's clear at a glance who works there.";
  }
  // Sports teams / schools / booster clubs
  if (c.includes('sport') || c.includes('team') || c.includes('school') || c.includes('booster')
      || c.includes('coach') || c.includes('athlet') || c.includes('league') || c.includes('gym')
      || c.includes('fitness') || c.includes('crossfit') || c.includes('martial') || c.includes('dance')) {
    return "Matching team shirts, hats, or warmups turn a group of players into a team — and give parents (and the photographer) something clean to focus on at every game.";
  }
  // Church / ministry
  if (c.includes('church') || c.includes('ministry') || c.includes('religious') || c.includes('faith')) {
    return "Matching shirts for VBS, mission trips, or staff make a Sunday feel intentional — kids and volunteers spot each other in a crowd, and you've got something to hand out for years.";
  }
  // Marina / lake / fishing
  if (c.includes('marina') || c.includes('boat') || c.includes('lake') || c.includes('fish') || c.includes('dock')) {
    return "On Lake Livingston, matching PFG shirts or embroidered hats set your team apart from the weekend crowd — customers know immediately who works there.";
  }
  // Trades / construction
  if (c.includes('hvac') || c.includes('heating') || c.includes('air condition') || c.includes('plumb')
      || c.includes('electric') || c.includes('roof') || c.includes('landscap') || c.includes('lawn')
      || c.includes('construct') || c.includes('build') || c.includes('concrete') || c.includes('remodel')
      || c.includes('excavat') || c.includes('pest')) {
    return "When your crew shows up in matching branded gear, customers notice — it's the small thing that quietly says 'this is a real business, not a guy with a truck.'";
  }
  // Restaurants / hospitality
  if (c.includes('restaurant') || c.includes('bar') || c.includes('cafe') || c.includes('coffee')
      || c.includes('food') || c.includes('caterer') || c.includes('event')) {
    return "A branded polo or apron on every server does more brand work than an Instagram post — customers notice, and the staff feels like a team.";
  }
  // Real estate / professional
  if (c.includes('real estate') || c.includes('realtor') || c.includes('property') || c.includes('insurance')
      || c.includes('law') || c.includes('attorney') || c.includes('accountant') || c.includes('cpa')) {
    return "A branded polo at every open house, closing, or client meeting turns your team into a walking advertisement — clients remember the agent who showed up looking sharp.";
  }
  // Fallback — small biz / retail / anything else
  return "Matching branded apparel on your team quietly reinforces your brand every day, on every job — and it's cheaper per piece than you'd think.";
}

function renderTouch(n, p, unsubUrl) {
  const org = p.org || 'your team';
  const first = (p.name || '').split(' ')[0] || 'there';
  const hook = pickHook(p.category);

  const bodies = {
    1: {
      subject: `Quick hello from Lakeside Ink & Threadz`,
      text:
`Hi ${first},

I'm Kristen Coats, owner of Lakeside Ink & Threadz — a small custom embroidery and DTF printing shop right here in Onalaska. We help local businesses, offices, teams, and organizations with custom apparel and branded gifts.

${hook}

If ${org} could use custom polos, hats, work shirts, team apparel, or personalized gifts, I'd love to send a free digital proof of what your logo would look like on a real piece. No minimums, quick turnaround, and every project gets the same attention whether it's one shirt or a hundred.

Reply here with a rough idea and I'll get you a real price — usually same day. Or run a 60-second quote at ${SITE}/quote, or call/text me at ${PHONE_DISPLAY}.

Kristen
Lakeside Ink & Threadz`,
    },
    2: {
      subject: `Re: Quick hello from Lakeside Ink & Threadz`,
      text:
`Hi ${first},

Circling back — I know inboxes get busy. Short version of what we do:

- Custom embroidery, DTF printing, personalized gifts
- No minimums (one piece or 500)
- Free digital proof of your logo before anything gets made
- 5-10 business day turnaround (rush available if you're up against a deadline)

If ${org} is even thinking about branded polos, work shirts, team apparel, event/uniform gear, or a one-off personalized piece — reply here or text ${PHONE_DISPLAY} and I'll walk you through what actually fits.

Instant estimate anytime at ${SITE}/quote.

Kristen`,
    },
    3: {
      subject: `Last note from Kristen at Lakeside`,
      text:
`Hi ${first},

Last one from me — no hard feelings if this isn't the right time. Whenever ${org} does need custom apparel, embroidered gifts, or a small uniform program, we're right here in Onalaska and happy to help.

${SITE}/quote for an instant price, or text me at ${PHONE_DISPLAY}.

Kristen
Lakeside Ink & Threadz`,
    },
  };
  const b = bodies[n];
  const footer = `

—
${ADDRESS_LINE}
Don't want these? Unsubscribe: ${unsubUrl}`;
  const text = b.text + footer;
  return {
    subject: b.subject,
    text,
    html: textToHtml(text),
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
        html: msg.html,     // required for Resend open/click tracking
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
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
  return { subject: seasons.subj, text: seasons.body + `\n\nOr call/text ${PHONE_DISPLAY} — I usually pick up.\n\nKristen\nLakeside Ink & Threadz` };
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
    const bodyText = `${issue.text}

—
${ADDRESS_LINE}
Unsubscribe: ${unsubUrl}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        reply_to: env.OUTREACH_REPLY_TO || undefined,
        subject: issue.subject,
        text: bodyText,
        html: textToHtml(bodyText),
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
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
