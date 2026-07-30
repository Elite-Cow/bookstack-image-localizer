# BookStack Companion Bridge — Chrome / Edge

This optional extension lets the **Localize Images** tool re-host images that sit
behind Cloudflare or hotlink protection — the ones a scan flags as
"unreachable" / 403.

## Why it's needed

Those images load fine in your browser because your browser has the right
session (a Cloudflare `cf_clearance` cookie and a real browser fingerprint). The
local tool's server has neither, so the image host answers it with a `403
"Just a moment…"` challenge. This extension runs **inside your browser**, so it
simply fetches those images through your own session and hands them to the tool.
Nothing to copy, nothing to decrypt.

## Install (one time)

1. In the tool, open **Localize Images → Install bridge → Download
   `bookstack-bridge.zip`** (or use the copy your distributor gave you).
2. **Unzip** it to a folder you'll keep — Chrome/Edge load the extension from
   that folder, so don't delete it afterwards.
3. Open **`chrome://extensions`** (or **`edge://extensions`**).
4. Turn on **Developer mode** (top-right).
5. Click **Load unpacked** and select the unzipped folder.
6. Reload the BookStack Companion tab.

In the tool's **Localize Images** tab you should now see a green **"Browser
bridge detected"** status. Scan, then Localize — blocked images are fetched
through your browser automatically.

## What it can access

- `host_permissions: <all_urls>` and `cookies` — so it can fetch image bytes and
  read clearance cookies for whatever third-party hosts your wiki links to. It
  only acts on requests started by the tool page (`localhost`); it talks to no
  external server and collects nothing.

## Troubleshooting

- **Status stays "not detected":** the extension only attaches on a fresh page
  load — hard-refresh the tab (Ctrl+Shift+R) after installing.
- **Confirm it loaded:** open DevTools → Console; you should see
  `[BookStack Companion Bridge] content script active`.
