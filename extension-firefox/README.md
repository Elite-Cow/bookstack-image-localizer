# BookStack Companion Bridge — Firefox

This optional extension lets the **Localize Images** tool re-host images that sit
behind Cloudflare or hotlink protection — the ones a scan flags as
"unreachable" / 403.

## Why it's needed

Those images load fine in your browser because your browser has the right
session (a Cloudflare `cf_clearance` cookie and a real browser fingerprint). The
local tool's server has neither, so the image host answers it with a `403
"Just a moment…"` challenge. This extension runs **inside your browser**, so it
simply fetches those images through your own session and hands them to the tool.

## Install (one time)

1. In the tool, open **Localize Images → Install bridge → Download
   `bookstack-bridge.xpi`** (or use the copy your distributor gave you).
2. Open **`about:debugging#/runtime/this-firefox`**.
3. Click **Load Temporary Add-on…** and select the downloaded **`.xpi`**.
4. Open **`about:addons`** → **BookStack Companion Bridge** → **Permissions** →
   turn on **“Access your data for all websites.”** Firefox needs this granted
   before the extension can fetch images (Chrome grants it automatically).
5. Reload the BookStack Companion tab.

You should now see a green **"Browser bridge detected"** status in the tool.

## Note on Firefox temporary add-ons

Firefox removes temporarily-loaded add-ons when it restarts, so you'll repeat
steps 1–3 next session. A permanent install requires the add-on to be signed by
Mozilla (AMO) — out of scope for this local tool.

## What it can access

- `host_permissions: <all_urls>` and `cookies` — so it can fetch image bytes and
  read clearance cookies for the third-party hosts your wiki links to. It only
  acts on requests started by the tool page (`localhost`); it talks to no
  external server and collects nothing.

## Troubleshooting

- **Status stays "not detected":** hard-refresh the tab (Ctrl+Shift+R) after
  loading the add-on — the content script only attaches on a fresh page load.
- **Bridge connects but images still fail:** you likely skipped step 4 — grant
  **“Access your data for all websites”** in `about:addons`.
- **Confirm it loaded:** open DevTools → Console; you should see
  `[BookStack Companion Bridge] content script active`.
