// worker.js — Cloudflare Worker for lakesidethreadz.com
// Handles POST /api/contact and POST /api/quote (Resend email).
// Falls through to env.ASSETS.fetch for all static assets.
//
// Required env vars (Worker → Settings → Variables and Secrets):
//   RESEND_API_KEY  (secret, Resend API key)
// Optional vars (set in wrangler.jsonc → vars):
//   CONTACT_TO    — default: info@lakesidethreadz.com  (verify with Aaron)
//   CONTACT_FROM  — default: noreply@lakesidethreadz.com (domain must be verified in Resend)
//   CONTACT_CC    — optional comma-separated CC list

const SIMPLE_ENDPOINTS = new Set(["/api/contact", "/api/quote"]);
const RICH_QUOTE_ENDPOINT = "/api/submit-quote";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (SIMPLE_ENDPOINTS.has(path)) {
      if (request.method === "GET") return json({ ok: true, endpoint: path }, 200);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await handleFormSubmit(request, env, path);
    }

    if (path === RICH_QUOTE_ENDPOINT) {
      if (request.method === "GET") return json({ ok: true, endpoint: path }, 200);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await handleRichQuote(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleFormSubmit(request, env, endpoint) {
  let body = {};
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      body = await request.json();
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) body[k] = v;
    }
  } catch (e) {
    return json({ error: "Bad request body" }, 400);
  }

  // Honeypot — drop silently if filled.
  if (body.website) return json({ ok: true }, 200);

  const name = (body.name || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const phone = (body.phone || "").toString().trim();
  const service = (body.service || "").toString().trim();
  const message = (body.message || "").toString().trim();

  if (!name || !email || !message) {
    return json({ error: "Name, email, and message are required." }, 422);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Please enter a valid email." }, 422);
  }

  if (!env.RESEND_API_KEY) {
    return json({ error: "Email is not configured yet." }, 503);
  }

  const which = endpoint === "/api/quote" ? "Quote request" : "Contact form";
  const to = (env.CONTACT_TO || "info@lakesidethreadz.com").split(",").map(s => s.trim()).filter(Boolean);
  const from = env.CONTACT_FROM || "noreply@lakesidethreadz.com";
  const cc = (env.CONTACT_CC || "").split(",").map(s => s.trim()).filter(Boolean);

  const subject = `[L.I.T.] ${which} from ${name}`;
  const text =
    `${which} via ${endpoint}\n\n` +
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `Phone: ${phone || "—"}\n` +
    `Service: ${service || "—"}\n\n` +
    `Message:\n${message}\n`;

  const payload = {
    from: `Lakeside Ink & Threadz <${from}>`,
    to,
    cc: cc.length ? cc : undefined,
    reply_to: email,
    subject,
    text,
  };

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await safeText(r);
      return json({ error: "Email send failed", detail }, 502);
    }
  } catch (e) {
    return json({ error: "Email send threw", detail: String(e) }, 502);
  }

  return json({ ok: true }, 200);
}

async function handleRichQuote(request, env) {
  // Accepts the full calculator payload and formats it into a readable email.
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  if (body && body.website) return json({ ok: true }, 200);

  const c = (body && body.contact) || {};
  const name = (c.firstName || "").toString().trim();
  const email = (c.email || "").toString().trim();
  const phone = (c.phone || "").toString().trim();
  const business = (c.businessName || "").toString().trim();
  if (!name || !email) return json({ error: "Name and email are required." }, 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid email." }, 422);

  const est = body.estimate || {};
  const addons = body.addons || {};
  const addonLines = [
    addons.individualNames && "Individual names (+$3/pc)",
    addons.rushOrder && "Rush order (+25%)",
    addons.logoDesign && "Logo design (+$149)",
  ].filter(Boolean).join(", ") || "—";
  const placements = Array.isArray(body.placements) && body.placements.length ? body.placements.join(", ") : "—";
  const logoLine = body.needsLogoDesign || addons.logoDesign
    ? "Design service requested"
    : body.skipLogo
      ? "Sending logo later"
      : body.logoFile
        ? `Uploaded: ${body.logoFile.name} (${formatBytes(body.logoFile.size)}) — customer will email the file separately`
        : "Not provided";

  const subject = `[L.I.T.] Quote request from ${name} — ${body.product || "?"} × ${body.quantity || "?"}`;
  const text =
    `New quote request via /api/submit-quote\n\n` +
    `=== Contact ===\n` +
    `Name:     ${name}\n` +
    `Email:    ${email}\n` +
    `Phone:    ${phone || "—"}\n` +
    `Business: ${business || "—"}\n\n` +
    `=== Order ===\n` +
    `Product:    ${body.product || "—"}\n` +
    `Quantity:   ${body.quantity || "—"}\n` +
    `Tier:       ${body.tier || "—"}\n` +
    `Color:      ${body.color || "—"}\n` +
    `Placement:  ${placements}\n` +
    `Logo:       ${logoLine}\n` +
    `Add-ons:    ${addonLines}\n\n` +
    `=== Estimate ===\n` +
    `Per piece:        $${num(est.perPiece)}\n` +
    `One-time fees:    $${num(est.oneTimeFees)}\n` +
    `Estimated total:  $${num(est.total)}\n`;

  if (!env.RESEND_API_KEY) return json({ error: "Email is not configured yet." }, 503);

  const to = (env.CONTACT_TO || "info@lakesidethreadz.com").split(",").map(s => s.trim()).filter(Boolean);
  const from = env.CONTACT_FROM || "noreply@lakesidethreadz.com";
  const cc = (env.CONTACT_CC || "").split(",").map(s => s.trim()).filter(Boolean);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Lakeside Ink & Threadz <${from}>`,
        to,
        cc: cc.length ? cc : undefined,
        reply_to: email,
        subject,
        text,
      }),
    });
    if (!r.ok) return json({ error: "Email send failed", detail: await safeText(r) }, 502);
  } catch (e) {
    return json({ error: "Email send threw", detail: String(e) }, 502);
  }
  return json({ ok: true }, 200);
}

function num(n) { return (typeof n === "number" ? n : 0).toFixed(2); }
function formatBytes(b) {
  if (typeof b !== "number") return "?";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function safeText(r) {
  try { return await r.text(); } catch { return ""; }
}
