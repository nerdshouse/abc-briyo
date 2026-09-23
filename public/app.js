'use strict';

const STATUSES = [
  'Not called',
  'Called – No answer',
  'Callback scheduled',
  'Called – Recovered',
  'Called – Declined',
];

/** Call-priority ranking for the risk sort. Anything unrecognised sorts last. */
const RISK_ORDER = {
  'high risk': 3,
  'medium risk': 2,
  'low risk': 1,
  control: 0,
};

let REASON_TAGS = [];
let SLA_HOURS = 6;

let TEAM = [];
let ME = null;

/**
 * Queue modes, in the order a caller works.
 *
 * These replace the old status/stage/assignee/mine/overdue filters. Those were
 * five independent switches that could combine into states nobody wanted and
 * that the controls could not always display back accurately; these four are
 * mutually exclusive and each answers "what am I working on right now".
 */
const MODES = {
  tocall:    { label: 'To call',   sort: 'value',    match: (c) => (c.status || 'Not called') === 'Not called' },
  callbacks: { label: 'Callbacks', sort: 'callback', match: (c) => c.status === 'Callback scheduled' },
  mine:      { label: 'Mine',      sort: 'value',    match: (c) => c.assigned_to === ME },
  all:       { label: 'All',       sort: 'recent',   match: () => true },
};

const state = {
  carts: [],
  query: '',
  days: 7,       // default range: last 7 days
  mode: 'tocall',
  sort: 'value',
  sortTouched: false,   // once set by hand, stop re-picking it per mode
};

const cartById = (id) => state.carts.find((c) => String(c.id) === String(id));

const $ = (sel) => document.querySelector(sel);

/** Attach a listener only if the element exists — a missing control should
 *  never throw and take the whole board down with it. */
function on(sel, event, handler) {
  const el = $(sel);
  if (el) el.addEventListener(event, handler);
  else console.warn(`No element matches ${sel}; skipping ${event} handler.`);
}
const queueEl = $('#queue');
const errorEl = $('#errorBanner');

// ---------- formatting helpers ----------

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});

function money(amount, currency) {
  if (amount == null) return '—';
  if (!currency || currency === 'INR') return inr.format(amount);
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * Convert an Indian number to wa.me's 91XXXXXXXXXX form.
 * Returns null when it doesn't look like a usable number.
 */
function waNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;          // bare 10-digit mobile
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;               // already country-coded
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`; // leading trunk 0
  return digits.length >= 10 ? digits : null;                     // non-IN, pass through
}

function waMessage(cart) {
  const name = cart.customer_name ? cart.customer_name.split(' ')[0] : 'there';
  return `Hi ${name}! This is Briyo Supplements. We noticed you left a few items in your cart — ` +
         `can we help you complete your order? Here's your cart: ${cart.checkout_url || ''}`;
}

/**
 * Line items stay in raw_payload rather than becoming columns, because GoKwik
 * sends them either as an array or as a "#Name(Variant)*1" string. The server
 * exposes the parsed form on each cart; fall back to the raw shapes if absent.
 */
function itemsOf(cart) {
  if (Array.isArray(cart.items) && cart.items.length) return cart.items;
  const raw = cart.raw_payload || {};
  const list = raw.items || raw.line_items || raw.lineItems || raw.products || [];
  if (!Array.isArray(list)) return [];
  return list.map((i) => ({
    title: i?.title || i?.name || i?.product_name || i?.sku || 'Item',
    quantity: Number(i?.quantity ?? i?.qty ?? 1),
  }));
}

const riskClass = (flag) => 'risk-' + String(flag || '').toLowerCase().split(' ')[0];
/** "Medium Risk" -> "Medium". The column header and colour already say risk. */
const shortRisk = (flag) => String(flag || '').replace(/\s*risk\s*/i, '').trim() || flag;

/**
 * Product names here run long ("Daily Wellness Starter Bundle – Vitamin D3 +
 * Fish Oil + B12"), and stacking three of them in full made a single row fill
 * the screen. A caller needs to recognise the order at a glance, not read the
 * catalogue: show a count, the first two names on one line each, and hide the
 * rest behind a disclosure. Full text stays in the title attribute.
 */
function itemsCell(cart) {
  const items = itemsOf(cart);
  if (!items.length) {
    return cart.item_count
      ? `<span class="muted">${cart.item_count} item${cart.item_count === 1 ? '' : 's'}</span>`
      : '<span class="muted">—</span>';
  }

  // The pack size is the part a caller needs and the part truncation eats, since
  // it sits at the end of the name. Pull it out so it always stays visible.
  const splitPack = (title) => {
    const m = String(title).match(/^(.*?)\s*[-–]\s*((?:Pack of|Box of)\s*\d+|\d+\s*Box(?:es)?)\s*$/i);
    return m ? { name: m[1].trim(), pack: m[2].trim() } : { name: title, pack: null };
  };

  const line = (i) => {
    const { name, pack } = splitPack(i.title);
    return `<div class="item" title="${esc(i.title)}">`
      + `<span class="iname">${esc(name)}</span>`
      + `${pack ? ` <span class="pack">${esc(pack)}</span>` : ''}`
      + `${i.quantity > 1 ? ` <span class="qty">×${i.quantity}</span>` : ''}</div>`;
  };

  const units = items.reduce((n, i) => n + (i.quantity || 1), 0);
  const head = items.slice(0, 3).map(line).join('');
  const rest = items.slice(3);

  return (items.length > 1
      ? `<div class="itemcount">${items.length} products · ${units} unit${units === 1 ? '' : 's'}</div>`
      : '')
    + head
    + (rest.length
      // The label has to change when it opens, or expanding looks like nothing
      // happened — the extra rows appear but the toggle still says "+1 more".
      ? `<details class="moreitems">
           <summary><span class="lbl-more">+${rest.length} more</span><span class="lbl-less">Show less</span></summary>
           ${rest.map(line).join('')}
         </details>`
      : '');
}

/**
 * GoKwik runs its own recovery email/messaging. Showing that lets a caller open
 * with the right line instead of repeating a message the customer already got —
 * and is why this board deliberately sends nothing automatically.
 */
function gokwikTouch(cart) {
  const bits = [];
  if (cart.gokwik_message_queued) bits.push('msg sent');
  if (cart.gokwik_email_sent) bits.push('email sent');
  const already = bits.length
    ? `<div class="touched" title="GoKwik already contacted this customer — ${bits.join(' + ')}">Nudged</div>`
    : '';
  const repeat = cart.brand_order_count > 0
    ? `<div class="repeat" title="Has ordered ${cart.brand_order_count} time(s) before">Repeat ×${cart.brand_order_count}</div>`
    : '';
  return already + repeat;
}

/** Overdue / due-today state for a scheduled callback. */
function callbackState(cart) {
  if (cart.status !== 'Callback scheduled' || !cart.callback_at) return null;
  const due = new Date(cart.callback_at);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  if (due < now) return { kind: 'overdue', label: 'Overdue', due };
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  if (due <= endOfDay) return { kind: 'due-today', label: 'Due today', due };
  return { kind: 'scheduled', label: due.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }), due };
}

/** Used by the Callbacks queue's sort tie-break and by the overdue chip. */
const isOverdue = (c) => callbackState(c)?.kind === 'overdue';

/** <input type="datetime-local"> needs local wall-clock, not an ISO UTC string. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------- data ----------

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
}

/**
 * The free Render instance sleeps after 15 minutes and takes up to a minute to
 * wake, so the first request after a quiet spell can fail outright at the
 * network level ("Failed to fetch"). Retry a couple of times before giving up,
 * and say what's happening rather than showing a bare error.
 */
/**
 * Filters can arrive in the URL so other pages can link to a filtered board —
 * "which ones?" from the dashboard lands here already narrowed.
 *
 * Applied from inside loadAll rather than at module top level: this is the code
 * path that definitely runs before the first render, and it cannot race the
 * DOM being ready.
 */
let urlFiltersApplied = false;
function applyUrlFilters() {
  if (urlFiltersApplied) return;
  urlFiltersApplied = true;

  const p = new URLSearchParams(window.location.search);
  if (p.has('days')) {
    state.days = Number(p.get('days'));
    $('#rangeGroup')?.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.days) === state.days));
  }
  if (p.has('q')) { state.query = p.get('q'); if ($('#search')) $('#search').value = state.query; }

  // Old links carried status/mine/overdue params. Map the ones that have an
  // obvious home so a bookmark still lands somewhere sensible, rather than
  // silently ignoring them and showing an unexpected list.
  const legacy = p.get('status') === 'Not called' ? 'tocall'
    : p.get('status') === 'Callback scheduled' || p.get('overdue') === '1' ? 'callbacks'
    : p.get('mine') === '1' ? 'mine'
    : p.has('status') ? 'all'
    : null;
  if (p.has('mode') && MODES[p.get('mode')]) state.mode = p.get('mode');
  else if (legacy) state.mode = legacy;

  state.sort = MODES[state.mode].sort;
  if ($('#sort')) $('#sort').value = state.sort;
}

async function loadAll(attempt = 1) {
  applyUrlFilters();
  const MAX_ATTEMPTS = 3;
  try {
    // The date range is now applied server-side, so the array stays small and
    // every other filter and sort can stay client-side over it.
    const params = state.query
      ? `q=${encodeURIComponent(state.query)}`
      : `days=${state.days}`;
    const [cfgRes, cartsRes] = await Promise.all([
      fetch('/api/config'), fetch(`/api/carts?${params}`),
    ]);
    if ([cfgRes, cartsRes].some((r) => r.status === 401)) {
      window.location.href = '/login';
      return;
    }
    const cfg = await cfgRes.json();
    const carts = await cartsRes.json();
    if (Array.isArray(cfg.reasonTags)) REASON_TAGS = cfg.reasonTags;
    if (cfg.slaHours) SLA_HOURS = cfg.slaHours;
    if (Array.isArray(cfg.team)) TEAM = cfg.team;
    ME = cfg.me ?? ME;

    if (cfg.mock) $('#mockBanner').hidden = false;
    if (!carts.ok) throw new Error(carts.error || 'Could not load carts');

    state.carts = carts.carts;
    state.stale = carts.stale || null;
    state.total = carts.total ?? carts.carts.length;
    state.truncated = Boolean(carts.truncated);
    renderResultNote();
    syncExportLink();

    clearError();
    render();
    renderInsights();   // range may have changed; this is the only place it can
  } catch (err) {
    // A TypeError from fetch means the request never completed — server asleep,
    // restarting, or the network dropped. An HTTP error would not land here.
    const networkLevel = err instanceof TypeError;
    if (networkLevel && attempt < MAX_ATTEMPTS) {
      showError(`Server isn't responding — it may be waking up. Retrying (${attempt}/${MAX_ATTEMPTS - 1})…`);
      queueEl.innerHTML = skeletonCards(3);
      await new Promise((r) => setTimeout(r, attempt * 4000));
      return loadAll(attempt + 1);
    }
    showError(networkLevel
      ? "Couldn't reach the server after several tries — it may still be starting up. Press Refresh in a moment."
      : `Could not load the board: ${err.message}`);
    queueEl.innerHTML = '<div class="empty-state"><h3>Failed to load</h3></div>';
  }
}

/** Save one row. Never re-renders the row being edited, so in-progress text survives. */
async function saveRow(id, patch, noteEl) {
  const cell = document.querySelector(`[data-row="${CSS.escape(id)}"] .saved`);
  if (cell) { cell.textContent = 'Saving…'; cell.className = 'saved pending'; }

  try {
    const res = await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Sent so the server can tell if someone else saved since we last read.
      body: JSON.stringify({ id, seenAt: cartById(id)?.status_updated_at ?? null, ...patch }),
    });
    const data = await res.json();

    if (res.status === 409 && data.conflict) {
      showError(`${data.error} Your text is still here — reload to see theirs, or save again to overwrite.`);
      if (cell) { cell.textContent = 'Not saved — conflict'; cell.className = 'saved failed'; }
      // Adopt their timestamp so a deliberate second save goes through.
      const cart = cartById(id);
      if (cart && data.current) cart.status_updated_at = data.current.status_updated_at;
      return;
    }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Update the row in place; never re-render it, so an in-progress edit survives.
    const cart = cartById(id);
    if (cart) {
      cart.status = data.entry.status;
      cart.notes = data.entry.notes;
      cart.status_updated_at = data.entry.status_updated_at;
      cart.callback_at = data.entry.callback_at ?? null;
      cart.reason_tags = data.entry.reason_tags ?? cart.reason_tags ?? [];
      cart.updated_by = data.entry.updated_by ?? cart.updated_by;
      if ('assigned_to' in data.entry) {
        cart.assigned_to = data.entry.assigned_to;
        cart.assigned_to_name = data.entry.assigned_to_name;
      }
    }
    clearError();
    if (cell) { cell.textContent = savedLabel(cart || data.entry); cell.className = 'saved'; }

    // Chips and the callback badge reflect the just-saved values without a
    // full re-render, which would discard any in-progress edit on other rows.
    const tr = document.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (tr && cart) {
      const chips = tr.querySelector('.chips');
      if (chips) {
        chips.innerHTML = (cart.reason_tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
      }
      const summary = tr.querySelector('.tagpick summary');
      if (summary) summary.textContent = (cart.reason_tags || []).length ? 'Edit reasons' : '+ reason';

      // Owner cell: keep the select, the "mine" marker and the Take it button
      // in step without a full re-render, which would discard other rows' edits.
      const assignSel = tr.querySelector('.js-assign');
      if (assignSel) assignSel.value = cart.assigned_to || '';
      tr.dataset.mine = String(cart.assigned_to === ME);
      const takeIt = tr.querySelector('.js-takeit');
      if (cart.assigned_to && takeIt) takeIt.remove();
      if (!cart.assigned_to && !takeIt && ME && assignSel) {
        assignSel.insertAdjacentHTML('afterend',
          `<button type="button" class="linky js-takeit" data-id="${esc(cart.id)}">Take it</button>`);
      }
    }
    if (tr) {
      tr.dataset.status = data.entry.status;
      // The card stays put rather than vanishing mid-edit — losing the row
      // under your cursor is worse than seeing it a moment longer — but it
      // dims once it no longer belongs in the queue you are working.
      tr.classList.toggle('cc-done', !MODES[state.mode].match(cartById(id) || {}));
    }
    // Counts move with every save, so they cannot be left to the next reload.
    renderModes();
    renderSummary();
    scheduleInsights();
  } catch (err) {
    // Keep the user's edit on screen; just tell them it isn't saved.
    showError(`Couldn't save that change: ${err.message} — your edit is still here, try again.`);
    if (cell) { cell.textContent = 'Not saved'; cell.className = 'saved failed'; }
    if (noteEl) noteEl.focus();
  }
}

// ---------- rendering ----------

function visibleCarts() {
  // No date filter here on purpose. The server already applied the range in
  // listCarts, using a calendar-day boundary; this used to re-apply a *rolling*
  // days*24h cutoff over the same rows, so "Today" hid rows the server had sent
  // and the board disagreed with the dashboard. Worse, searchCarts deliberately
  // ignores the range — "that customer from three weeks ago just rang back" —
  // and this line threw those hits away before they could ever be shown.
  // A search is already the filter — narrowing it by queue mode as well would
  // hide the customer who just rang back, which is the only reason to search.
  const list = state.query
    ? state.carts.slice()
    : state.carts.filter(MODES[state.mode].match);

  return list.sort((a, b) => {
    if (state.sort === 'value') return (b.total_price ?? 0) - (a.total_price ?? 0);
    if (state.sort === 'callback') {
      // Carts with a callback come first, soonest due at the top.
      const due = (c) => (c.status === 'Callback scheduled' && c.callback_at
        ? new Date(c.callback_at).getTime() : Infinity);
      return due(a) - due(b);
    }
    if (state.sort === 'risk') {
      const rank = (c) => RISK_ORDER[String(c.risk_flag || '').toLowerCase()] ?? -1;
      // Within the same risk band, bigger carts first — that's the call order.
      return (rank(b) - rank(a)) || ((b.total_price ?? 0) - (a.total_price ?? 0));
    }
    return new Date(b.received_at) - new Date(a.received_at);
  });
}

/** Counts live on the mode buttons, so the filter and the number are one control. */
function renderModes() {
  for (const btn of $('#modeGroup').querySelectorAll('button')) {
    const mode = btn.dataset.mode;
    const n = state.carts.filter(MODES[mode].match).length;
    btn.textContent = `${MODES[mode].label} ${n}`;
    btn.classList.toggle('active', mode === state.mode);
  }
}

/** The money line, and the one alarm worth interrupting a caller for. */
function renderSummary() {
  const inRange = state.total ?? state.carts.length;
  const value = state.carts.reduce((sum, c) => sum + (c.total_price ?? 0), 0);
  const el = $('#rangeSummary');
  if (el) el.textContent = `${inRange} cart${inRange === 1 ? '' : 's'} · ${money(value, 'INR')} in play`;

  // Stale is a whole-table figure from the server, deliberately not filtered:
  // it is an alarm, and an alarm you can filter away is not an alarm.
  const stale = Number(state.stale?.count ?? 0);
  const banner = $('#staleBanner');
  if (!banner) return;
  banner.hidden = stale === 0;
  banner.className = 'banner error';
  banner.textContent = stale
    ? `${stale} cart${stale === 1 ? '' : 's'} still not called after ${SLA_HOURS}h`
      + `${state.stale?.value ? ` (${money(state.stale.value, 'INR')})` : ''}. They are at the top of "To call".`
    : '';
}

/** "Last updated by Priya, 2h ago" — attribution without asking anyone to pick it. */
function savedLabel(cart) {
  if (!cart.status_updated_at) return '';
  const when = relativeTime(cart.status_updated_at);
  return cart.updated_by
    ? `Last updated by ${esc(cart.updated_by)}, ${when}`
    : `Saved ${when}`;
}

/** Shape-of-the-content placeholder — less jarring than the word "Loading". */
function skeletonCards(n = 4) {
  return Array.from({ length: n }, () => `<div class="callcard skeleton">
    <span class="sk w40"></span><span class="sk w80"></span><span class="sk w60"></span>
  </div>`).join('');
}

/**
 * One card per cart, in call order.
 *
 * Three zones, always in the same place: who and why, then the act of calling,
 * then recording what happened. The old table put the outcome form in an eighth
 * column, which meant a caller read a dropdown per row to see where a cart
 * stood instead of scanning down the list.
 */
function renderQueue() {
  const list = visibleCarts();

  if (!list.length) {
    const mode = MODES[state.mode].label.toLowerCase();
    queueEl.innerHTML = `<div class="empty-state">
      <h3>${state.query ? 'Nothing matches that search'
        : state.mode === 'tocall' ? 'Nothing left to call'
        : `Nothing in ${mode}`}</h3>
      <p>${state.query ? 'Try a phone number, or part of a name or email.'
        : state.mode === 'tocall' ? 'Every cart in this range has been worked. Check Callbacks next.'
        : 'Switch queue above, or widen the date range.'}</p>
    </div>`;
    return;
  }

  queueEl.innerHTML = list.map((c) => {
    const status = c.status || 'Not called';
    const cb = callbackState(c);
    const wa = waNumber(c.phone);

    // Call is the job, so it is the only filled button.
    const links = [];
    if (c.phone) links.push(`<a class="call" href="tel:${esc(String(c.phone).replace(/\s/g, ''))}">Call</a>`);
    if (wa) links.push(`<a href="https://wa.me/${wa}?text=${encodeURIComponent(waMessage(c))}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (c.checkout_url) links.push(`<a href="${esc(c.checkout_url)}" target="_blank" rel="noopener">Cart</a>`);
    if (!c.phone) links.push('<span class="muted">No phone number</span>');

    // Why this cart, in chips: the three things callers said they use.
    const chips = [
      c.risk_flag ? `<span class="tag ${riskClass(c.risk_flag)}" title="${esc(c.risk_flag)} of return-to-origin">${esc(shortRisk(c.risk_flag))} risk</span>` : '',
      c.drop_stage ? `<span class="tag tag-stage" title="Left at the ${esc(c.drop_stage)}">${esc(c.drop_stage)}</span>` : '',
      gokwikTouch(c),
    ].filter(Boolean).join('');

    return `
      <article class="callcard" data-row="${esc(c.id)}" data-status="${esc(status)}" data-mine="${c.assigned_to === ME}">
        <div class="cc-who">
          <div class="cc-top">
            <span class="cc-value">${money(c.total_price, c.currency)}</span>
            <span class="cc-name" title="${esc(c.customer_name || 'Guest')}">${esc(c.customer_name || 'Guest')}</span>
            ${cb ? `<span class="cb cb-${cb.kind}">${cb.kind === 'scheduled' ? 'Callback ' : ''}${esc(cb.label)}</span>` : ''}
          </div>
          <div class="cc-meta">
            ${relativeTime(c.received_at)}
            ${c.phone ? ` · ${esc(c.phone)}` : ''}
            ${c.discount_total ? ` · ${money(c.discount_total, c.currency)} off` : ''}
          </div>
          <div class="cc-chips">${chips}</div>
          <div class="cc-items">${itemsCell(c)}</div>
        </div>

        <div class="cc-act"><div class="links">${links.join('')}</div></div>

        <div class="cc-record">
          <div class="cc-outcome">
            <select data-id="${esc(c.id)}" class="js-status" autocomplete="off" aria-label="Outcome">
              ${STATUSES.map((st) => `<option ${st === status ? 'selected' : ''}>${st}</option>`).join('')}
            </select>
            <input type="datetime-local" class="js-callback" data-id="${esc(c.id)}" autocomplete="off"
                   aria-label="Callback time" value="${toLocalInput(c.callback_at)}"
                   ${status === 'Callback scheduled' ? '' : 'hidden'} />
          </div>
          <input type="text" class="js-notes" data-id="${esc(c.id)}" autocomplete="off"
                 placeholder="Notes…" aria-label="Notes" value="${esc(c.notes || '')}" />
          <details class="tagpick" data-id="${esc(c.id)}">
            <summary>${(c.reason_tags || []).length ? 'Edit reasons' : '+ reason'}</summary>
            <div class="tagmenu">
              ${REASON_TAGS.map((t) => `
                <label><input type="checkbox" class="js-tag" data-id="${esc(c.id)}" value="${esc(t)}"
                  ${(c.reason_tags || []).includes(t) ? 'checked' : ''} /> ${esc(t)}</label>`).join('')}
            </div>
          </details>
          <div class="chips">${(c.reason_tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
          <div class="cc-foot">
            <select class="js-assign" data-id="${esc(c.id)}" autocomplete="off" aria-label="Owner">
              <option value="">Unassigned</option>
              ${TEAM.map((t) => `<option value="${esc(t.phone)}" ${t.phone === c.assigned_to ? 'selected' : ''}>${esc(t.name)}${t.phone === ME ? ' (me)' : ''}</option>`).join('')}
            </select>
            ${!c.assigned_to && ME ? `<button type="button" class="linky js-takeit" data-id="${esc(c.id)}">Take it</button>` : ''}
            <span class="saved">${savedLabel(c)}</span>
          </div>
        </div>
      </article>`;
  }).join('');

  // Browsers restore form-control values across reloads, which would both show
  // the wrong status and fire a change event that saves it. Re-assert every
  // control from server state after inserting the markup.
  for (const sel of queueEl.querySelectorAll('.js-status')) {
    const cart = cartById(sel.dataset.id);
    if (cart) sel.value = cart.status || 'Not called';
  }
  for (const sel of queueEl.querySelectorAll('.js-assign')) {
    const cart = cartById(sel.dataset.id);
    if (cart) sel.value = cart.assigned_to || '';
  }
  for (const input of queueEl.querySelectorAll('.js-notes')) {
    const cart = cartById(input.dataset.id);
    if (cart) input.value = cart.notes || '';
  }
}

let insightsTimer = null;
/** Two network requests per save adds up across three callers on a free
 *  instance; the panels are secondary so a trailing debounce is fine. */
function scheduleInsights() {
  clearTimeout(insightsTimer);
  insightsTimer = setTimeout(renderInsights, 3000);
}

/** A caller gets 403 from by-caller by design; asking again every time just
 *  fills their console with errors for a panel they will never see. */
let byCallerForbidden = false;

async function renderInsights() {
  const days = state.days;
  try {
    // Fetched and rendered independently: by-caller is admin-only, so for a
    // caller it comes back 403 — and when the two shared a failure check, that
    // 403 silently blanked the reasons panel they are allowed to see.
    const [rRes, cRes] = await Promise.all([
      fetch(`/api/reasons/summary?days=${days}`),
      byCallerForbidden ? Promise.resolve(null) : fetch(`/api/stats/by-caller?days=${days}`),
    ]);

    if (cRes?.status === 403) byCallerForbidden = true;

    if (cRes?.ok) {
      const callers = await cRes.json();
      $('#callerRows').innerHTML = callers.callers.length
        ? callers.callers.map((c) => `
            <tr>
              <td>${esc(c.caller)}</td>
              <td class="right">${c.touched}</td>
              <td class="right">${c.recovered}</td>
              <td class="right">${c.recovery_rate}%</td>
              <td class="right">${money(c.recovered_value, 'INR')}</td>
            </tr>`).join('')
        : '<tr><td colspan="5" class="empty">Nobody has worked a cart in this range yet.</td></tr>';
    } else if (byCallerForbidden) {
      // Not an error to show anyone: this panel simply isn't theirs.
      $('#callerPanel')?.setAttribute('hidden', '');
    }

    if (!rRes.ok) return;
    const reasons = await rRes.json();

    const max = Math.max(1, ...reasons.reasons.map((r) => r.count));
    $('#reasonList').innerHTML = reasons.reasons.length
      ? reasons.reasons.map((r) => `
          <div class="bar-row">
            <span class="bar-label">${esc(r.tag)}</span>
            <span class="bar"><span class="bar-fill" style="width:${(r.count / max) * 100}%"></span></span>
            <span class="bar-count">${r.count}</span>
          </div>`).join('')
      : '<p class="muted">No reasons tagged yet. Add them from the table as you call.</p>';
    $('#reasonMeta').textContent = reasons.taggedCarts
      ? `${reasons.taggedCarts} cart${reasons.taggedCarts === 1 ? '' : 's'} tagged`
      : '';

  } catch {
    // Insights are secondary; never let them break the call list.
  }
}

/** Says what is on screen versus what exists — the old code silently dropped
 *  everything past the 500th row with no indication. */
const RANGE_LABEL = { 1: 'today', 3: 'the last 3 days', 7: 'the last 7 days', 0: 'all time' };

/**
 * Always says what is on screen. Previously it only appeared when results were
 * truncated, so switching between ranges that happen to hold the same carts
 * looked like the button had done nothing.
 */
function renderResultNote() {
  const el = $('#resultNote');
  if (!el) return;
  el.hidden = false;

  if (state.query) {
    el.textContent = `${state.carts.length} result${state.carts.length === 1 ? '' : 's'} for "${state.query}" — searching all history.`
      + (state.truncated ? ' Showing the first 50; narrow the search.' : '');
    return;
  }

  const shown = visibleCarts().length;
  const inRange = state.total ?? state.carts.length;
  const label = RANGE_LABEL[state.days] ?? `the last ${state.days} days`;

  if (state.truncated) {
    el.textContent = `Showing ${state.carts.length} of ${inRange} carts from ${label} — narrow the date range to see the rest.`;
    return;
  }
  el.textContent = `${shown} in ${MODES[state.mode].label.toLowerCase()}, of ${inRange} cart${inRange === 1 ? '' : 's'} from ${label}.`;
}

function syncExportLink() {
  const a = $('#exportCsv');
  if (!a) return;
  a.href = state.query
    ? `/api/carts.csv?q=${encodeURIComponent(state.query)}`
    : `/api/carts.csv?days=${state.days}`;
}

function render() {
  renderModes();
  renderSummary();
  renderResultNote();
  renderQueue();
  // Insights are NOT refreshed here. They depend only on the date range, and
  // render() runs on every queue switch and sort change — refetching both
  // panels each time was two requests per click for data that had not changed.
}

// ---------- events ----------

// Delegated so re-renders never orphan a listener.
queueEl.addEventListener('change', (e) => {
  const id = e.target.dataset?.id;

  if (e.target.classList.contains('js-status')) {
    // Ignore no-op changes (e.g. browser form restoration re-firing on load).
    if ((cartById(id)?.status || 'Not called') === e.target.value) return;
    const status = e.target.value;

    // Reveal the picker immediately so the caller can set a time without waiting
    // for the save round-trip.
    const cbInput = document.querySelector(`.js-callback[data-id="${CSS.escape(id)}"]`);
    if (cbInput) {
      cbInput.hidden = status !== 'Callback scheduled';
      if (status !== 'Callback scheduled') cbInput.value = '';
    }

    const notes = document.querySelector(`.js-notes[data-id="${CSS.escape(id)}"]`)?.value ?? '';
    const payload = { status, notes };
    if (status === 'Callback scheduled') {
      payload.callbackAt = cbInput?.value ? new Date(cbInput.value).toISOString() : null;
    } else {
      payload.callbackAt = null;
    }
    saveRow(id, payload);
    return;
  }

  if (e.target.classList.contains('js-callback')) {
    saveRow(id, {
      status: 'Callback scheduled',
      callbackAt: e.target.value ? new Date(e.target.value).toISOString() : null,
    });
    return;
  }

  if (e.target.classList.contains('js-assign')) {
    if ((cartById(id)?.assigned_to || '') === e.target.value) return;
    saveRow(id, { assignedTo: e.target.value || null });
    return;
  }

  if (e.target.classList.contains('js-tag')) {
    const boxes = [...document.querySelectorAll(`.js-tag[data-id="${CSS.escape(id)}"]`)];
    const reasonTags = boxes.filter((b) => b.checked).map((b) => b.value);
    saveRow(id, { reasonTags });
  }
});

// Notes save on blur and on Enter — not per keystroke, which would hammer the metafield.
queueEl.addEventListener('blur', (e) => {
  if (e.target.classList.contains('js-notes')) {
    const id = e.target.dataset.id;
    if ((cartById(id)?.notes || '') === e.target.value) return;
    const status = document.querySelector(`.js-status[data-id="${CSS.escape(id)}"]`)?.value;
    saveRow(id, { status, notes: e.target.value }, e.target);
  }
}, true);

queueEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('js-notes')) e.target.blur();
});

// One-tap self-assign — the common case, and the whole point of this feature is
// stopping two people ringing the same customer.
queueEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.js-takeit');
  if (btn) saveRow(btn.dataset.id, { assignedTo: ME });
});

on('#rangeGroup', 'click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.days = Number(btn.dataset.days);
  $('#rangeGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  loadAll();   // the range is a server-side query, not a local filter
});

/**
 * Poll so a teammate's change shows up without a manual refresh. Skipped while
 * a field is focused — reloading under someone's cursor would discard what they
 * are typing, which is exactly what the conflict guard exists to prevent.
 *
 * This used to sit inside the range handler, so it never started until someone
 * clicked a range button — and then started another timer on every click.
 */
const REFRESH_MS = 60_000;
setInterval(() => {
  if (document.hidden) return;
  const active = document.activeElement;
  if (active && active.closest?.('#queue')) return;
  if (state.query) return;   // don't yank a search result set away
  loadAll();
}, REFRESH_MS);

let searchTimer = null;
on('#search', 'input', (e) => {
  const value = e.target.value.trim();
  clearTimeout(searchTimer);
  // Search hits the whole history, so don't fire on every keystroke.
  searchTimer = setTimeout(() => {
    if (value === state.query) return;
    state.query = value;
    loadAll();
  }, 350);
});
on('#search', 'keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; state.query = ''; loadAll(); }
});

on('#modeGroup', 'click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  // Each queue has an obvious order — callbacks by due time, everything else by
  // size — so switching queue picks it, until someone chooses one by hand.
  if (!state.sortTouched) {
    state.sort = MODES[state.mode].sort;
    if ($('#sort')) $('#sort').value = state.sort;
  }
  render();
});

on('#sort', 'change', (e) => {
  state.sort = e.target.value;
  state.sortTouched = true;
  render();
});
on('#refresh', 'click', loadAll);

on('#logout', 'click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// Show who is signed in; bounce to login if the session expired mid-session.
/** "Good morning, Axit" reads better than a phone number, and confirms at a
 *  glance which account you are signed in as. */
function greeting(name) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

fetch('/auth/me').then((r) => r.json()).then((me) => {
  if (!me.authenticated) { window.location.href = '/login'; return; }
  $('#sessionPhone').textContent = greeting(me.name);
  $('#sessionPhone').title = `+${me.phone}`;
  // Admin-only pages: don't advertise links that 403.
  if (me.isAdmin) {
    $('#adminLink').hidden = false;
    if ($('#dashLink')) $('#dashLink').hidden = false;
    if ($('#importLink')) $('#importLink').hidden = false;
  }
}).catch(() => {});

loadAll();
