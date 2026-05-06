/**
 * background.js — Hover Quick Preview Service Worker  v3
 *
 * Fetch proxy for the content script. Content scripts can't always fetch
 * cross-origin URLs due to CORS, but the background service worker can
 * (because manifest.json grants host_permissions: ["<all_urls>"]).
 *
 * v3: Added [HQP] console logging for fetch debugging.
 */

const FETCH_TIMEOUT_MS = 5000;

const BROWSER_HTML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  'Cache-Control':             'no-cache',
  'Pragma':                    'no-cache',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Upgrade-Insecure-Requests': '1',
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_JSON') {
    fetchAsJson(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'FETCH_HTML') {
    fetchAsHtml(msg.url).then(sendResponse);
    return true;
  }
});

async function fetchAsJson(url) {
  console.log('[HQP bg] FETCH_JSON', url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/javascript, */*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      credentials: 'omit',
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.log('[HQP bg] FETCH_JSON failed', res.status, url);
      return { ok: false, status: res.status };
    }
    const data = await res.json();
    console.log('[HQP bg] FETCH_JSON ok', url);
    return { ok: true, data };
  } catch (err) {
    console.log('[HQP bg] FETCH_JSON error', err && err.message, url);
    return { ok: false, error: err.message };
  }
}

async function fetchAsHtml(url) {
  console.log('[HQP bg] FETCH_HTML', url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: BROWSER_HTML_HEADERS,
      credentials: 'omit',
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.log('[HQP bg] FETCH_HTML failed', res.status, url);
      return { ok: false, status: res.status };
    }
    const data = await res.text();
    console.log('[HQP bg] FETCH_HTML ok', url);
    return { ok: true, data };
  } catch (err) {
    console.log('[HQP bg] FETCH_HTML error', err && err.message, url);
    return { ok: false, error: err.message };
  }
}
