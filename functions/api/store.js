// ============================================================================
// Personal-store engine — queue upload + review + approval endpoints.
//
// The full flow (Phase 1):
//   1. Local script POSTs each enriched prospect + logo URL to
//      POST /api/store/queue    → KV store:queue:<slug> = {..., status:'pending'}
//   2. Aaron opens /dashboard/review, sees thumbnails, clicks per prospect:
//        POST /api/store/queue/<slug>/approve
//        POST /api/store/queue/<slug>/reject
//        POST /api/store/queue/<slug>/logo   (upload manual replacement)
//   3. Local store_build.py reads status='approved' entries, generates
//      site/store/<slug>/index.html (+ mockups), pushes to prod.
//
// Auth: OUTREACH_KEY gates all writes. Review UI accepts DASHBOARD_KEY too
//       so Kristen can inspect without holding OUTREACH_KEY.
//
// KV:
//   store:queue:<slug>     -> {slug, org, email, category, city, logo_url,
//                              logo_confidence, logo_source, website,
//                              status:'pending'|'approved'|'rejected',
//                              added_at, decided_at?, decided_by?}
// ============================================================================

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const authed = (url, env) =>
  env.OUTREACH_KEY && url.searchParams.get('key') === env.OUTREACH_KEY;

const dashAuthed = (url, env) =>
  (env.DASHBOARD_KEY && url.searchParams.get('key') === env.DASHBOARD_KEY) ||
  authed(url, env);

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

// POST /api/store/queue?key=OUTREACH_KEY   body:{prospects:[{...}]}
// Upsert queue entries. Existing entries keep their status.
export async function storeQueuePost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.STATUS) return json({ error: 'STATUS KV not bound' }, 500);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.prospects)) return json({ error: 'prospects[] required' }, 400);
  let added = 0, updated = 0, skipped = 0;
  for (const p of body.prospects) {
    if (!p.email || !p.org) { skipped++; continue; }
    const slug = p.slug || slugify(p.org);
    const key = 'store:queue:' + slug;
    const existing = await env.STATUS.get(key, 'json');
    const now = Date.now();
    const rec = {
      slug,
      org: p.org,
      email: p.email,
      category: p.category || '',
      city: p.city || '',
      website: p.website || '',
      website_kind: p.website_kind || '',
      phone: p.phone || '',
      logo_url: p.logo_url || '',        // path on our CDN, e.g. /assets/prospect-logos/xxx.png
      logo_source: p.logo_source || '',
      logo_size: p.logo_size || '',
      logo_confidence: p.logo_confidence ?? 0,
      logo_original_url: p.logo_original_url || '',
      source_url: p.source_url || '',
      status: (existing && existing.status) || 'pending',
      added_at: (existing && existing.added_at) || now,
      updated_at: now,
    };
    await env.STATUS.put(key, JSON.stringify(rec));
    if (existing) updated++; else added++;
  }
  return json({ ok: true, added, updated, skipped });
}

// GET /api/store/queue?key=DASHBOARD_KEY&status=pending
// Returns the queue as JSON (used by /dashboard/review to render).
export async function storeQueueList({ request, env }) {
  const url = new URL(request.url);
  if (!dashAuthed(url, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.STATUS) return json({ error: 'STATUS KV not bound' }, 500);
  const wantStatus = url.searchParams.get('status');  // 'pending' | 'approved' | 'rejected' | ''=all
  const items = [];
  let cursor;
  do {
    const res = await env.STATUS.list({ prefix: 'store:queue:', cursor });
    for (const k of res.keys) {
      // Keep listing cheap — batch reads via Promise.all up front.
      items.push(k.name);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  // Cap detailed reads at 40 to stay well under CF's 50-subrequest limit.
  const keys = items.slice(0, 40);
  const values = await Promise.all(keys.map(k => env.STATUS.get(k, 'json')));
  const out = values.filter(Boolean).filter(v => !wantStatus || v.status === wantStatus);
  out.sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
  return json({ ok: true, total: items.length, shown: out.length, items: out });
}

// POST /api/store/queue/<slug>/approve|reject?key=OUTREACH_KEY
export async function storeQueueDecide({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.STATUS) return json({ error: 'STATUS KV not bound' }, 500);
  const m = url.pathname.match(/^\/api\/store\/queue\/([^\/]+)\/(approve|reject)$/);
  if (!m) return json({ error: 'bad path' }, 400);
  const slug = m[1];
  const decision = m[2];
  const key = 'store:queue:' + slug;
  const rec = await env.STATUS.get(key, 'json');
  if (!rec) return json({ error: 'not found' }, 404);
  rec.status = decision === 'approve' ? 'approved' : 'rejected';
  rec.decided_at = Date.now();
  rec.updated_at = Date.now();
  await env.STATUS.put(key, JSON.stringify(rec));
  return json({ ok: true, slug, status: rec.status });
}

// GET /dashboard/review?key=DASHBOARD_KEY
// Renders the review UI as a single self-contained HTML page.
export async function storeReviewPage({ request, env }) {
  const url = new URL(request.url);
  if (!dashAuthed(url, env)) {
    return new Response(REVIEW_LOGIN_HTML, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const key = url.searchParams.get('key') || '';
  // Only OUTREACH_KEY (not DASHBOARD_KEY) can decide — surface a read-only
  // banner if the viewer is dashboard-only. Owner + operator both have
  // OUTREACH_KEY so this matches the earlier /dashboard convention.
  const canDecide = authed(url, env);
  return new Response(renderReviewHTML(key, canDecide), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const REVIEW_LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review · Access required</title><style>body{margin:0;font-family:-apple-system,sans-serif;background:#001E78;color:#fff;display:grid;place-items:center;min-height:100vh}form{background:#fff;color:#222;padding:32px;border-radius:14px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.3)}h1{margin:0 0 8px;color:#001E78;font-size:22px}p{color:#666;font-size:14px;margin:0 0 20px}input{width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;font-size:15px;margin-bottom:12px;font-family:monospace}button{width:100%;padding:12px;background:linear-gradient(90deg,#F09600,#E10078);color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}</style></head><body><form onsubmit="event.preventDefault();window.location.href='/dashboard/review?key='+encodeURIComponent(this.k.value)"><h1>Review queue access</h1><p>Paste your admin key to review scraped logos.</p><input name="k" placeholder="Admin key" required autofocus><button type="submit">Open review queue</button></form></body></html>`;

function renderReviewHTML(key, canDecide) {
  const banner = canDecide ? '' :
    `<div style="background:#fef3c7;color:#78350f;padding:10px;text-align:center;font-size:13px;border-bottom:1px solid #fde68a">Read-only view. Use the OUTREACH_KEY to approve/reject.</div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Logo review queue · Lakeside Ink & Threadz</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fb;color:#111}
  header{background:#001E78;color:#fff;padding:20px 24px;display:flex;justify-content:space-between;align-items:center}
  header h1{font-size:20px;margin:0}
  header .filters{display:flex;gap:8px}
  header .filters a{padding:6px 12px;border-radius:20px;color:#fff;text-decoration:none;font-size:13px;background:rgba(255,255,255,.15)}
  header .filters a.active{background:#F09600}
  .container{max-width:1400px;margin:0 auto;padding:24px}
  .stats{display:flex;gap:12px;margin-bottom:20px}
  .stat{background:#fff;padding:12px 20px;border-radius:10px;box-shadow:0 1px 3px rgba(0,15,90,.06);border:1px solid #eef}
  .stat b{color:#001E78;font-size:22px;display:block}
  .stat span{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 6px rgba(0,15,90,.06);border:1px solid #eef;overflow:hidden;display:flex;flex-direction:column}
  .thumb{aspect-ratio:16/9;background:repeating-conic-gradient(#f3f4f6 0% 25%,#e5e7eb 0% 50%) 50%/16px 16px;display:grid;place-items:center;padding:16px}
  .thumb img{max-width:100%;max-height:100%;object-fit:contain}
  .meta{padding:14px}
  .meta h2{margin:0 0 4px;font-size:15px;color:#001E78}
  .meta .biz-details{color:#666;font-size:12px;line-height:1.5}
  .meta .biz-details a{color:#001E78;text-decoration:none}
  .meta .badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#e0e7ff;color:#001E78;text-transform:uppercase}
  .badge.status-pending{background:#fef3c7;color:#78350f}
  .badge.status-approved{background:#dcfce7;color:#14532d}
  .badge.status-rejected{background:#fee2e2;color:#7f1d1d}
  .badge.conf-low{background:#fee2e2;color:#7f1d1d}
  .badge.conf-med{background:#fef3c7;color:#78350f}
  .badge.conf-high{background:#dcfce7;color:#14532d}
  .actions{display:flex;gap:6px;padding:10px 14px 14px}
  .actions button{flex:1;padding:8px;border:0;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer}
  .actions .approve{background:#22c55e;color:#fff}
  .actions .reject{background:#ef4444;color:#fff}
  .actions button:disabled{opacity:.5;cursor:default}
  .empty{text-align:center;padding:60px 20px;color:#888}
</style></head>
<body>
${banner}
<header>
  <h1>Logo review queue</h1>
  <div class="filters">
    <a href="#" data-filter="pending" class="active">Pending</a>
    <a href="#" data-filter="approved">Approved</a>
    <a href="#" data-filter="rejected">Rejected</a>
    <a href="#" data-filter="">All</a>
  </div>
</header>
<div class="container">
  <div class="stats" id="stats"></div>
  <div class="grid" id="grid"><div class="empty">Loading…</div></div>
</div>
<script>
const KEY = ${JSON.stringify(key)};
const CAN_DECIDE = ${canDecide ? 'true' : 'false'};
let currentFilter = 'pending';
async function load(){
  const grid = document.getElementById('grid');
  grid.innerHTML = '<div class="empty">Loading…</div>';
  const q = currentFilter ? '&status=' + currentFilter : '';
  const r = await fetch('/api/store/queue?key=' + encodeURIComponent(KEY) + q);
  const d = await r.json();
  const stats = document.getElementById('stats');
  stats.innerHTML =
    '<div class="stat"><b>' + d.total + '</b><span>Total in queue</span></div>' +
    '<div class="stat"><b>' + d.items.length + '</b><span>Showing (' + (currentFilter || 'all') + ')</span></div>';
  if (!d.items.length) { grid.innerHTML = '<div class="empty">Nothing here.</div>'; return; }
  grid.innerHTML = d.items.map(renderCard).join('');
}
function renderCard(it){
  const conf = it.logo_confidence || 0;
  const confClass = conf >= 0.7 ? 'conf-high' : conf >= 0.4 ? 'conf-med' : 'conf-low';
  const disabled = CAN_DECIDE ? '' : 'disabled';
  const thumb = it.logo_url
    ? '<img src="' + it.logo_url + '" alt="' + esc(it.org) + '" onerror="this.style.opacity=.3">'
    : '<span style="color:#999;font-size:12px">No logo</span>';
  return \`
  <div class="card" data-slug="\${esc(it.slug)}">
    <div class="thumb">\${thumb}</div>
    <div class="meta">
      <h2>\${esc(it.org)}</h2>
      <div class="biz-details">
        \${esc(it.email)} · \${esc(it.category)} · \${esc(it.city)}<br>
        \${it.website ? '<a href="' + esc(it.website) + '" target="_blank">' + esc(it.website) + '</a>' : ''}
      </div>
      <div class="badges">
        <span class="badge status-\${it.status}">\${it.status}</span>
        <span class="badge \${confClass}">conf \${(conf*100).toFixed(0)}%</span>
        <span class="badge">\${esc(it.logo_source || '?')}</span>
        <span class="badge">\${esc(it.logo_size || '?')}</span>
      </div>
    </div>
    <div class="actions">
      <button class="approve" \${disabled} onclick="decide('\${esc(it.slug)}','approve',this)">Approve</button>
      <button class="reject" \${disabled} onclick="decide('\${esc(it.slug)}','reject',this)">Reject</button>
    </div>
  </div>\`;
}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function decide(slug, action, btn){
  btn.disabled = true; btn.textContent = '...';
  const r = await fetch('/api/store/queue/' + slug + '/' + action + '?key=' + encodeURIComponent(KEY), {method:'POST'});
  const d = await r.json();
  if (!d.ok) { alert('Failed: ' + (d.error || 'unknown')); btn.disabled = false; btn.textContent = action; return; }
  // Fade + remove card; refresh stats.
  const card = btn.closest('.card');
  card.style.transition = 'opacity .3s'; card.style.opacity = 0;
  setTimeout(() => card.remove(), 300);
}
document.querySelectorAll('[data-filter]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    currentFilter = el.dataset.filter;
    load();
  });
});
load();
</script>
</body></html>`;
}
