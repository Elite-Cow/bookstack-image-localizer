// BookStack Companion Bridge — content script.
//
// Injected only on the localhost tool page. Relays messages between the page
// (via window.postMessage) and the extension background worker. The page never
// gets direct access to extension APIs; this is the only channel.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || !msg.__bscPage) return;

  // Presence check — answer directly, no background round-trip needed.
  if (msg.action === 'ping') {
    window.postMessage({ __bsc: true, id: msg.id, payload: { ready: true } }, '*');
    return;
  }

  chrome.runtime.sendMessage(
    { action: msg.action, urls: msg.urls, domains: msg.domains },
    (resp) => {
      window.postMessage({ __bsc: true, id: msg.id, payload: resp || {} }, '*');
    }
  );
});

// Announce availability repeatedly so the tool catches it regardless of whether
// its listener is registered yet (document_start runs before the page's JS).
console.log('[BookStack Companion Bridge] content script active on', location.href);
function announce() {
  window.postMessage({ __bsc: true, announce: true, payload: { ready: true } }, '*');
}
announce();
window.addEventListener('DOMContentLoaded', announce);
window.addEventListener('load', announce);
