/**
 * Maps a GoKwik abandoned-cart payload onto our columns.
 *
 * Key matching is deliberately forgiving: keys are compared with case, spaces,
 * underscores and hyphens stripped, so "Customer Name", "customer_name" and
 * "customerName" are all the same key. GoKwik's report CSV and their webhook
 * JSON don't use identical spellings, and this way both work.
 *
 * The full body is always stored in raw_payload, so anything missed here is
 * recoverable without re-collecting data.
 */

const ENVELOPES = [
  'data', 'payload', 'cart', 'checkout', 'order', 'event', 'body', 'attributes',
  'totals', 'customer', 'address', 'shipping', 'session',
];

/** "Customer Name" -> "customername" */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Case/separator-insensitive property lookup. */
function getKey(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const want = norm(key);
  for (const k of Object.keys(obj)) if (norm(k) === want) return obj[k];
  return undefined;
}

function get(obj, path) {
  return path.split('.').reduce((acc, key) => getKey(acc, key), obj);
}

function isEmpty(value) {
  return (
    value === undefined || value === null || value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

/**
 * Money keys are generic ("price", "total"), so searching customer/shipping/
 * address envelopes finds the wrong number — shipping.price instead of the cart
 * total. Money lookups get a restricted envelope list.
 */
const MONEY_ENVELOPES = ['data', 'payload', 'cart', 'checkout', 'order', 'totals'];

function pick(payload, paths, envelopes = ENVELOPES) {
  const roots = [payload];
  for (const env of envelopes) {
    const nested = getKey(payload, env);
    if (nested && typeof nested === 'object') roots.push(nested);
  }
  for (const root of roots) {
    for (const path of paths) {
      const value = get(root, path);
      if (!isEmpty(value)) return value;
    }
  }
  return undefined;
}

function toStr(value) {
  if (isEmpty(value)) return null;
  if (typeof value === 'object') return null;
  return String(value).trim() || null;
}

function toNumber(value) {
  if (isEmpty(value)) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * GoKwik writes dates as D/M/YYYY h:mm AM/PM with no timezone — "7/9/2026 11:41 PM"
 * is 7 September, not 9 July. JS would read it as US M/D, so parse it explicitly
 * and treat the wall-clock time as IST, which is what the reports are in.
 */
function parseGoKwikDate(text) {
  const m = String(text).trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!m) return null;
  const [, d, mo, y, hRaw, min, sec, ampm] = m;
  let hour = Number(hRaw ?? 0);
  if (ampm) {
    const upper = ampm.toUpperCase();
    if (upper === 'PM' && hour !== 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` +
              `T${String(hour).padStart(2, '0')}:${min ?? '00'}:${sec ?? '00'}+05:30`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toDate(value) {
  if (isEmpty(value)) return null;

  // Unix seconds or milliseconds
  if (typeof value === 'number' || /^\d{10}(\d{3})?$/.test(String(value))) {
    const num = Number(value);
    const ms = String(Math.trunc(num)).length <= 10 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const gokwik = parseGoKwikDate(value);
  if (gokwik) return gokwik;

  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** GoKwik sends these as real booleans in some payloads and "true"/"false"
 *  strings in others. Unknown stays null rather than becoming false. */
function toBool(value) {
  if (value === true || value === false) return value;
  if (isEmpty(value)) return null;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  return null;
}

function joinName(...parts) {
  const name = parts.map((p) => toStr(p)).filter(Boolean).join(' ').trim();
  // GoKwik pads missing surnames with a lone "." — "Pawan ." reads badly.
  const cleaned = name.replace(/\s+\.$/, '').trim();
  return cleaned || null;
}

const decodeEntities = (s) => (s == null ? null : String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

/**
 * GoKwik's "Line items" is a single string:
 *   #Product A(Variant A)*1#Product B(Variant B)*2
 * Webhook deliveries may instead send an array. Handle both.
 */
/**
 * Splits "Product (Box) - Thing(Product (Box) - Thing - Pack of 1)" into
 * ["Product (Box) - Thing", "Product (Box) - Thing - Pack of 1"].
 * Scans from the end counting depth, because the product name itself may
 * contain parentheses — a plain regex mismatches those.
 */
function splitTrailingParens(text) {
  if (!text.endsWith(')')) return [text, null];
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      depth -= 1;
      if (depth === 0) {
        const name = text.slice(0, i).trim();
        const inner = text.slice(i + 1, -1).trim();
        return name ? [name, inner] : [inner, null];
      }
    }
  }
  return [text, null];
}

export function parseLineItems(value) {
  if (Array.isArray(value)) {
    return value.map((i) => ({
      title: decodeEntities(i?.title || i?.name || i?.product_name || i?.sku || 'Item'),
      quantity: Number(i?.quantity ?? i?.qty ?? 1) || 1,
    }));
  }
  if (typeof value !== 'string' || !value.trim()) return [];

  return value.split('#').filter((chunk) => chunk.trim()).map((chunk) => {
    // "Name(Variant)*2" -> title, quantity 2
    const qty = chunk.match(/\*(\d+)\s*$/);
    const withoutQty = (qty ? chunk.slice(0, qty.index) : chunk).trim();
    const [name, variant] = splitTrailingParens(withoutQty);

    // The variant usually repeats the product name ("Whey 1kg(Whey 1kg - Pack of 2)").
    // Prefer the variant alone in that case; it carries strictly more information.
    let title = name;
    if (variant) {
      const nName = norm(name);
      title = nName && norm(variant).startsWith(nName) ? variant : `${name} — ${variant}`;
    }
    return { title: decodeEntities(title), quantity: qty ? Number(qty[1]) : 1 };
  });
}

/** GoKwik sends the address as an object; render it as one readable line. */
function formatAddress(value) {
  if (isEmpty(value)) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value !== 'object') return null;

  const part = (...names) => {
    for (const n of names) {
      const v = getKey(value, n);
      if (!isEmpty(v) && typeof v !== 'object') return String(v).trim();
    }
    return null;
  };
  const pieces = [
    part('line1', 'address1', 'address_line1', 'street', 'address'),
    part('line2', 'address2', 'address_line2', 'landmark'),
    part('city', 'town', 'district'),
    part('state', 'province', 'region'),
    part('pincode', 'zip', 'postcode', 'postal_code'),
    part('country'),
  ].filter(Boolean);
  return pieces.length ? pieces.join(', ') : null;
}

export function normalizePayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};

  const cartId = pick(p, [
    'request_id', 'cart_id', 'checkout_id', 'id', 'token', 'cart_token',
    'checkout_token', 'order_id', 'reference_id', 'moid', 'merchant_order_id', 'mrid',
  ]);

  const firstName = pick(p, [
    'first_name', 'customer.first_name', 'billing_address.first_name',
    'shipping_address.first_name', 'user.first_name',
  ]);
  const lastName = pick(p, [
    'last_name', 'customer.last_name', 'billing_address.last_name',
    'shipping_address.last_name', 'user.last_name',
  ]);
  const fullName = pick(p, [
    'customer_name', 'name', 'full_name', 'customer.name', 'customer.full_name',
    'user.name', 'billing_address.name', 'shipping_address.name',
  ]);

  const phone = pick(p, [
    'phone_number', 'phone', 'mobile_number', 'mobile', 'msisdn', 'contact_number',
    'contact', 'customer.phone', 'customer.phone_number', 'customer.mobile',
    'user.phone', 'billing_address.phone', 'shipping_address.phone',
  ]);

  const email = pick(p, [
    'email_id', 'email', 'email_address', 'customer_email', 'customer.email',
    'customer.email_address', 'user.email', 'billing_address.email',
  ]);

  // An explicit payable total, if GoKwik sends one.
  const explicitTotal = pick(p, [
    'amount', 'totals.total', 'totals.total_price', 'totals.grand_total', 'totals.amount',
    'totals.payable', 'total_price', 'total', 'total_amount', 'cart_value',
    'grand_total', 'order_total', 'payable_amount',
  ], MONEY_ENVELOPES);

  const subtotal = pick(p, [
    'items_subtotal_price', 'subtotal_price', 'subtotal', 'items_subtotal',
  ], MONEY_ENVELOPES);

  const mrpTotal = pick(p, ['mrp_total', 'mrp', 'compare_at_total'], MONEY_ENVELOPES);

  const discountTotal = pick(p, [
    'total_discount', 'discount_total', 'discount_amount', 'totals.discount',
    'totals.discount_total', 'discount.amount', 'discount.value',
  ], MONEY_ENVELOPES);

  const shippingPrice = pick(p, ['shipping.price', 'shipping_price', 'shipping_charges'], ENVELOPES);
  const codCharges = pick(p, ['cod_charges', 'cod_charge', 'cod_fee'], MONEY_ENVELOPES);

  /**
   * The webhook sends the parts, not the total: items_subtotal_price, minus
   * total_discount, plus shipping and COD. Compute it when no explicit total is
   * present — otherwise the board shows a cart value the customer never saw.
   */
  const computedTotal = (() => {
    const sub = toNumber(subtotal);
    if (sub === null) return null;
    return sub
      - (toNumber(discountTotal) ?? 0)
      + (toNumber(shippingPrice) ?? 0)
      + (toNumber(codCharges) ?? 0);
  })();

  const currency = pick(p, [
    'currency', 'currency_code', 'presentment_currency',
    'total_price_set.shop_money.currency_code',
  ]);

  const checkoutUrl = pick(p, [
    'abandoned_cart_link', 'abc_url', 'checkout_url', 'abandoned_checkout_url',
    'recovery_url', 'cart_url', 'url', 'web_url', 'link', 'short_url', 'payment_link',
  ]);

  const lineItems = pick(p, [
    'line_items', 'items', 'products', 'cart_items', 'order_items', 'skus',
  ]);
  const items = parseLineItems(lineItems);

  const declaredItemCount = pick(p, [
    'item_count', 'items_count', 'total_items', 'quantity',
  ]);

  const abandonedAt = pick(p, [
    'created_at', 'abandoned_at', 'timestamp', 'time', 'event_time', 'updated_at',
    'cart_created_at', 'date', 'created',
  ]);

  // GoKwik-specific signals that matter for prioritising a call list.
  const dropStage = pick(p, ['drop_stage', 'dropped_stage', 'stage', 'drop_off_stage']);
  const dropReason = pick(p, ['drop_off_reasons', 'drop_reason', 'drop_off_reason', 'reason']);
  // GoKwik's live payload calls this `rto_risk_flag` (return-to-origin risk).
  // Values seen in production: "High Risk" / "Medium Risk" / "Low Risk".
  const riskFlag = pick(p, [
    'rto_risk_flag', 'rto_risk', 'risk_flag', 'risk', 'risk_level', 'risk_category',
  ]);
  // GoKwik uses `mkt_*` for attribution, and `orig_referrer` — note that is a
  // genuinely different key from `origin_referrer`, which norm() will not equate.
  // Their top-level `source` is a delivery-channel marker, not a marketing
  // source, so it is deliberately excluded.
  const utmSource = pick(p, ['mkt_source', 'utm_source', 'orig_referrer', 'origin_referrer', 'utm.source']);
  const utmCampaign = pick(p, ['mkt_campaign', 'utm_campaign', 'campaign']);
  const utmMedium = pick(p, ['mkt_medium', 'utm_medium', 'medium']);

  /**
   * GoKwik runs its own recovery flows (email, and messaging via Gupshup /
   * Limechat). Surfacing that is the difference between a caller opening with
   * "just checking in" and repeating a message the customer already had.
   */
  const emailSent = pick(p, ['abc_email_sent', 'email_sent']);
  const messageQueued = pick(p, ['message_enqueued', 'email_enqueued', 'notify_customer']);
  const orderCount = pick(p, ['brand_order_count', 'order_count', 'orders_count']);

  const address = formatAddress(pick(p, [
    'customer_address', 'address', 'billing_address', 'shipping_address',
    'full_address', 'address_line',
  ]));

  return {
    cartId: toStr(cartId),
    customerName: joinName(fullName) || joinName(firstName, lastName),
    phone: toStr(phone),
    email: toStr(email),
    totalPrice: toNumber(explicitTotal) ?? computedTotal,
    subtotal: toNumber(subtotal),
    mrpTotal: toNumber(mrpTotal),
    discountTotal: toNumber(discountTotal),
    currency: toStr(currency) || 'INR',
    checkoutUrl: toStr(checkoutUrl),
    itemCount: toNumber(declaredItemCount)
      ?? (items.length ? items.reduce((sum, i) => sum + (i.quantity || 1), 0) : null),
    abandonedAt: toDate(abandonedAt),
    dropStage: toStr(dropStage),
    dropReason: toStr(dropReason),
    riskFlag: toStr(riskFlag),
    utmSource: toStr(utmSource),
    utmCampaign: toStr(utmCampaign),
    utmMedium: toStr(utmMedium),
    gokwikEmailSent: toBool(emailSent),
    gokwikMessageQueued: toBool(messageQueued),
    brandOrderCount: toNumber(orderCount),
    address: toStr(address),
    items,
  };
}

/**
 * Order-completed / payment-confirmed events from GoKwik.
 *
 * The exact payload for this event is NOT confirmed — it may not even be
 * enabled on the account yet. Extraction is therefore best-effort across the
 * plausible key names, and callers are expected to warn (not throw) when a
 * field is missing. The full body is stored regardless.
 */
export function normalizeOrderPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};

  const orderId = pick(p, [
    'order_id', 'orderid', 'id', 'request_id', 'merchant_order_id', 'moid',
    'reference_id', 'transaction_id', 'payment_id', 'order.id', 'order.order_id',
  ]);

  const orderName = pick(p, [
    'order_name', 'order_number', 'name', 'display_name', 'invoice_number',
    'receipt', 'order.name', 'order.order_number',
  ]);

  const phone = pick(p, [
    'phone_number', 'phone', 'mobile_number', 'mobile', 'msisdn', 'contact_number',
    'contact', 'customer.phone', 'customer.phone_number', 'customer.mobile',
    'billing_address.phone', 'shipping_address.phone', 'address.phone',
  ]);

  const email = pick(p, [
    'email_id', 'email', 'email_address', 'customer_email',
    'customer.email', 'customer.email_address', 'billing_address.email',
  ]);

  const amount = pick(p, [
    'amount', 'total', 'total_price', 'total_amount', 'grand_total',
    'order_total', 'payable_amount', 'totals.total',
  ], MONEY_ENVELOPES);

  const createdAt = pick(p, [
    'created_at', 'order_date', 'paid_at', 'timestamp', 'time', 'event_time', 'date',
  ]);

  return {
    orderId: toStr(orderId),
    orderName: toStr(orderName) || toStr(orderId),
    phone: toStr(phone),
    email: toStr(email),
    amount: toNumber(amount),
    createdAt: toDate(createdAt),
  };
}

/**
 * Keys stripped from the payload before it is stored.
 *
 * Every one of these is personal data we never derive a column from, so removing
 * them costs nothing and stops PII accumulating indefinitely in raw_payload.
 * Check `normalizePayload` before adding to this list — anything it reads must
 * stay, or the backfill in scripts/renormalize.js silently degrades.
 *
 *   ip, user_agent, session_id      device/network fingerprinting
 *   shopifysessionid, domain_userid  ditto
 *   gst_details_enc                  encrypted tax identifiers
 *   mapped_email_enc/_hash/_mask     redundant with the plain email we keep
 *   billing_address_details_pii      full billing address blob
 */
export const REDACTED_KEYS = [
  'ip', 'user_agent', 'session_id', 'shopifysessionid', 'domain_userid',
  'gst_details_enc', 'mapped_email_enc', 'mapped_email_hash', 'mapped_email_mask',
  'billing_address_details_pii',
];

export function redactPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clean = { ...payload };
  for (const k of REDACTED_KEYS) delete clean[k];
  return clean;
}
