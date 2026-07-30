// BookStack Companion Bridge — background (cross-browser: Chrome service worker
// or Firefox event page).
//
// Runs inside the browser, so it has the real session: the same TLS fingerprint
// and the httpOnly cf_clearance cookie that let Cloudflare-protected images load.
// It does two things for the localizer page:
//   - fetch        : download image bytes through the browser session
//   - getClearance : read the clearance/session cookies for a domain
//
// `chrome` is available in Firefox as an alias for `browser`.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === 'fetch') {
    handleFetch(msg.urls || []).then((results) => sendResponse({ results }));
    return true; // async response
  }
  if (msg?.action === 'getClearance') {
    handleGetClearance(msg.domains || []).then((cookies) => sendResponse({ cookies }));
    return true;
  }
  if (msg?.action === 'probe') {
    handleProbe(msg.urls || []).then((results) => sendResponse({ results }));
    return true;
  }
  return false;
});

// Reachability + size/type probe through the browser session, without
// downloading the whole image: HEAD first, then a single-byte ranged GET.
async function handleProbe(urls) {
  const out = [];
  for (const url of urls) out.push({ url, ...(await probeOne(url)) });
  return out;
}

async function probeOne(url) {
  try {
    const head = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
    if (head.ok) {
      return {
        ok: true,
        status: head.status,
        contentType: (head.headers.get('content-type') || '').split(';')[0],
        size: Number(head.headers.get('content-length')) || null,
      };
    }
    if (head.status !== 405 && head.status !== 501) return { ok: false, status: head.status };
  } catch {
    /* fall through to ranged GET */
  }
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
    });
    if (!res.ok && res.status !== 206) return { ok: false, status: res.status };
    const range = res.headers.get('content-range'); // "bytes 0-0/12345"
    const total = range && range.includes('/') ? Number(range.split('/')[1]) : null;
    return {
      ok: true,
      status: res.status,
      contentType: (res.headers.get('content-type') || '').split(';')[0],
      size: total || Number(res.headers.get('content-length')) || null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function handleFetch(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
      if (!res.ok) {
        results.push({ url, ok: false, error: `HTTP ${res.status}` });
        continue;
      }
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
      const buf = await res.arrayBuffer();
      if (!buf.byteLength) {
        results.push({ url, ok: false, error: 'empty response' });
        continue;
      }
      results.push({ url, ok: true, contentType, size: buf.byteLength, dataBase64: toBase64(buf) });
    } catch (err) {
      results.push({ url, ok: false, error: String(err?.message || err) });
    }
  }
  return results;
}

async function handleGetClearance(domains) {
  const out = [];
  for (const domain of domains) {
    try {
      const all = await chrome.cookies.getAll({ domain });
      if (all.length) {
        out.push({ domain, cookie: all.map((c) => `${c.name}=${c.value}`).join('; ') });
      }
    } catch {
      /* skip domains we can't read */
    }
  }
  return out;
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
