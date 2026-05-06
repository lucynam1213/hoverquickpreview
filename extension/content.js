/**
 * content.js — Hover Quick Preview Content Script  v3
 *
 * v3 bug fixes:
 *  - FIXED: Shadow DOM relatedTarget retargeting bug. When mouse moves from a
 *    card to the toast, Chrome retargets mouseout.relatedTarget to the shadow
 *    HOST element (not inside shadowRoot), causing shadowRoot.contains() to
 *    return false and scheduling an immediate hide. Fixed by also checking
 *    `to === hostEl`.
 *  - FIXED: Popup flashed and immediately closed when no variant data found.
 *    Instead of hideToast(), we now show a fallback state (domain + link title).
 *  - FIXED: Added activeFetch token to prevent stale fetch results from
 *    rendering on the wrong card after rapid hovering.
 *  - FIXED: scheduleHide() now verifies mouse is not over toast before hiding.
 *  - ADDED: Loading ("Loading preview…"), error ("Preview unavailable"), and
 *    fallback (domain + title + "No variant data") states.
 *  - ADDED: URL normalization via new URL(href, window.location.href).href
 *  - ADDED: Console logs prefixed [HQP] for debugging.
 *  - ADDED: Mouse position tracking to confirm hover-leave before hiding.
 */

(function () {
  'use strict';

  if (document.getElementById('qs-shadow-host')) return;

  // ─── Settings ──────────────────────────────────────────────────────────────
  let enabled = true;
  chrome.storage.local.get('qs_enabled', (r) => {
    enabled = r.qs_enabled !== false;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('qs_enabled' in changes) enabled = changes.qs_enabled.newValue;
  });

  // ─── Constants ─────────────────────────────────────────────────────────────
  const HOVER_DELAY_MS = 400;   // wait before showing popup
  const HIDE_DELAY_MS  = 350;   // wait before hiding (longer = more stable)
  const CACHE_TTL_MS   = 5 * 60 * 1000;
  const TOAST_W        = 248;

  // ─── State ─────────────────────────────────────────────────────────────────
  let hoverTimer   = null;   // debounce before showing
  let hideTimer    = null;   // debounce before hiding
  let activeCard   = null;   // currently hovered card element
  let activeFetch  = null;   // Symbol token for the current in-flight fetch
  let shadowRoot   = null;
  let toastEl      = null;
  let hostEl       = null;
  let lastMouseX   = 0;
  let lastMouseY   = 0;

  const cache = new Map();

  // ─── Mouse position tracking ───────────────────────────────────────────────
  // Used to verify mouse has truly left before hiding
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true });

  // ─── Shadow DOM Setup ──────────────────────────────────────────────────────
  function initShadowDom() {
    hostEl = document.createElement('div');
    hostEl.id = 'qs-shadow-host';
    hostEl.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'top:0', 'left:0',
      'pointer-events:none',
      'display:none',
    ].join(';');
    document.documentElement.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = TOAST_CSS;
    shadowRoot.appendChild(styleEl);

    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.innerHTML = `
      <div class="head">
        <svg class="logo" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="8" fill="#22C55E"/>
          <path d="M5 8.5 7.2 11 11 6" stroke="#fff" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="brand">Hover Quick Preview</span>
        <span class="spinner" aria-label="loading"></span>
      </div>
      <div class="body"></div>
    `;
    shadowRoot.appendChild(toastEl);

    toastEl.addEventListener('mouseenter', () => {
      console.log('[HQP] mouse entered toast — canceling hide');
      clearTimeout(hideTimer);
    });
    toastEl.addEventListener('mouseleave', () => {
      console.log('[HQP] mouse left toast — scheduling hide');
      scheduleHide();
    });
  }

  // ─── Toast CSS (scoped inside Shadow DOM) ──────────────────────────────────
  const TOAST_CSS = `
    :host { display: block; }

    #toast {
      width: ${TOAST_W}px;
      background: #ffffff;
      border-radius: 14px;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.07),
        0 4px 6px rgba(0,0,0,.06),
        0 12px 32px rgba(0,0,0,.12);
      padding: 11px 13px 13px;
      font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI',
            Roboto, Helvetica, Arial, sans-serif;
      color: #111827;
      pointer-events: auto;
      user-select: none;
      box-sizing: border-box;
      opacity: 0;
      transform: translateY(4px) scale(.98);
      transition: opacity .15s ease, transform .15s ease;
    }
    #toast.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 9px;
      padding-bottom: 9px;
      border-bottom: 1px solid #F3F4F6;
    }
    .logo { width: 15px; height: 15px; flex-shrink: 0; }
    .brand {
      flex: 1;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: .04em;
      color: #059669;
      text-transform: uppercase;
    }

    .spinner {
      width: 13px; height: 13px;
      border: 2px solid #E5E7EB;
      border-top-color: #22C55E;
      border-radius: 50%;
      display: none;
      flex-shrink: 0;
    }
    .spinner.active {
      display: block;
      animation: spin .65s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .body { display: flex; flex-direction: column; gap: 8px; }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 5px;
    }
    .label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .07em;
      color: #6B7280;
    }
    .count {
      background: #F3F4F6;
      color: #374151;
      border-radius: 99px;
      padding: 1px 7px;
      font-size: 10px;
      font-weight: 700;
    }

    .swatches { display: flex; flex-wrap: wrap; gap: 5px; }
    .swatch {
      width: 20px; height: 20px;
      border-radius: 50%;
      border: 1.5px solid rgba(0,0,0,.13);
      cursor: default;
      position: relative;
      transition: transform .1s ease, box-shadow .1s ease;
    }
    .swatch:hover {
      transform: scale(1.3);
      z-index: 1;
      box-shadow: 0 2px 8px rgba(0,0,0,.22);
    }
    .swatch::after {
      content: attr(title);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: #111827;
      color: #fff;
      font-size: 10px;
      font-weight: 500;
      padding: 3px 7px;
      border-radius: 5px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity .1s ease;
    }
    .swatch:hover::after { opacity: 1; }

    .sizes { display: flex; flex-wrap: wrap; gap: 4px; }
    .size {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      padding: 3px 8px;
      background: #F9FAFB;
      border: 1px solid #E5E7EB;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      color: #374151;
      white-space: nowrap;
    }

    .divider { height: 1px; background: #F3F4F6; }

    .hint {
      font-size: 12px;
      color: #9CA3AF;
      margin: 2px 0 0;
      line-height: 1.5;
    }
    .hint.error { color: #F87171; }

    .color-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .color-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      background: #F9FAFB;
      border: 1px solid #E5E7EB;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      color: #374151;
      white-space: nowrap;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .color-chip-dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
      border: 1px solid rgba(0,0,0,.12);
    }

    .more-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 3px 8px;
      background: #F3F4F6;
      border-radius: 6px;
      font-size: 10.5px;
      font-weight: 600;
      color: #6B7280;
    }

    .source {
      font-size: 10px;
      color: #D1D5DB;
      text-align: right;
      margin-top: 2px;
    }

    .fallback-domain {
      font-size: 11px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 3px;
    }
    .fallback-title {
      font-size: 11.5px;
      color: #6B7280;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  `;

  // ─── Event Listeners ───────────────────────────────────────────────────────
  document.addEventListener('mouseover', onMouseOver, { capture: true, passive: true });
  document.addEventListener('mouseout',  onMouseOut,  { capture: true, passive: true });

  function onMouseOver(e) {
    if (!enabled) return;

    // Ignore events fired from inside our own shadow host
    if (hostEl && (e.target === hostEl || hostEl.contains(e.target))) return;

    const card = findProductCard(e.target);

    if (!card) {
      if (activeCard) scheduleHide();
      return;
    }

    if (card === activeCard) {
      // Still on same card — cancel any pending hide
      clearTimeout(hideTimer);
      return;
    }

    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);

    const url = getProductUrl(card);
    console.log('[HQP] hover start — url:', url || '(none)');

    hoverTimer = setTimeout(() => showToast(card), HOVER_DELAY_MS);
  }

  function onMouseOut(e) {
    const to = e.relatedTarget;

    // BUG FIX: When mouse moves into the shadow toast, Chrome retargets
    // relatedTarget to hostEl (the shadow host), not to an element inside
    // shadowRoot. So shadowRoot.contains(hostEl) === false, which was causing
    // scheduleHide() to fire every time the user moved to the toast.
    // We now explicitly check for hostEl and any element it contains.
    if (to === hostEl || (hostEl && hostEl.contains(to))) {
      console.log('[HQP] mouse moved into toast area — no hide');
      return;
    }

    // Mouse moved to a child element still within the active card
    if (activeCard && activeCard.contains(to)) return;

    console.log('[HQP] hover canceled — mouse left card');
    clearTimeout(hoverTimer);
    scheduleHide();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      // Before hiding, verify the mouse isn't over the toast
      if (isMouseOverToast()) {
        console.log('[HQP] hide suppressed — mouse is still over toast');
        return;
      }
      hideToast();
    }, HIDE_DELAY_MS);
  }

  function isMouseOverToast() {
    if (!hostEl || hostEl.style.display === 'none' || !toastEl) return false;
    const rect = toastEl.getBoundingClientRect();
    return (
      lastMouseX >= rect.left && lastMouseX <= rect.right &&
      lastMouseY >= rect.top  && lastMouseY <= rect.bottom
    );
  }

  // ─── Product Card Detection ────────────────────────────────────────────────
  const KNOWN_SELECTORS = [
    // Google Shopping
    '.sh-dgr__grid-result', '.KZmu8e', '.i0X6df', '.Lqt8jd',
    '[jscontroller][data-docid]',
    // Amazon
    '[data-component-type="s-search-result"]', '.s-result-item',
    // Etsy
    '.v2-listing-card', '[data-listing-id]',
    // Shopify (various themes)
    '.product-card', '.product-item', '.product-card-wrapper',
    '.ProductItem', '.grid-product', '.grid__item',
    // WooCommerce
    'li.product.type-product', '.wc-block-grid__product',
    // eBay
    '.s-item',
    // Zara / H&M
    '.product-grid-product', '[data-productid]',
    // Generic
    '[data-product-id]', '[data-product]', '[data-item-id]',
    '.product-tile', '.product-cell', '.item-card',
  ].join(',');

  const PRODUCT_URL_RE =
    /\/(products?|items?|dp|gp\/product|p\/|listing|listings|catalog\/product|collections\/[^/]+\/products|shop|store|buy|detail|goods|sku|skus)[\/-]/i;
  const PRODUCT_QUERY_RE =
    /[?&](product_id|item_id|sku|asin|pid|prod_id)=/i;

  function findProductCard(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

    try {
      const known = el.closest(KNOWN_SELECTORS);
      if (known && getProductUrl(known)) return known;
    } catch (_) {}

    let node = el;
    for (let depth = 0; depth < 10; depth++) {
      if (!node || node === document.documentElement) break;
      if (looksLikeProductCard(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function looksLikeProductCard(el) {
    const tag = el.tagName;
    if (['BODY','HTML','MAIN','SECTION','HEADER','NAV','FOOTER','ASIDE'].includes(tag)) return false;

    const w = el.offsetWidth, h = el.offsetHeight;
    if (w < 80 || h < 80 || w > 900) return false;

    if (!el.querySelector('img[src]')) return false;

    const link = tag === 'A' ? el : el.querySelector('a[href]');
    if (!link) return false;

    // Normalize URL via spec: new URL(href, base).href
    const rawHref = link.getAttribute('href');
    if (!rawHref) return false;
    try {
      const resolved = new URL(rawHref, window.location.href).href;
      if (PRODUCT_URL_RE.test(resolved) || PRODUCT_QUERY_RE.test(resolved)) return true;
    } catch (_) {}

    const text = el.textContent.slice(0, 400);
    return /[\$€£¥₩]\s?\d+|\d+[.,]\d{2}\s*(USD|EUR|GBP|JPY)/i.test(text);
  }

  function getProductUrl(card) {
    // Priority 1: non-Google link in card
    for (const a of card.querySelectorAll('a[href]')) {
      try {
        const raw = a.getAttribute('href');
        if (!raw) continue;
        const resolved = new URL(raw, window.location.href).href;
        const u = new URL(resolved);
        if (!u.hostname.includes('google.') && u.protocol.startsWith('http')) {
          return resolved;
        }
      } catch (_) {}
    }

    // Priority 2: data-url attribute
    const dataUrl = card.getAttribute('data-url') ||
                    card.querySelector('[data-url]')?.getAttribute('data-url');
    if (dataUrl) {
      try {
        const resolved = new URL(dataUrl, window.location.href).href;
        const u = new URL(resolved);
        if (!u.hostname.includes('google.') && u.protocol.startsWith('http')) return resolved;
      } catch (_) {}
    }

    // Priority 3: main link (may be Google redirect)
    const link = card.tagName === 'A' ? card : card.querySelector('a[href]');
    if (!link) return null;

    try {
      const raw = link.getAttribute('href');
      if (!raw) return null;
      const resolved = new URL(raw, window.location.href).href;
      const u = new URL(resolved);
      if (u.hostname.includes('google.') && u.pathname === '/url') {
        return u.searchParams.get('q') || u.searchParams.get('url') || null;
      }
      return u.protocol.startsWith('http') ? resolved : null;
    } catch (_) {
      return null;
    }
  }

  // ─── Show / Hide Toast ─────────────────────────────────────────────────────
  async function showToast(card) {
    activeCard = card;
    const url = getProductUrl(card);

    if (!url) {
      console.log('[HQP] no product URL — aborting');
      activeCard = null;
      return;
    }

    if (!hostEl) initShadowDom();

    positionNear(card);
    setLoading(true);
    console.log('[HQP] popup mounted (loading state)');

    // Unique token so we can detect if the card changed during async fetch
    const fetchToken = Symbol('fetch');
    activeFetch = fetchToken;

    console.log('[HQP] fetch started —', url);

    let data = null;
    let fetchFailed = false;

    try {
      data = await fetchVariants(url, card);
      if (data) {
        console.log(`[HQP] fetch success — colors:${data.colors.length} sizes:${data.sizes.length} source:${data.source}`);
      } else {
        console.log('[HQP] fetch success — no variant data found');
      }
    } catch (err) {
      fetchFailed = true;
      console.log('[HQP] fetch error —', err && err.message);
    }

    // Guard: card changed while we were fetching
    if (activeFetch !== fetchToken || activeCard !== card) {
      console.log('[HQP] fetch result discarded — card changed during fetch');
      return;
    }

    setLoading(false);

    if (fetchFailed) {
      renderError();
      console.log('[HQP] popup mounted (error state)');
      return;
    }

    if (!data || (!data.colors.length && !data.sizes.length)) {
      // BUG FIX: Previously called hideToast() here, causing the popup to
      // flash briefly and immediately disappear on all sites without parseable
      // variant data (~99% of browsing). Now shows a graceful fallback.
      renderFallback(url, card);
      console.log('[HQP] popup mounted (fallback state)');
      return;
    }

    renderVariants(data);
    console.log('[HQP] popup mounted (variants state)');
  }

  function hideToast() {
    console.log('[HQP] popup removed');
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    activeCard   = null;
    activeFetch  = null;

    if (!toastEl) return;
    toastEl.classList.remove('visible');
    setTimeout(() => {
      if (!activeCard && hostEl) hostEl.style.display = 'none';
    }, 160);
  }

  // ─── Positioning ───────────────────────────────────────────────────────────
  function positionNear(card) {
    const rect = card.getBoundingClientRect();
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;

    // Offset 16px from card right edge — keeps popup away from cursor
    let left = rect.right + 16;
    if (left + TOAST_W > vw - 8) left = rect.left - TOAST_W - 16;
    if (left < 8) left = 8;

    const estimatedH = 200;
    let top = rect.top;
    if (top + estimatedH > vh - 8) top = vh - estimatedH - 8;
    if (top < 8) top = 8;

    hostEl.style.left    = left + 'px';
    hostEl.style.top     = top  + 'px';
    hostEl.style.display = 'block';

    requestAnimationFrame(() => toastEl?.classList.add('visible'));
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────
  function setLoading(on) {
    if (!toastEl) return;
    const spinner = toastEl.querySelector('.spinner');
    const body    = toastEl.querySelector('.body');
    if (on) {
      spinner.classList.add('active');
      body.innerHTML = '<p class="hint">Loading preview…</p>';
    } else {
      spinner.classList.remove('active');
    }
  }

  function renderError() {
    if (!toastEl) return;
    toastEl.querySelector('.body').innerHTML =
      '<p class="hint error">Preview unavailable</p>';
  }

  function renderFallback(url, card) {
    if (!toastEl) return;

    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}

    const heading =
      card?.querySelector('[aria-label]')?.getAttribute('aria-label') ||
      card?.querySelector('h2,h3,h4,[role="heading"]')?.textContent ||
      card?.querySelector('a[href]')?.textContent ||
      '';
    const title = heading.trim().slice(0, 120);

    toastEl.querySelector('.body').innerHTML = `
      ${domain ? `<div class="fallback-domain">${esc(domain)}</div>` : ''}
      ${title   ? `<div class="fallback-title">${esc(title)}</div>`  : ''}
      <p class="hint" style="margin-top:${title || domain ? '6px' : '2px'}">No variant data available</p>
    `;
  }

  const MAX_COLORS = 10;
  const MAX_SIZES  = 12;

  function renderVariants(data) {
    if (!toastEl) return;
    const body = toastEl.querySelector('.body');
    const sections = [];

    if (data.colors.length > 0) {
      const known = [];
      const named = [];
      for (const c of data.colors) {
        const bg = colorNameToCss(c);
        if (bg !== '#D1D5DB') known.push({ name: c, bg });
        else named.push(c);
      }

      let colorHtml = '';
      if (known.length > 0) {
        const visible    = known.slice(0, MAX_COLORS);
        const extra      = known.length - visible.length;
        const swatches   = visible.map(({ name, bg }) =>
          `<span class="swatch" style="background:${bg}" title="${esc(name)}"></span>`
        ).join('');
        const moreBadge  = extra > 0 ? `<span class="more-badge">+${extra}</span>` : '';
        colorHtml += `<div class="swatches">${swatches}${moreBadge}</div>`;
      }
      if (named.length > 0) {
        const visible   = named.slice(0, known.length > 0 ? 6 : MAX_COLORS);
        const extra     = named.length - visible.length;
        const chips     = visible.map((c) =>
          `<span class="color-chip" title="${esc(c)}">
             <span class="color-chip-dot" style="background:#D1D5DB"></span>
             ${esc(c)}
           </span>`
        ).join('');
        const moreBadge = extra > 0 ? `<span class="more-badge">+${extra} more</span>` : '';
        if (known.length > 0) colorHtml += '<div style="height:4px"></div>';
        colorHtml += `<div class="color-chips">${chips}${moreBadge}</div>`;
      }

      sections.push(`
        <div>
          <div class="row">
            <span class="label">Colors</span>
            <span class="count">${data.colors.length}</span>
          </div>
          ${colorHtml}
        </div>
      `);
    }

    if (data.sizes.length > 0) {
      const visible   = data.sizes.slice(0, MAX_SIZES);
      const extra     = data.sizes.length - visible.length;
      const pills     = visible.map((s) =>
        `<span class="size">${esc(s)}</span>`
      ).join('');
      const moreBadge = extra > 0 ? `<span class="more-badge">+${extra} more</span>` : '';
      sections.push(`
        <div>
          <div class="row">
            <span class="label">Sizes</span>
            <span class="count">${data.sizes.length}</span>
          </div>
          <div class="sizes">${pills}${moreBadge}</div>
        </div>
      `);
    }

    const sourceTag = data.source
      ? `<p class="source">via ${esc(data.source)}</p>`
      : '';

    body.innerHTML = sections.join('<div class="divider"></div>') + sourceTag;
  }

  // ─── Data Fetching Pipeline ────────────────────────────────────────────────
  async function fetchVariants(url, card) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

    let data = null;

    data = extractFromCurrentPage(card, url);
    if (data) { cache.set(url, { data, ts: Date.now() }); return data; }

    data = await tryShopifyApi(url);
    if (data) { cache.set(url, { data, ts: Date.now() }); return data; }

    data = await tryBigCommerceApi(url);
    if (data) { cache.set(url, { data, ts: Date.now() }); return data; }

    if (window.location.hostname.includes('google.')) {
      data = extractFromGoogleShoppingPage(card);
      if (data) { cache.set(url, { data, ts: Date.now() }); return data; }
    }

    const html = await fetchPageHtml(url);
    if (html) {
      data = parseProductPage(html, url);
    }

    cache.set(url, { data, ts: Date.now() });
    return data;
  }

  // ─── Layer 0: Current-Page DOM Scan ───────────────────────────────────────
  function extractFromCurrentPage(card, url) {
    if (!card) return null;

    const jsonEl = card.querySelector(
      'script[type="application/json"][data-product-json],' +
      'script[type="application/json"][id*="ProductJson"],' +
      'script[type="application/json"][id*="product-json"],' +
      '[data-product-json],[data-variants],[data-product-variants]'
    );

    if (jsonEl) {
      try {
        const raw = jsonEl.tagName === 'SCRIPT'
          ? jsonEl.textContent
          : (jsonEl.getAttribute('data-product-json') ||
             jsonEl.getAttribute('data-variants') ||
             jsonEl.getAttribute('data-product-variants'));

        const obj = JSON.parse(raw);
        if (obj?.variants?.length) {
          const result = parseShopifyProduct(obj);
          if (result) return { ...result, source: 'page JSON' };
        }
        if (Array.isArray(obj) && obj[0]?.option1 !== undefined) {
          const result = parseShopifyProduct({ variants: obj, options: [] });
          if (result) return { ...result, source: 'page JSON' };
        }
      } catch (_) {}
    }

    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        let raw = JSON.parse(s.textContent.trim());
        const items = [].concat(raw?.['@graph'] || raw);
        for (const item of items) {
          const type = item?.['@type'];
          if (!type) continue;
          const isProduct = type === 'Product' ||
            (Array.isArray(type) && type.includes('Product'));
          if (!isProduct) continue;

          const itemUrl = item.url || item['@id'] || '';
          const urlMatch = !itemUrl ||
            url.includes(new URL(itemUrl, location.href).pathname.replace(/\/$/, '')) ||
            new URL(itemUrl, location.href).pathname === new URL(url).pathname;

          if (!urlMatch) continue;

          const fakeDoc = document.implementation.createHTMLDocument('');
          const fakeScript = fakeDoc.createElement('script');
          fakeScript.type = 'application/ld+json';
          fakeScript.textContent = JSON.stringify(item);
          fakeDoc.head.appendChild(fakeScript);
          const result = parseJsonLd(fakeDoc);
          if (result) return { ...result, source: 'page JSON-LD' };
        }
      } catch (_) {}
    }

    const colors = new Set();
    const sizes  = new Set();
    card.querySelectorAll('[data-color]').forEach((el) => {
      const v = el.getAttribute('data-color');
      if (v && v.length < 60) colors.add(v);
    });
    card.querySelectorAll('[data-colour]').forEach((el) => {
      const v = el.getAttribute('data-colour');
      if (v && v.length < 60) colors.add(v);
    });
    card.querySelectorAll('[data-size]').forEach((el) => {
      const v = el.getAttribute('data-size');
      if (v && v.length < 40) sizes.add(v);
    });
    if (colors.size || sizes.size) {
      return { colors: [...colors], sizes: [...sizes], source: 'card attrs' };
    }

    return null;
  }

  // ─── Strategy: Shopify ────────────────────────────────────────────────────
  function isShopifyPage() {
    return !!document.querySelector(
      'meta[name="shopify-checkout-api-token"],' +
      'link[rel="dns-prefetch"][href*="myshopify.com"],' +
      'script[src*="shopify.com"]'
    );
  }

  async function tryShopifyApi(url) {
    try {
      const u = new URL(url);
      let match = u.pathname.match(/\/products\/([^/?#]+)/);

      if (!match && isShopifyPage()) {
        const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
        match = new URL(canonical, location.href).pathname.match(/\/products\/([^/?#]+)/);
      }

      if (!match) return null;

      const apiUrl = `${u.origin}/products/${match[1]}.js`;
      const res = await bgFetch('FETCH_JSON', apiUrl);
      if (!res?.ok) return null;

      return parseShopifyProduct(res.data);
    } catch (_) {
      return null;
    }
  }

  function parseShopifyProduct(product) {
    if (!product?.variants?.length) return null;

    const opts = product.options || [];
    const colorIdx = opts.findIndex((o) =>
      typeof o === 'string' ? /^colou?r$/i.test(o) : /^colou?r$/i.test(o.name)
    );
    const sizeIdx = opts.findIndex((o) =>
      typeof o === 'string' ? /^size$/i.test(o) : /^size$/i.test(o.name)
    );

    const colors = new Set();
    const sizes  = new Set();

    for (const v of product.variants) {
      if (!v.available) continue;
      if (colorIdx >= 0) colors.add(v[`option${colorIdx + 1}`]);
      if (sizeIdx  >= 0) sizes.add(v[`option${sizeIdx  + 1}`]);
      if (colorIdx < 0 && sizeIdx < 0 && opts.length === 1) {
        const val = v.option1;
        if (val && val !== 'Default Title') sizes.add(val);
      }
    }

    if (!colors.size && !sizes.size && opts.length === 1) {
      const optName = typeof opts[0] === 'string' ? opts[0] : opts[0].name;
      for (const v of product.variants) {
        if (!v.available || !v.option1 || v.option1 === 'Default Title') continue;
        if (/size/i.test(optName)) sizes.add(v.option1);
        else colors.add(v.option1);
      }
    }

    if (!colors.size && !sizes.size) return null;
    return { colors: [...colors], sizes: [...sizes], source: 'Shopify' };
  }

  // ─── Strategy: BigCommerce ────────────────────────────────────────────────
  async function tryBigCommerceApi(url) {
    try {
      const u = new URL(url);
      const isBcPage = !!document.querySelector(
        'script[src*="cdn11.bigcommerce.com"],' +
        'link[href*="bigcommerce.com"],' +
        'meta[name="bigcommerce-theme-id"]'
      );
      if (!isBcPage && !/bigcommerce\.com|mybigcommerce\.com/i.test(u.hostname)) return null;

      const html = await fetchPageHtml(url);
      if (!html) return null;

      const idMatch =
        html.match(/data-product-id="(\d+)"/) ||
        html.match(/"product_id"\s*:\s*(\d+)/) ||
        html.match(/meta\s+itemprop="productID"\s+content="(\d+)"/);

      if (!idMatch) return null;
      const productId = idMatch[1];

      const apiUrl = `${u.origin}/api/storefront/products/${productId}/variants`;
      const res = await bgFetch('FETCH_JSON', apiUrl);
      if (!res?.ok || !Array.isArray(res.data)) return null;

      const colors = new Set();
      const sizes  = new Set();

      for (const variant of res.data) {
        if (!variant.option_values) continue;
        for (const ov of variant.option_values) {
          const label = (ov.option_display_name || '').toLowerCase();
          const val   = ov.label || '';
          if (!val) continue;
          if (/colou?r/.test(label)) colors.add(val);
          else if (/size/.test(label)) sizes.add(val);
        }
      }

      if (!colors.size && !sizes.size) return null;
      return { colors: [...colors], sizes: [...sizes], source: 'BigCommerce' };
    } catch (_) {
      return null;
    }
  }

  // ─── Strategy: Google Shopping ────────────────────────────────────────────
  function extractFromGoogleShoppingPage(card) {
    try {
      const ldResult = parseJsonLd(document);
      if (ldResult) return { ...ldResult, source: 'Google Shopping' };

      const colors = new Set();
      const sizes  = new Set();

      const cardTitle = (
        card.querySelector('[aria-label]')?.getAttribute('aria-label') ||
        card.querySelector('h3,h4,[role="heading"]')?.textContent ||
        ''
      ).toLowerCase().trim().slice(0, 60);

      for (const script of document.querySelectorAll('script:not([src])')) {
        const t = script.textContent;
        if (!t.includes('"offers"') && !t.includes('"Product"') &&
            !t.includes('colorImages') && !t.includes('AF_initDataCallback')) continue;
        if (cardTitle && cardTitle.length > 5 && !t.toLowerCase().includes(cardTitle.slice(0, 20))) {
          continue;
        }

        const ldRe = /\{[^{}]*"@type"\s*:\s*"Product"[^{}]*\}/g;
        for (const m of t.matchAll(ldRe)) {
          try {
            const fakeDoc = document.implementation.createHTMLDocument('');
            const fakeScript = fakeDoc.createElement('script');
            fakeScript.type = 'application/ld+json';
            fakeScript.textContent = m[0];
            fakeDoc.head.appendChild(fakeScript);
            const result = parseJsonLd(fakeDoc);
            if (result) return { ...result, source: 'Google Shopping' };
          } catch (_) {}
        }

        extractAmazonDimension(t, 'color_name', colors);
        extractAmazonDimension(t, 'size_name', sizes);
        extractColorImageKeys(t, colors);
      }

      if (colors.size || sizes.size) {
        return { colors: [...colors], sizes: [...sizes], source: 'Google Shopping' };
      }
    } catch (_) {}

    return null;
  }

  // ─── Strategy: Fetch HTML + Parse ─────────────────────────────────────────
  async function fetchPageHtml(url) {
    const res = await bgFetch('FETCH_HTML', url);
    return res?.ok ? res.data : null;
  }

  function parseProductPage(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (
      parseJsonLd(doc) ||
      parseAmazon(doc, url) ||
      parseWooCommerce(doc) ||
      parseGenericDataAttrs(doc)
    );
  }

  // ─── Parser: JSON-LD ──────────────────────────────────────────────────────
  function parseJsonLd(doc) {
    const colors = new Set();
    const sizes  = new Set();
    let foundProduct = false;

    for (const scriptEl of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        let raw = JSON.parse(scriptEl.textContent.trim());
        const items = [].concat(raw?.['@graph'] || raw);

        for (const item of items) {
          const type = item?.['@type'];
          if (!type) continue;
          const isProduct = type === 'Product' ||
            (Array.isArray(type) && type.includes('Product'));
          if (!isProduct) continue;

          foundProduct = true;
          const offers = [].concat(item.offers || []);

          for (const offer of offers) {
            if (!offer) continue;
            const avail = offer.availability || 'https://schema.org/InStock';
            if (/OutOfStock|Discontinued|SoldOut/i.test(avail)) continue;
            if (offer.color) colors.add(offer.color);
            if (offer.size)  sizes.add(offer.size);
            for (const prop of [].concat(offer.additionalProperty || [])) {
              const name = (prop.name || '').toLowerCase();
              if (name.includes('color') || name.includes('colour')) colors.add(prop.value);
              if (name.includes('size')) sizes.add(prop.value);
            }
          }

          if (item.color && colors.size === 0) colors.add(item.color);
        }
      } catch (_) {}
    }

    if (!foundProduct) return null;
    if (!colors.size && !sizes.size) return null;
    return { colors: [...colors], sizes: [...sizes], source: 'Schema.org' };
  }

  // ─── Parser: Amazon ───────────────────────────────────────────────────────
  function parseAmazon(doc, url) {
    if (!/amazon\./i.test(url)) return null;

    const colors = new Set();
    const sizes  = new Set();

    for (const s of doc.querySelectorAll('script:not([src])')) {
      const t = s.textContent;
      if (!t.includes('colorImages') && !t.includes('dimensionValues') &&
          !t.includes('color_name') && !t.includes('size_name')) continue;
      extractColorImageKeys(t, colors);
      extractAmazonDimension(t, 'color_name', colors);
      extractAmazonDimension(t, 'size_name',  sizes);
    }

    doc.querySelectorAll(
      '#variation_color_name li:not(.swatchUnavailable) .swatch-title,' +
      '#variation_color_name .swatchAvailable'
    ).forEach((el) => {
      const v = (el.getAttribute('title') || el.textContent)
        .replace(/Click to select\s*/gi, '').trim();
      if (v && v.length < 60) colors.add(v);
    });

    doc.querySelectorAll(
      '#variation_size_name li:not(.swatchUnavailable) .swatch-title,' +
      '#variation_size_name .swatchAvailable'
    ).forEach((el) => {
      const v = (el.getAttribute('title') || el.textContent).trim();
      if (v && v.length < 40) sizes.add(v);
    });

    if (!colors.size && !sizes.size) return null;
    return { colors: [...colors], sizes: [...sizes], source: 'Amazon' };
  }

  function extractAmazonDimension(scriptText, dimKey, targetSet) {
    const startRe = new RegExp(`"${dimKey}"\\s*:\\s*\\[`);
    const startMatch = startRe.exec(scriptText);
    if (!startMatch) return;

    let depth = 1;
    let i = startMatch.index + startMatch[0].length;
    while (i < scriptText.length && depth > 0) {
      const ch = scriptText[i];
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      i++;
    }
    const arrayStr = '[' + scriptText.slice(startMatch.index + startMatch[0].length, i - 1) + ']';

    try {
      const arr = JSON.parse(arrayStr);
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const state = item.dimensionValueState;
        if (state && state !== 'AVAILABLE') continue;
        const text = item.dimensionValueDisplayText;
        if (text && typeof text === 'string' && text.length < 60 && !text.startsWith('http')) {
          targetSet.add(text.trim());
        }
      }
    } catch (_) {
      for (const m of arrayStr.matchAll(/"dimensionValueDisplayText"\s*:\s*"([^"]{1,60})"/g)) {
        targetSet.add(m[1].trim());
      }
    }
  }

  function extractColorImageKeys(scriptText, targetSet) {
    const startRe = /"colorImages"\s*:\s*\{/;
    const m = startRe.exec(scriptText);
    if (!m) return;

    let depth = 1;
    let i = m.index + m[0].length;
    while (i < scriptText.length && depth > 0) {
      const ch = scriptText[i];
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      i++;
    }

    const inner = scriptText.slice(m.index + m[0].length, i - 1);

    for (const km of inner.matchAll(/"([^"\\]{1,60})"\s*:\s*[\[{]/g)) {
      const name = km[1].trim();
      if (!name) continue;
      if (name.startsWith('http')) continue;
      if (/^[a-z][a-zA-Z0-9]*$/.test(name)) continue;
      if (/^\d+$/.test(name)) continue;
      if (name.length > 1) targetSet.add(name);
    }
  }

  // ─── Parser: WooCommerce ──────────────────────────────────────────────────
  function parseWooCommerce(doc) {
    const form = doc.querySelector('form.variations_form');
    if (!form) return null;

    const colors = new Set();
    const sizes  = new Set();

    form.querySelectorAll('select').forEach((sel) => {
      const name = (sel.name || sel.getAttribute('name') || '').toLowerCase();
      sel.querySelectorAll('option:not([value=""])').forEach((opt) => {
        const val = opt.textContent.trim();
        if (!val || /choose/i.test(val)) return;
        if (/colou?r/.test(name)) colors.add(val);
        else if (/size/.test(name)) sizes.add(val);
        else sizes.add(val);
      });
    });

    if (!colors.size && !sizes.size) return null;
    return { colors: [...colors], sizes: [...sizes], source: 'WooCommerce' };
  }

  // ─── Parser: Generic data-* attrs ────────────────────────────────────────
  function parseGenericDataAttrs(doc) {
    const colors = new Set();
    const sizes  = new Set();
    const unavailSelectors = '.sold-out, .unavailable, .out-of-stock, [aria-disabled="true"]';

    doc.querySelectorAll('[data-color]:not(.sold-out):not(.unavailable)').forEach((el) => {
      if (!el.closest(unavailSelectors)) colors.add(el.dataset.color);
    });
    doc.querySelectorAll('[data-colour]:not(.sold-out)').forEach((el) => {
      if (!el.closest(unavailSelectors)) colors.add(el.dataset.colour);
    });
    doc.querySelectorAll('[data-size]:not(.sold-out):not(.unavailable)').forEach((el) => {
      if (!el.closest(unavailSelectors)) sizes.add(el.dataset.size);
    });

    if (!colors.size && !sizes.size) return null;
    return { colors: [...colors], sizes: [...sizes], source: 'page data' };
  }

  // ─── Background Script Bridge ──────────────────────────────────────────────
  function bgFetch(type, url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, url }, (res) => {
          if (chrome.runtime.lastError) {
            console.log('[HQP] bgFetch error —', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch (err) {
        console.log('[HQP] bgFetch threw —', err && err.message);
        resolve(null);
      }
    });
  }

  // ─── Color Utilities ──────────────────────────────────────────────────────
  const COLOR_MAP = {
    red:'#EF4444', crimson:'#DC143C', scarlet:'#FF2400', burgundy:'#800020',
    maroon:'#800000', wine:'#722F37', rose:'#FB7185', coral:'#FF6B6B',
    blue:'#3B82F6', navy:'#1E3A8A', cobalt:'#0047AB', sky:'#38BDF8',
    denim:'#1560BD', indigo:'#4F46E5', royal:'#4169E1', steel:'#4682B4',
    green:'#22C55E', olive:'#6B7280', forest:'#228B22', sage:'#8FAF8F',
    emerald:'#50C878', jade:'#00A86B', mint:'#98FF98', lime:'#A3E635',
    yellow:'#EAB308', gold:'#F59E0B', mustard:'#FFDB58', lemon:'#FFF44F',
    orange:'#F97316', amber:'#F59E0B', peach:'#FFDAB9', apricot:'#FBCEB1',
    purple:'#A855F7', violet:'#8B5CF6', lavender:'#E6E6FA', plum:'#8E4585',
    pink:'#EC4899', magenta:'#FF00FF', fuchsia:'#FF00FF', blush:'#FFB6C1',
    mauve:'#E0B0FF', lilac:'#C8A2C8',
    black:'#111827', charcoal:'#374151', graphite:'#4B5563',
    white:'#F9FAFB', ivory:'#FFFFF0', cream:'#FFFDD0', eggshell:'#F0EAD6',
    gray:'#9CA3AF', grey:'#9CA3AF', silver:'#C0C0C0',
    brown:'#92400E', tan:'#D2B48C', beige:'#F5F5DC', camel:'#C19A6B',
    khaki:'#C3B091', taupe:'#483C32', mocha:'#967969', nude:'#E3BC9A',
    teal:'#14B8A6', aqua:'#00FFFF', turquoise:'#40E0D0', cyan:'#06B6D4',
  };

  function colorNameToCss(name) {
    const lower = name.toLowerCase().trim();
    if (COLOR_MAP[lower]) return COLOR_MAP[lower];
    for (const [key, val] of Object.entries(COLOR_MAP)) {
      if (lower.includes(key)) return val;
    }
    if (/^#?[0-9a-f]{3,8}$/i.test(lower)) {
      return lower.startsWith('#') ? lower : '#' + lower;
    }
    return '#D1D5DB';
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();
