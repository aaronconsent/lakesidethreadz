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

const ENDPOINTS = new Set(["/api/contact", "/api/quote"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Form endpoints ---
    if (ENDPOINTS.has(path)) {
      if (request.method === "GET") {
        return json({ ok: true, endpoint: path }, 200);
      }
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      return await handleFormSubmit(request, env, path);
    }

    // --- Static asset fallback (Worker assets binding) ---
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function safeText(r) {
  try { return await r.text(); } catch { return ""; }
}
