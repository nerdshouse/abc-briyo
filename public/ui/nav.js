/**
 * Client-side navigation between the pages that share the app shell.
 *
 * The server still serves every URL as a complete page, and still decides who
 * may see it. This only changes what happens *between* those pages: instead
 * of a full reload, the next page is fetched, and just its content area (plus
 * its drawers and menus) is swapped in. The sidebar and top bar stay mounted.
 *
 * Page scripts cooperate through three hooks:
 *   pageSignal()      pass as { signal } to document/window listeners, so they
 *                     are removed when the page is left
 *   onLeave(fn)       cleanup on leave: timers, intervals
 *   onQueryChange(fn) same page, new query string (e.g. /orders?channel=…):
 *                     the page refreshes itself in place instead of a swap
 *
 * Anything uncertain falls back to a normal browser navigation.
 */

// Only these paths share the shell. Everything else (Members, Import, login,
// auth, API, downloads) is left to the browser.
const SHELL_PATHS = new Set(['/', '/dashboard', '/orders', '/couriers']);

let ctl = new AbortController();
let leaveFns = [];
let queryHandler = null;
let started = false;
let navSeq = 0;
// The page actually on screen. On Back/Forward the address bar has already
// moved, so it cannot answer "is this the same page?".
let shownPath = window.location.pathname;

export const pageSignal = () => ctl.signal;
export function onLeave(fn) { leaveFns.push(fn); }
export function onQueryChange(fn) { queryHandler = fn; }

/**
 * fetch() tied to the page that called it. Once that page is left, its
 * requests are cancelled and any late response is dropped — the promise simply
 * never settles — so an old page can never render into the new one.
 */
export function pageFetch() {
  const sig = ctl.signal;
  const never = () => new Promise(() => {});
  return async (url, opts = {}) => {
    try {
      const res = await window.fetch(url, { ...opts, signal: sig });
      if (sig.aborted) return never();
      for (const m of ['json', 'text', 'blob', 'arrayBuffer']) {
        const read = res[m].bind(res);
        res[m] = async () => { const v = await read(); return sig.aborted ? never() : v; };
      }
      return res;
    } catch (err) {
      if (sig.aborted) return never();
      throw err;
    }
  };
}

function leavePage() {
  ctl.abort();
  for (const fn of leaveFns) { try { fn(); } catch { /* a cleanup must not block navigation */ } }
  ctl = new AbortController();
  leaveFns = [];
  queryHandler = null;
}

const isShellUrl = (url) => url.origin === window.location.origin && SHELL_PATHS.has(url.pathname);

/* ------------------------------------------------------------------ progress */

let bar = null;
let barTimer = null;
function progress(on) {
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'nav-progress';
    document.body.appendChild(bar);
  }
  clearTimeout(barTimer);
  if (on) {
    // Only visible if the wait is noticeable; quick swaps show nothing.
    barTimer = setTimeout(() => bar.classList.add('on'), 120);
    document.querySelector('main.page')?.setAttribute('aria-busy', 'true');
  } else {
    bar.classList.remove('on');
    document.querySelector('main.page')?.removeAttribute('aria-busy');
  }
}

/* ------------------------------------------------------------------ sidebar */

/** Highlights the sidebar link for the current URL: exact match first, then same path. */
export function syncSidebarActive() {
  const here = window.location.pathname + window.location.search;
  const links = [...document.querySelectorAll('.sidebar a.nav-item')]
    .filter((a) => !a.hasAttribute('download'));
  const target = links.find((a) => a.getAttribute('href') === here)
    || links.find((a) => new URL(a.href).pathname === window.location.pathname && !new URL(a.href).search)
    || links.find((a) => new URL(a.href).pathname === window.location.pathname);
  for (const a of links) {
    const on = a === target;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

/* ------------------------------------------------------------------ swap */

const saveScroll = () => {
  try { history.replaceState({ ...(history.state || {}), nav: true, scroll: window.scrollY }, ''); } catch { /* ignore */ }
};

async function syncStylesheets(doc) {
  const wanted = [...doc.querySelectorAll('head link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
  const have = [...document.querySelectorAll('head link[rel="stylesheet"]')];
  const loads = [];
  for (const href of wanted) {
    if (have.some((l) => l.getAttribute('href') === href)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    loads.push(new Promise((ok) => { link.onload = ok; link.onerror = ok; }));
    document.head.appendChild(link);
  }
  await Promise.all(loads);
  // Old page's own styles go only after the new ones are in, so nothing flashes.
  return () => { for (const l of have) if (!wanted.includes(l.getAttribute('href'))) l.remove(); };
}

async function swapTo(url, { push, scroll }) {
  const seq = ++navSeq;
  const res = await fetch(url.href, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
  const finalUrl = new URL(res.url);
  // Signed out, forbidden, redirected off the shell, or not a page: let the
  // browser (and the server) handle it exactly as a normal visit would.
  if (!res.ok || !isShellUrl(finalUrl) || !(res.headers.get('content-type') || '').includes('text/html')) {
    throw new Error('not a shell page');
  }
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const nextMain = doc.querySelector('.app main.page');
  const script = [...doc.querySelectorAll('body script[type="module"][src]')].pop();
  if (!nextMain || !script || !doc.querySelector('.app .sidebar')) throw new Error('page is not on the shell');
  if (seq !== navSeq) return; // a newer navigation started; this one is stale

  const dropOldStyles = await syncStylesheets(doc);
  leavePage();

  // Content area.
  document.querySelector('.app main.page').replaceWith(document.importNode(nextMain, true));
  // Page-level overlays: drawers, scrims, popovers — everything in <body>
  // outside the shell except scripts and the progress bar.
  for (const el of [...document.body.children]) {
    if (!el.matches('.app, script, .nav-progress')) el.remove();
  }
  for (const el of [...doc.body.children]) {
    if (!el.matches('.app, script')) document.body.appendChild(document.importNode(el, true));
  }
  // Shell text that differs per page.
  document.title = doc.title;
  const topTitle = doc.querySelector('.topbar-title');
  if (topTitle) document.querySelector('.topbar-title').textContent = topTitle.textContent;
  const brand = doc.querySelector('.sidebar .brand');
  if (brand) document.querySelector('.sidebar .brand').innerHTML = brand.innerHTML;
  dropOldStyles();

  shownPath = finalUrl.pathname;
  if (push) history.pushState({ nav: true, scroll: 0 }, '', finalUrl.href);
  else if (finalUrl.href !== window.location.href) history.replaceState({ nav: true, scroll: 0 }, '', finalUrl.href);
  document.querySelector('.app')?.classList.remove('nav-open');
  syncSidebarActive();
  window.scrollTo(0, scroll ?? 0);

  // A fresh instance of the page's script: its module state starts clean and
  // it binds to the new DOM. Listeners from the old instance were aborted above.
  const src = new URL(script.getAttribute('src'), finalUrl);
  src.searchParams.set('nav', String(seq));
  await import(src.pathname + src.search);
}

/**
 * Go to `href` inside the app. Same page + new query → the page's own
 * refresh; another shell page → swap; anything else → normal navigation.
 */
export async function navigate(href, { push = true, scroll = null } = {}) {
  const url = new URL(href, window.location.href);
  if (!isShellUrl(url)) { window.location.href = url.href; return; }
  if (push) saveScroll();
  progress(true);
  try {
    if (url.pathname === shownPath && queryHandler) {
      if (push) history.pushState({ nav: true, scroll: window.scrollY }, '', url.href);
      document.querySelector('.app')?.classList.remove('nav-open');
      syncSidebarActive();
      await queryHandler(url);
      if (scroll !== null) window.scrollTo(0, scroll);
    } else {
      await swapTo(url, { push, scroll });
    }
  } catch {
    window.location.href = url.href; // never leave someone in a half-changed page
  } finally {
    progress(false);
  }
}

function eligibleLink(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.target.closest('a[href]');
  if (!a || a.hasAttribute('download') || a.dataset.fullNav !== undefined) return null;
  if (a.target && a.target !== '_self') return null;
  const url = new URL(a.href, window.location.href);
  if (!isShellUrl(url)) return null;
  // A pure #hash link on the same page is left to the browser.
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null;
  return url;
}

/** Called once per full page load (from initShell). */
export function startRouter() {
  if (started) return;
  started = true;
  try { history.replaceState({ ...(history.state || {}), nav: true, scroll: window.scrollY }, ''); } catch { /* ignore */ }
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  document.addEventListener('click', (e) => {
    const url = eligibleLink(e);
    if (!url) return;
    e.preventDefault();
    navigate(url.href);
  });
  window.addEventListener('popstate', (e) => {
    navigate(window.location.href, { push: false, scroll: e.state?.scroll ?? 0 });
  });
}
