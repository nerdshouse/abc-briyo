/**
 * GoKwik's exact abandoned-cart field names are NOT confirmed.
 * Everything here is best-effort: we probe a list of plausible key paths for
 * each field and take the first non-empty hit. The full body is always stored
 * in raw_payload, so a wrong guess here is recoverable without data loss.
 *
 * Paths use dot notation; `[]` is not needed — we also search one level deep
 * inside common envelope keys (data, payload, cart, checkout, order, event).
 */

const ENVELOPES = ['data', 'payload', 'cart', 'checkout', 'order', 'event', 'body', 'attributes'];

function get(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function isEmpty(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

/** Look up `paths` on the root object and inside each known envelope key. */
function pick(payload, paths) {
  const roots = [payload];
  for (const env of ENVELOPES) {
    const nested = payload?.[env];
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
  // Handles "1,299.00", "₹1299", 1299, "1299.50"
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
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
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function joinName(...parts) {
  const name = parts.map((p) => toStr(p)).filter(Boolean).join(' ').trim();
  return name || null;
}

export function normalizePayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};

  const cartId = pick(p, [
    'cart_id', 'cartId', 'checkout_id', 'checkoutId', 'id', 'token', 'cart_token',
    'cartToken', 'checkout_token', 'order_id', 'orderId', 'reference_id', 'moid',
    'merchant_order_id', 'request_id',
  ]);

  const firstName = pick(p, [
    'first_name', 'firstName', 'customer.first_name', 'customer.firstName',
    'billing_address.first_name', 'shipping_address.first_name', 'user.first_name',
  ]);
  const lastName = pick(p, [
    'last_name', 'lastName', 'customer.last_name', 'customer.lastName',
    'billing_address.last_name', 'shipping_address.last_name', 'user.last_name',
  ]);
  const fullName = pick(p, [
    'customer_name', 'customerName', 'name', 'full_name', 'fullName',
    'customer.name', 'customer.full_name', 'user.name', 'billing_address.name',
    'shipping_address.name', 'billing_address.full_name',
  ]);

  const phone = pick(p, [
    'phone', 'phone_number', 'phoneNumber', 'mobile', 'mobile_number', 'mobileNumber',
    'msisdn', 'contact', 'contact_number', 'customer.phone', 'customer.phone_number',
    'customer.mobile', 'user.phone', 'billing_address.phone', 'shipping_address.phone',
  ]);

  const email = pick(p, [
    'email', 'email_address', 'emailAddress', 'customer_email', 'customerEmail',
    'customer.email', 'customer.email_address', 'user.email', 'billing_address.email',
  ]);

  const totalPrice = pick(p, [
    'total_price', 'totalPrice', 'total', 'amount', 'total_amount', 'totalAmount',
    'cart_value', 'cartValue', 'grand_total', 'grandTotal', 'subtotal_price',
    'order_total', 'price', 'total_price_set.shop_money.amount', 'mid_amount',
  ]);

  const currency = pick(p, [
    'currency', 'currency_code', 'currencyCode', 'presentment_currency',
    'total_price_set.shop_money.currency_code',
  ]);

  const checkoutUrl = pick(p, [
    'checkout_url', 'checkoutUrl', 'abandoned_checkout_url', 'abandonedCheckoutUrl',
    'recovery_url', 'recoveryUrl', 'cart_url', 'cartUrl', 'url', 'web_url', 'link',
    'short_url', 'payment_link',
  ]);

  const lineItems = pick(p, [
    'line_items', 'lineItems', 'items', 'products', 'cart_items', 'cartItems',
    'order_items', 'skus',
  ]);

  const abandonedAt = pick(p, [
    'created_at', 'createdAt', 'abandoned_at', 'abandonedAt', 'timestamp', 'time',
    'event_time', 'eventTime', 'updated_at', 'cart_created_at', 'date', 'created',
  ]);

  const items = Array.isArray(lineItems) ? lineItems : null;

  return {
    cartId: toStr(cartId),
    customerName: joinName(fullName) || joinName(firstName, lastName),
    phone: toStr(phone),
    email: toStr(email),
    totalPrice: toNumber(totalPrice),
    currency: toStr(currency) || 'INR',
    checkoutUrl: toStr(checkoutUrl),
    itemCount: items
      ? items.reduce((sum, item) => sum + (toNumber(item?.quantity ?? item?.qty) ?? 1), 0)
      : null,
    abandonedAt: toDate(abandonedAt),
  };
}
