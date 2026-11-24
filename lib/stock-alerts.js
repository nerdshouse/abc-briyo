/**
 * Stock alerts: what to reorder, and which batches are getting too old for the platforms that check shelf life.
 *
 * PO alerts (ABC): every tracked master SKU gets a class from its last `sales_days` of dispatched units (all channels):
 *   A = the best sellers making up the first `a_share` % of units, B = up to `b_share` %, C = the rest (and no sales).
 *   A class can be set by hand (skus.abc_class). Each class has days of cover; with the supplier lead time:
 *     reorder point = daily sales × (lead days + cover days)       — alert when available + incoming is below it
 *     order up to   = daily sales × (lead days + 2 × cover days)   — the suggested PO brings stock back to this
 *   A SKU's own reorder level (and reorder quantity), when set, is used instead: a fixed minimum the team chose.
 *
 * Shelf-life alerts: shelf life left = days to expiry ÷ days from manufacture to expiry. A platform's minimum
 * (platform_shelf_life, e.g. Blinkit 70%) is crossed on a date; a batch still holding stock is listed when it has
 * crossed, or will within `shelf_warn_days`. The same rule keeps those batches off that platform's shipments
 * (lib/inventory.js shipmentShelfRule).
 *
 * Alerts show in Inventory → Alerts and on the Overview, and once a day (after `send_hour`, IST) go by WhatsApp to the
 * numbers in the settings through the approved 11za template ELEVENZA_STOCK_TEMPLATE_NAME. Nothing here moves stock.
 */
import { getPool } from './db.js';
import { inTransaction, teamTimezone } from './orders.js';
import { ensureInventorySchema, listSkus, audit, idOf } from './inventory.js';
import { incomingBySku } from './inventory-inbound.js';
import { normalisePhone } from './otp.js';
import { sendStockAlert } from './whatsapp.js';
import { maskPhone } from './log-redact.js';

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export const DEFAULT_SETTINGS = {
  a_share: 70, b_share: 90, cover_a: 45, cover_b: 30, cover_c: 15, lead_days: 7, sales_days: 90, shelf_warn_days: 30,
  whatsapp_to: [], send_hour: 10,
};
// The names on the Alerts page, for error messages.
const LABELS = {
  a_share: 'Class A share', b_share: 'Class B share', cover_a: 'Cover for class A', cover_b: 'Cover for class B', cover_c: 'Cover for class C',
  lead_days: 'Supplier lead time', sales_days: 'Sales period', shelf_warn_days: 'Warn before a shelf-life limit', send_hour: 'Send hour',
};
const LIMITS = {
  a_share: [1, 99], b_share: [2, 100], cover_a: [1, 365], cover_b: [1, 365], cover_c: [1, 365], lead_days: [0, 180],
  sales_days: [7, 365], shelf_warn_days: [1, 180], send_hour: [0, 23],
};

let schema = null;
async function ensureSchema() {
  await ensureInventorySchema();
  if (!schema) {
    schema = getPool().query(`
      CREATE TABLE IF NOT EXISTS stock_alert_settings (
        id               BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
        settings         JSONB NOT NULL DEFAULT '{}',
        version          INTEGER NOT NULL DEFAULT 1,
        updated_by       TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO stock_alert_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
      -- One row per IST day the WhatsApp digest went out: a restart, or a second app instance, never sends it twice.
      CREATE TABLE IF NOT EXISTS stock_alert_sends (
        day        DATE PRIMARY KEY,
        sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        recipients INTEGER NOT NULL DEFAULT 0,
        delivered  INTEGER NOT NULL DEFAULT 0,
        message    TEXT,
        errors     JSONB NOT NULL DEFAULT '[]'
      );`).catch((err) => { schema = null; throw err; });
  }
  return schema;
}

// ------------------------------------------------------------------ settings

export async function getAlertSettings(db = getPool()) {
  await ensureSchema();
  const { rows: [r] } = await db.query('SELECT settings, version, updated_by, updated_at FROM stock_alert_settings');
  const { rows: rules } = await db.query(
    `SELECT c.key AS channel, c.label, p.min_pct FROM sales_channels c LEFT JOIN platform_shelf_life p ON p.channel = c.key
      WHERE c.active ORDER BY c.sort, c.key`);
  return {
    ...DEFAULT_SETTINGS, ...(r?.settings || {}), version: r?.version || 1, updated_by: r?.updated_by || null, updated_at: r?.updated_at || null,
    platforms: rules.map((x) => ({ channel: x.channel, label: x.label, min_pct: x.min_pct ?? null })),
  };
}

/**
 * Saves the settings (whole numbers within LIMITS, phones as 91XXXXXXXXXX) and the platform minimums (blank = none),
 * against the version the page read. Audited.
 */
export async function saveAlertSettings(input = {}, { actor, version } = {}) {
  await ensureSchema();
  const next = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).trim();
    if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) throw bad(`${LABELS[k]} must be a whole number from ${lo} to ${hi}.`);
    next[k] = Number(v);
  }
  if (input.whatsapp_to !== undefined) {
    const list = (Array.isArray(input.whatsapp_to) ? input.whatsapp_to : String(input.whatsapp_to).split(/[\n,]+/))
      .map((x) => String(x).trim()).filter(Boolean);
    const phones = [];
    for (const raw of list) {
      const p = normalisePhone(raw);
      if (!p) throw bad(`${raw} is not an Indian mobile number.`);
      if (!phones.includes(p)) phones.push(p);
    }
    if (phones.length > 10) throw bad('Up to 10 WhatsApp numbers.');
    next.whatsapp_to = phones;
  }
  const platforms = Array.isArray(input.platforms) ? input.platforms : null;
  return inTransaction(async (client) => {
    const { rows: [cur] } = await client.query('SELECT settings, version FROM stock_alert_settings FOR UPDATE');
    if (version !== undefined && Number(version) !== cur.version) throw bad('Someone changed the alert settings while you had them open. Reload to see their change.', 409, { conflict: true });
    const merged = { ...DEFAULT_SETTINGS, ...cur.settings, ...next };
    if (merged.b_share <= merged.a_share) throw bad('The B cut-off must be above the A cut-off.');
    await client.query('UPDATE stock_alert_settings SET settings = $1, version = version + 1, updated_by = $2, updated_at = now()', [JSON.stringify(merged), actor]);
    if (platforms) {
      for (const p of platforms) {
        const key = String(p?.channel || '');
        const raw = String(p?.min_pct ?? '').trim();
        if (!(await client.query('SELECT 1 FROM sales_channels WHERE key = $1', [key])).rows.length) throw bad(`Unknown platform ${key}.`);
        if (raw === '' || raw === '0') { await client.query('DELETE FROM platform_shelf_life WHERE channel = $1', [key]); continue; }
        if (!/^\d+$/.test(raw) || Number(raw) > 100) throw bad('A platform minimum is a whole % from 1 to 100, or blank for none.');
        await client.query(
          `INSERT INTO platform_shelf_life (channel, min_pct, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (channel) DO UPDATE SET min_pct = EXCLUDED.min_pct, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, Number(raw), actor]);
      }
    }
    await audit(client, 'stock_alert_settings_saved', { actor, metadata: { settings: { ...merged, whatsapp_to: merged.whatsapp_to.map(maskPhone) }, platforms } });
    return getAlertSettings(client);
  });
}

/** A class chosen by hand for one SKU ('A', 'B', 'C'), or '' to go back to the one from sales. Audited. */
export async function setSkuClass(skuId, cls, { actor } = {}) {
  await ensureSchema();
  const id = idOf(skuId);
  const v = String(cls ?? '').trim().toUpperCase();
  if (!id) throw bad('No such SKU.', 404);
  if (v && !['A', 'B', 'C'].includes(v)) throw bad('The class is A, B or C (blank: worked out from sales).');
  return inTransaction(async (client) => {
    const { rows: [s] } = await client.query('UPDATE skus SET abc_class = $2 WHERE id = $1 RETURNING sku, abc_class', [id, v || null]);
    if (!s) throw bad('No such SKU.', 404);
    await audit(client, 'sku_class_set', { actor, skuId: id, metadata: { abc_class: s.abc_class } });
    return { sku_id: id, abc_class: s.abc_class };
  });
}

// ------------------------------------------------------------------ the alerts

const DAY = 86400000;
const istToday = (tz = teamTimezone()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/** A/B/C from units sold, best seller first: A until the running share passes a_share %, B until b_share %, C after. */
export function classify(sold, { a_share: a, b_share: b }) {
  const total = sold.reduce((n, x) => n + x.units, 0);
  const out = new Map();
  let running = 0;
  for (const x of [...sold].sort((p, q) => q.units - p.units)) {
    if (!x.units || !total) { out.set(x.sku_id, 'C'); continue; }
    // The share before this SKU decides: the SKU that crosses the line still belongs to the class it starts in.
    const before = (running / total) * 100;
    out.set(x.sku_id, before < a ? 'A' : before < b ? 'B' : 'C');
    running += x.units;
  }
  return out;
}

/** The reorder maths for one SKU (see the header). Pure. */
export function reorderOf({ cls, daily, available, incoming, reorder_level: level = 0, reorder_quantity: qty = 0 }, s) {
  const cover = { A: s.cover_a, B: s.cover_b, C: s.cover_c }[cls];
  const stock = available + incoming;
  const fixed = level > 0;
  const point = fixed ? level : Math.ceil(daily * (s.lead_days + cover));
  const upTo = fixed ? level + Math.max(qty, 0) : Math.ceil(daily * (s.lead_days + 2 * cover));
  const needed = point > 0 && stock < point;
  const suggest = needed ? Math.max(Math.max(qty, 0), upTo - stock) : 0;
  return {
    cover_days: cover, reorder_point: point, order_up_to: upTo, fixed_level: fixed, needs_po: needed, suggested_qty: suggest,
    days_left: daily > 0 ? Math.floor(available / daily) : null,
  };
}

/** When a batch's shelf life left drops under `pct`: expiry − pct % of its total life. Pure. */
export function crossingDay(mfg, expiry, pct) {
  const life = dayNum(expiry) - dayNum(mfg);
  return isoOf(dayNum(expiry) - Math.ceil((life * pct) / 100));
}

/**
 * Everything on the Alerts page: classes and PO needs per tracked SKU, and shelf-life warnings per batch.
 * `summary` is what the Overview and the WhatsApp digest show.
 */
export async function stockAlerts({ tz = teamTimezone() } = {}) {
  const settings = await getAlertSettings();
  const db = getPool();
  const [skus, incoming, { rows: soldRows }, { rows: classRows }, { rows: batchRows }] = await Promise.all([
    listSkus({ includeInactive: false, tz }),
    incomingBySku(),
    db.query(`SELECT sku_id, -sum(quantity)::int AS units FROM inventory_movements
               WHERE movement_type = 'shipment_dispatched' AND at >= now() - make_interval(days => $1) GROUP BY sku_id`, [settings.sales_days]),
    db.query('SELECT id, abc_class FROM skus WHERE abc_class IS NOT NULL'),
    db.query(`SELECT b.id, b.sku_id, s.sku, s.product_name, b.batch_number, w.name AS warehouse, b.mfg_date::text AS mfg_date,
                     b.expiry_date::text AS expiry_date, b.on_hand
                FROM inventory_batches b JOIN skus s ON s.id = b.sku_id JOIN warehouses w ON w.id = b.warehouse_id
               WHERE s.active AND b.status = 'active' AND b.on_hand > 0
                 AND (b.expiry_date IS NULL OR b.expiry_date >= (now() AT TIME ZONE $1)::date)
               ORDER BY b.expiry_date NULLS LAST, b.id`, [tz]),
  ]);
  const tracked = skus.filter((s) => s.track_inventory !== false && !s.is_bundle);
  const soldBy = new Map(soldRows.map((r) => [Number(r.sku_id), Math.max(r.units, 0)]));
  const auto = classify(tracked.map((s) => ({ sku_id: s.id, units: soldBy.get(s.id) || 0 })), settings);
  const manual = new Map(classRows.map((r) => [Number(r.id), r.abc_class]));
  const products = tracked.map((s) => {
    const units = soldBy.get(s.id) || 0;
    const daily = units / settings.sales_days;
    const cls = manual.get(s.id) || auto.get(s.id) || 'C';
    const inc = incoming.get(s.id) || 0;
    return {
      sku_id: s.id, sku: s.sku, product_name: s.product_name, variant_name: s.variant_name,
      class: cls, auto_class: auto.get(s.id) || 'C', class_set_by_hand: manual.has(s.id),
      sold: units, daily: Math.round(daily * 100) / 100, available: s.available, incoming: inc,
      reorder_level: s.reorder_level, reorder_quantity: s.reorder_quantity,
      ...reorderOf({ cls, daily, available: s.available, incoming: inc, reorder_level: s.reorder_level, reorder_quantity: s.reorder_quantity }, settings),
    };
  }).sort((a, b) => 'ABC'.indexOf(a.class) - 'ABC'.indexOf(b.class) || b.sold - a.sold || a.sku.localeCompare(b.sku));
  const po = products.filter((p) => p.needs_po).sort((a, b) => (a.days_left ?? 1e9) - (b.days_left ?? 1e9) || 'ABC'.indexOf(a.class) - 'ABC'.indexOf(b.class));

  const today = istToday(tz);
  const rules = settings.platforms.filter((p) => p.min_pct);
  const shelf = [];
  let unmeasured = 0;
  for (const b of batchRows) {
    if (!b.mfg_date || !b.expiry_date || b.expiry_date <= b.mfg_date) { if (rules.length) unmeasured += 1; continue; }
    const pct = Math.floor((100 * (dayNum(b.expiry_date) - dayNum(today))) / (dayNum(b.expiry_date) - dayNum(b.mfg_date)));
    const below = []; const soon = [];
    for (const r of rules) {
      const on = crossingDay(b.mfg_date, b.expiry_date, r.min_pct);
      if (pct < r.min_pct) below.push({ channel: r.channel, label: r.label, min_pct: r.min_pct, since: on });
      else if (dayNum(on) - dayNum(today) <= settings.shelf_warn_days) soon.push({ channel: r.channel, label: r.label, min_pct: r.min_pct, on });
    }
    if (below.length || soon.length) {
      shelf.push({ batch_id: Number(b.id), sku_id: Number(b.sku_id), sku: b.sku, product_name: b.product_name, batch_number: b.batch_number,
        warehouse: b.warehouse, on_hand: b.on_hand, mfg_date: b.mfg_date, expiry_date: b.expiry_date, shelf_pct: pct, below, soon });
    }
  }
  shelf.sort((a, b) => (b.below.length > 0) - (a.below.length > 0) || a.shelf_pct - b.shelf_pct);
  return {
    today, settings, products, po, shelf, unmeasured_batches: unmeasured,
    summary: { po: po.length, below: shelf.filter((x) => x.below.length).length, soon: shelf.filter((x) => !x.below.length && x.soon.length).length },
  };
}

/** Counts for the Overview (lib/overview.js). */
export async function stockAlertSummary() {
  const a = await stockAlerts();
  return { ...a.summary, po_class_a: a.po.filter((p) => p.class === 'A').length };
}

// ------------------------------------------------------------------ the WhatsApp digest

const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const short = (s, n = 26) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const num = (n) => Number(n).toLocaleString('en-IN');

/**
 * The digest text: ONE line (a WhatsApp template variable cannot hold a line break), at most `max` characters, the
 * most urgent first and "+N more" for the rest. Empty when there is nothing to say. Pure.
 */
export function digestText({ po, shelf }, { max = 900 } = {}) {
  const parts = [];
  const list = (head, items) => {
    if (!items.length) return;
    const room = max - parts.join(' · ').length - head.length - 20;
    const shown = [];
    for (const t of items) { if ([...shown, t].join('; ').length > room) break; shown.push(t); }
    parts.push(`${head}: ${shown.join('; ')}${items.length > shown.length ? `; +${items.length - shown.length} more` : ''}`);
  };
  list(`${po.length} ${po.length === 1 ? 'product needs' : 'products need'} a PO`, po.map((p) =>
    `${short(p.product_name)} (${p.sku}, class ${p.class}) ${p.days_left === null ? `${num(p.available)} left` : `${p.days_left} days left`}, order ${num(p.suggested_qty)}`));
  const below = shelf.filter((x) => x.below.length);
  list(`${below.length} batch${below.length === 1 ? '' : 'es'} too old for a platform`, below.map((x) =>
    `${short(x.product_name)} ${x.batch_number} (${num(x.on_hand)} units, ${x.shelf_pct}% life left; not for ${x.below.map((r) => `${r.label} ${r.min_pct}%`).join(', ')})`));
  const soon = shelf.filter((x) => !x.below.length && x.soon.length);
  list(`${soon.length} batch${soon.length === 1 ? '' : 'es'} near a platform limit`, soon.map((x) => {
    const first = [...x.soon].sort((a, b) => a.on.localeCompare(b.on))[0];
    return `${short(x.product_name)} ${x.batch_number} (${num(x.on_hand)} units) under ${first.min_pct}% on ${fmtDay(first.on)} (${x.soon.map((r) => r.label).join(', ')})`;
  }));
  return parts.join(' · ').replace(/\s+/g, ' ').slice(0, max);
}

/**
 * Sends the digest to every number in the settings. `day` (YYYY-MM-DD) latches the daily send: the row is claimed
 * first, so two instances or a restart cannot both send; without it (Send now) it always sends. Returns what happened.
 */
export async function sendStockDigest({ day = null, actor = 'stock-alerts' } = {}) {
  const a = await stockAlerts();
  const text = digestText(a);
  const to = a.settings.whatsapp_to || [];
  if (!text) return { sent: false, reason: 'Nothing to alert.' };
  if (!to.length) return { sent: false, reason: 'No WhatsApp numbers are set in the alert settings.' };
  if (day) {
    const { rows } = await getPool().query('INSERT INTO stock_alert_sends (day, recipients, message) VALUES ($1, $2, $3) ON CONFLICT (day) DO NOTHING RETURNING day', [day, to.length, text]);
    if (!rows.length) return { sent: false, reason: 'Already sent today.' };
  }
  let delivered = 0;
  const errors = [];
  for (const phone of to) {
    try {
      const r = await sendStockAlert(phone, text);
      if (r.delivered === false) errors.push({ to: maskPhone(phone), error: r.reason }); else delivered += 1;
    } catch (err) { errors.push({ to: maskPhone(phone), error: String(err.message).slice(0, 200) }); }
  }
  if (day) await getPool().query('UPDATE stock_alert_sends SET delivered = $2, errors = $3 WHERE day = $1', [day, delivered, JSON.stringify(errors)]);
  await inTransaction((c) => audit(c, 'stock_alert_sent', { actor, metadata: { day, recipients: to.length, delivered, errors } }));
  console.log(`Stock alerts: digest to ${to.length} number(s), ${delivered} delivered${errors.length ? `, ${errors.length} failed: ${errors.map((e) => e.error).join('; ').slice(0, 200)}` : ''}`);
  return { sent: delivered > 0, delivered, recipients: to.length, errors, text };
}

/** The last daily sends, newest first (the Alerts page shows them). */
export async function recentSends(limit = 7) {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT day::text AS day, sent_at, recipients, delivered, errors FROM stock_alert_sends ORDER BY day DESC LIMIT $1', [limit]);
  return rows;
}

/**
 * The daily timer: every 10 minutes, once the IST hour reaches send_hour, today's digest goes out (once). Off with
 * STOCK_ALERTS_ENABLED=false; without the 11za template set it does not send (and says so once).
 */
export function startStockAlerts() {
  if (process.env.STOCK_ALERTS_ENABLED === 'false') { console.log('Stock alerts: WhatsApp digest off (STOCK_ALERTS_ENABLED=false)'); return null; }
  let warned = false;
  const tick = async () => {
    try {
      if (!String(process.env.ELEVENZA_STOCK_TEMPLATE_NAME || '').trim()) {
        if (!warned) console.log('Stock alerts: WhatsApp digest waiting for ELEVENZA_STOCK_TEMPLATE_NAME (the approved 11za template).');
        warned = true;
        return;
      }
      const tz = teamTimezone();
      const s = await getAlertSettings();
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
      if (hour < s.send_hour) return;
      const day = istToday(tz);
      if ((await getPool().query('SELECT 1 FROM stock_alert_sends WHERE day = $1', [day])).rows.length) return;
      await sendStockDigest({ day });
    } catch (err) { console.error('Stock alerts failed:', String(err.message).slice(0, 200)); }
  };
  const timer = setInterval(tick, 10 * 60000);
  timer.unref?.();
  setTimeout(tick, 60000).unref?.();
  console.log('Stock alerts: WhatsApp digest daily (Inventory → Alerts sets the time and numbers)');
  return timer;
}
