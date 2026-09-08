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

function pick(payload, paths) {
  const roots = [payload];
  for (const env of ENVELOPES) {
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

  const totalPrice = pick(p, [
    'amount', 'totals.total', 'totals.total_price', 'totals.grand_total', 'totals.amount',
    'totals.payable', 'total_price', 'total', 'total_amount', 'cart_value',
    'grand_total', 'subtotal_price', 'order_total', 'price',
  ]);

  const mrpTotal = pick(p, ['mrp_total', 'mrp', 'totals.mrp_total', 'compare_at_total']);
  const discountTotal = pick(p, [
    'discount_total', 'discount', 'totals.discount', 'totals.discount_total',
    'total_discount', 'discount_amount',
  ]);

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
  const riskFlag = pick(p, ['risk_flag', 'risk', 'risk_level', 'risk_category']);
  const utmSource = pick(p, ['utm_source', 'source', 'origin_referrer']);
  const address = pick(p, [
    'customer_address', 'address', 'billing_address.address', 'shipping_address.address',
    'full_address', 'address_line',
  ]);

  return {
    cartId: toStr(cartId),
    customerName: joinName(fullName) || joinName(firstName, lastName),
    phone: toStr(phone),
    email: toStr(email),
    totalPrice: toNumber(totalPrice),
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
    address: toStr(address),
    items,
  };
}
