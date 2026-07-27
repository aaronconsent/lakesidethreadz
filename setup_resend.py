#!/usr/bin/env python3
"""setup_resend.py — one-shot Resend domain + webhook auto-configuration.

Enables open + click tracking on lakesidethreadz.com and creates the events
webhook pointed at the deployed Worker's /api/outreach/webhook endpoint.

Idempotent: skips existing webhook if one already points at our URL.

Usage:
    export RESEND_API_KEY="re_…"                       # required
    export OUTREACH_KEY="bvG_…"                        # required (goes in webhook URL)
    python3 setup_resend.py [--domain lakesidethreadz.com]
                            [--worker-url https://lakesidethreadz.com]
                            [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def resend(method: str, path: str, key: str, body: dict | None = None):
    url = f"https://api.resend.com{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="lakesidethreadz.com")
    ap.add_argument("--worker-url", default="https://lakesidethreadz.com")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = os.environ.get("RESEND_API_KEY", "")
    ok  = os.environ.get("OUTREACH_KEY", "")
    if not key:
        print("Set RESEND_API_KEY env var.", file=sys.stderr); return 2
    if not ok:
        print("Set OUTREACH_KEY env var (the same value that's set as a Worker secret).", file=sys.stderr); return 2

    print(f"→ Fetching domains from Resend...")
    status, domains = resend("GET", "/domains", key)
    if status != 200:
        print(f"  Failed: HTTP {status} {domains}"); return 1
    match = next((d for d in domains.get("data", []) if d.get("name") == args.domain), None)
    if not match:
        print(f"  Domain '{args.domain}' not found in this Resend account.")
        print(f"  Available: {[d.get('name') for d in domains.get('data', [])]}")
        return 1
    dom_id = match["id"]
    print(f"  Found: {args.domain} (id={dom_id}, status={match.get('status')})")

    if match.get("status") != "verified":
        print(f"  ⚠ Domain is not 'verified' yet. Check DNS records in Resend dashboard.")

    # -- 1. Enable open + click tracking on the domain -----------------------
    print(f"→ Enabling open + click tracking on {args.domain}...")
    payload = {"open_tracking": True, "click_tracking": True}
    if args.dry_run:
        print(f"  [dry-run] PATCH /domains/{dom_id} {payload}")
    else:
        status, resp = resend("PATCH", f"/domains/{dom_id}", key, payload)
        if status in (200, 201):
            print(f"  OK — tracking enabled")
        else:
            print(f"  Failed: HTTP {status} {resp}"); return 1

    # -- 2. Create the events webhook ----------------------------------------
    webhook_url = f"{args.worker_url.rstrip('/')}/api/outreach/webhook?key={ok}"
    events = ["email.bounced", "email.complained", "email.opened", "email.clicked"]
    print(f"→ Checking existing webhooks...")
    status, hooks = resend("GET", "/webhooks", key)
    if status != 200:
        print(f"  Failed to list: HTTP {status} {hooks}"); return 1
    existing = next(
        (h for h in hooks.get("data", []) if h.get("endpoint") == webhook_url or webhook_url.startswith(h.get("endpoint", "") + "?")),
        None,
    )
    if existing:
        print(f"  Webhook already exists (id={existing.get('id')}) — leaving alone")
    else:
        payload = {"endpoint": webhook_url, "events": events}
        if args.dry_run:
            print(f"  [dry-run] POST /webhooks {payload}")
        else:
            status, resp = resend("POST", "/webhooks", key, payload)
            if status in (200, 201):
                print(f"  OK — webhook created (id={resp.get('id')})")
                print(f"       url = {webhook_url}")
                print(f"       events = {events}")
            else:
                print(f"  Failed: HTTP {status} {resp}"); return 1

    print()
    print("Done. Sends made after this point should produce:")
    print("  - open + click events → engagement flag + auto-newsletter enrollment")
    print("  - bounce + complaint events → auto-suppression")
    return 0


if __name__ == "__main__":
    sys.exit(main())
