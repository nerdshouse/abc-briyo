import { parseCsvObjects } from './csv.js';

/**
 * Maps Shopify's abandoned-checkout CSV export onto the board's columns.
 *
 * Two things about the format drive this:
 *
 *  1. It is one row per LINE ITEM, not per checkout. A checkout's first row
 *     carries the checkout-level fields; its continuation rows repeat only
 *     `Name` and `Email` and leave `Id`, `Total`, `Currency` blank. Grouping by
 *     `Name` (the #40792765071611 token) is what reassembles a cart.
 *  2. Shopify has no equivalent of GoKwik's drop stage, RTO risk flag, or a
 *     recovery URL — those stay null rather than being invented.
 */

const REQUIRED_HEADERS = ['Name', 'Created at', 'Email', 'Lineitem name'];

const first = (...vals) => vals.map((v) => String(v ?? '').trim()).find(Boolean) || null;

function toNumber(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number.parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "2026-09-17 01:39:02 +0530" — has an explicit offset, so no guessing. */
function toDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = s.replace(' ', 'T').replace(/\s*([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function address(r) {
  const parts = [
    first(r['Shipping Address1'], r['Billing Address1']),
    first(r['Shipping Address2'], r['Billing Address2']),
    first(r['Shipping City'], r['Billing City']),
    first(r['Shipping Province Name'], r['Shipping Province'], r['Billing Province Name'], r['Billing Province']),
    first(r['Shipping Zip'], r['Billing Zip']),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function mapShopifyCsv(text) {
  const { headers, records } = parseCsvObjects(text);

  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new Error(
      `This does not look like a Shopify checkout export — missing column(s): ${missing.join(', ')}.`);
  }

  // Group by checkout, preserving order.
  const groups = new Map();
  for (const r of records) {
    const key = String(r.Name ?? '').trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const carts = [];
  const skipped = [];

  for (const [name, rows] of groups) {
    // The row carrying checkout-level data is the one with an Id or a Total;
    // continuation rows have neither.
    const head = rows.find((r) => String(r.Id ?? '').trim() || String(r.Total ?? '').trim()) || rows[0];

    const items = rows
      .filter((r) => String(r['Lineitem name'] ?? '').trim())
      .map((r) => ({
        title: String(r['Lineitem name']).trim(),
        quantity: Number.parseInt(r['Lineitem quantity'], 10) || 1,
        price: toNumber(r['Lineitem price']),
        sku: first(r['Lineitem sku']),
      }));

    const shopifyId = first(head.Id) || name.replace(/^#/, '');
    const abandonedAt = toDate(head['Created at']);
    if (!abandonedAt) { skipped.push({ name, reason: 'unreadable "Created at"' }); continue; }

    carts.push({
      // Namespaced so a Shopify id can never collide with a GoKwik request_id.
      cartId: `shopify-${shopifyId}`,
      customerName: first(head['Billing Name'], head['Shipping Name']),
      phone: first(head['Phone'], head['Billing Phone'], head['Shipping Phone']),
      email: first(head.Email),
      totalPrice: toNumber(head.Total),
      subtotal: toNumber(head.Subtotal),
      discountTotal: toNumber(head['Discount Amount']),
      mrpTotal: null,
      currency: first(head.Currency) || 'INR',
      // Shopify's CSV carries no recovery URL, and there is no way to derive one
      // from the export — see the README note.
      checkoutUrl: null,
      itemCount: items.reduce((n, i) => n + (i.quantity || 1), 0) || null,
      abandonedAt,
      dropStage: null,
      dropReason: null,
      riskFlag: first(head['Risk Level']),
      utmSource: first(head.Source),
      utmCampaign: null,
      utmMedium: null,
      address: address(head),
      gokwikEmailSent: null,
      gokwikMessageQueued: null,
      brandOrderCount: null,
      items,
      // Kept so a mapping fix can be replayed, exactly as with the webhook.
      raw: { _source: 'shopify-csv', checkout: name, rows },
    });
  }

  return { carts, skipped, totalRows: records.length };
}
