/**
 * The Shopify order queries, each written once as a tree that renders both the
 * GraphQL text and its worst-case requested cost — so the cost check in
 * scripts/db-check.js measures exactly the query that is sent.
 *
 * Shopify refuses any single query whose requested cost exceeds 1,000 points,
 * before running it. Its published rules: scalars and enums 0, objects 1,
 * interfaces and unions the maximum of their possible selections, connections
 * sized by `first`. The exact connection formula is not published, so this
 * estimate is deliberately conservative:
 *
 *   object                 1 + selection
 *   connection(first N)    2 + N × (1 + selection)
 *   list with first N      N × (1 + selection)
 *   list without a size    BOUND × (1 + selection)   (BOUND stated per field below)
 *   selection              Σ fields + max(inline fragments)   (an interface/union costs its largest branch)
 *
 * The sync also records each response's actual requestedQueryCost, so the
 * first real run confirms this estimate against Shopify's own number.
 */

export const SHOPIFY_MAX_QUERY_COST = 1000;

// Paging approved for Phase 1B. Lines are fetched over several requests per
// order, never truncated: an order that does not fit is held back whole.
export const LIMITS = {
  ordersPerPage: 10,
  linesPerOrder: 50,          // more lines than this → order held back
  linesFirstPage: 6,          // line items inside the per-order detail request
  linesNextPage: 8,           // line items in each follow-up request
  refundsPerOrder: 10,        // a list without paging: exactly 10 returned → held back
  refundLines: 50,            // per refund (connection: more → held back)
  refundShippingLines: 5,     // per refund (connection: more → held back)
  discountApplications: 10,   // connection: more → held back
  shippingLines: 5,
  fulfillments: 10,
  trackingInfo: 5,
  taxLinesPerLine: 5,         // a list: exactly 5 returned → held back
};
// Lists Shopify returns without a size argument, and the bound assumed for the estimate.
export const UNBOUNDED_LIST_BOUND = { customAttributes: 20, discountAllocations: 10 };

/* ------------------------------------------------------------------ the tree */

const S = (...names) => names.map((name) => ({ t: 'scalar', name }));
const O = (name, children, args = '') => ({ t: 'object', name, args, children });
const L = (name, children, { first = null, bound = null } = {}) => ({ t: 'list', name, children, first, bound });
const C = (name, children, { first, after = '', args = '' }) => ({ t: 'connection', name, children, first, after, args });
const ON = (type, children) => ({ t: 'on', type, children });
const MONEY = (name) => O(name, [O('shopMoney', S('amount', 'currencyCode')), O('presentmentMoney', S('amount', 'currencyCode'))]);

function render(nodes) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'scalar': return n.name;
      case 'object': return `${n.name}${n.args ? `(${n.args})` : ''} { ${render(n.children)} }`;
      case 'list': return `${n.name}${n.first ? `(first: ${n.first})` : ''} { ${render(n.children)} }`;
      case 'connection': return `${n.name}(${[`first: ${n.first}`, n.after && `after: ${n.after}`, n.args].filter(Boolean).join(', ')}) { pageInfo { hasNextPage endCursor } nodes { ${render(n.children)} } }`;
      case 'on': return `... on ${n.type} { ${render(n.children)} }`;
      default: throw new Error(`unknown node ${n.t}`);
    }
  }).join(' ');
}

function selectionCost(nodes) {
  let fields = 0; let fragments = 0;
  for (const n of nodes) {
    if (n.t === 'on') fragments = Math.max(fragments, selectionCost(n.children));
    else fields += fieldCost(n);
  }
  return fields + fragments;
}
function fieldCost(n) {
  switch (n.t) {
    case 'scalar': return 0;
    case 'object': return 1 + selectionCost(n.children);
    case 'list': {
      const size = n.first ?? n.bound;
      if (!size) throw new Error(`list ${n.name} has no size: give it a first or a bound`);
      return size * (1 + selectionCost(n.children));
    }
    case 'connection': return 2 + n.first * (1 + selectionCost(n.children));
    default: throw new Error(`unknown node ${n.t}`);
  }
}

/* ------------------------------------------------------------------ selections */

const ORDER_MONEY = ['currentTotalPriceSet', 'totalPriceSet', 'currentSubtotalPriceSet', 'currentTotalTaxSet', 'currentTotalDiscountsSet',
  'currentShippingPriceSet', 'totalShippingPriceSet', 'totalRefundedSet', 'totalRefundedShippingSet'].map(MONEY);

const PAGE_ORDER = (pii) => [
  ...S('id', 'name', 'createdAt', 'updatedAt', 'processedAt', 'cancelledAt', 'cancelReason', 'closedAt', 'test',
    'displayFinancialStatus', 'displayFulfillmentStatus', 'paymentGatewayNames', 'currencyCode', 'presentmentCurrencyCode',
    'taxesIncluded', 'tags', 'note', 'discountCodes'),
  ...ORDER_MONEY,
  L('customAttributes', S('key', 'value'), { bound: UNBOUNDED_LIST_BOUND.customAttributes }),
  // Shopify gates the customer (its id included) and the address behind protected customer data.
  ...(pii ? [...S('email', 'phone'), O('customer', S('id', 'firstName', 'lastName', 'email', 'phone')),
    O('shippingAddress', S('name', 'phone', 'address1', 'address2', 'city', 'province', 'zip', 'countryCodeV2'))] : []),
];

const LINE = [
  ...S('id', 'sku', 'name', 'title', 'variantTitle', 'quantity', 'currentQuantity', 'refundableQuantity', 'taxable', 'isGiftCard', 'requiresShipping'),
  O('variant', S('id')), O('product', S('id')),
  ...['originalUnitPriceSet', 'discountedUnitPriceAfterAllDiscountsSet', 'originalTotalSet', 'discountedTotalSet', 'totalDiscountSet'].map(MONEY),
  L('taxLines', [...S('title', 'rate', 'ratePercentage', 'channelLiable'), MONEY('priceSet')], { first: LIMITS.taxLinesPerLine }),
  L('discountAllocations', [MONEY('allocatedAmountSet'), O('discountApplication', S('index'))], { bound: UNBOUNDED_LIST_BOUND.discountAllocations }),
];

const DISCOUNT_APPLICATION = [
  ...S('allocationMethod', 'index', 'targetSelection', 'targetType'),
  O('value', [ON('MoneyV2', S('amount', 'currencyCode')), ON('PricingPercentageValue', S('percentage'))]),
  ON('DiscountCodeApplication', S('code')),
  ON('AutomaticDiscountApplication', S('title')),
  ON('ManualDiscountApplication', S('title', 'description')),
  ON('ScriptDiscountApplication', S('title')),
];

const DETAIL_ORDER = [
  ...S('id'),
  C('shippingLines', [...S('title', 'code'), MONEY('originalPriceSet')], { first: LIMITS.shippingLines }),
  L('fulfillments', [...S('status', 'createdAt'), L('trackingInfo', S('company', 'number', 'url'), { first: LIMITS.trackingInfo })], { first: LIMITS.fulfillments }),
  C('discountApplications', DISCOUNT_APPLICATION, { first: LIMITS.discountApplications }),
  L('refunds', [...S('id', 'createdAt', 'note'), MONEY('totalRefundedSet')], { first: LIMITS.refundsPerOrder }),
  C('lineItems', LINE, { first: LIMITS.linesFirstPage }),
];

const REFUND_DETAIL = [
  C('refundLineItems', [...S('id', 'quantity', 'restockType', 'restocked'), O('lineItem', S('id')),
    MONEY('priceSet'), MONEY('subtotalSet'), MONEY('totalTaxSet')], { first: LIMITS.refundLines }),
  C('refundShippingLines', [...S('id'), O('shippingLine', S('title', 'code')), MONEY('subtotalAmountSet'), MONEY('taxAmountSet')], { first: LIMITS.refundShippingLines }),
];

/* ------------------------------------------------------------------ the four queries */

const QUERIES = {
  ordersPage: {
    head: 'query BriyoOrdersPage($after: String, $query: String)',
    tree: (pii) => [C('orders', PAGE_ORDER(pii), { first: LIMITS.ordersPerPage, after: '$after', args: 'query: $query, sortKey: UPDATED_AT' })],
  },
  orderDetail: {
    head: 'query BriyoOrderDetail($id: ID!)',
    tree: () => [O('order', DETAIL_ORDER, 'id: $id')],
  },
  orderLines: {
    head: 'query BriyoOrderLines($id: ID!, $after: String)',
    tree: () => [O('order', [...S('id'), C('lineItems', LINE, { first: LIMITS.linesNextPage, after: '$after' })], 'id: $id')],
  },
  refundDetail: {
    head: 'query BriyoRefundDetail($id: ID!)',
    tree: () => [O('node', [...S('id'), ON('Refund', REFUND_DETAIL)], 'id: $id')],
  },
};

export const SHOPIFY_ORDER_QUERIES = Object.keys(QUERIES);

/** The GraphQL text of a query. `pii` only changes the orders page. */
export function shopifyOrderQuery(name, { pii = true } = {}) {
  return `${QUERIES[name].head} { ${render(QUERIES[name].tree(pii))} }`;
}

/** Worst-case requested cost of a query under the model above. */
export function estimateShopifyOrderQueryCost(name, { pii = true } = {}) {
  return selectionCost(QUERIES[name].tree(pii));
}
