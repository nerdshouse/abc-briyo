# Briyo OS: Shopify orders (version 1)

Shopify **orders** become Briyo OS **website** orders in Orders & Logistics. This is separate from Shopify **abandoned checkouts**, which go to Support's cart board (`lib/shopify-poll.js`). The two never share code paths or data.

```
Shopify Admin GraphQL (read_orders, server-side)
  → lib/shopify-orders.js   plan → diff → apply (one transaction per page)
  → orders (channel website, source shopify_sync) + order_items
  → SKU resolution (master code, then the "website" platform mapping)
  → Logistics creates shipments, reserves and dispatches stock as for any order
```

## What a sync does, and does not do

- **Does:** creates or updates the commercial order and its line items, keyed on Shopify's stable GIDs. Re-running a sync is a no-op.
- **Never does:** create shipments, reserve stock, deduct stock or write stock movements.
- **Fulfilment:** Shopify's fulfilment and tracking data is kept in `source_payload.shopify` and shown as "Shopify's record — not a Briyo shipment". Briyo Logistics stays the source of truth for parcels.

## Identity

| Briyo | Shopify |
|---|---|
| `channel` | `website` (the existing channel; no separate Shopify channel) |
| `source` | `shopify_sync` (the UI shows **Website · Shopify**) |
| `source_order_id` | Order GID, e.g. `gid://shopify/Order/5612345678`. It is stable and can't collide with a hand-typed website order number. |
| `source_payload.shopify.name` | `#1001`. Shown as the order number and searchable. |
| `order_items.source_line_item_id` | LineItem GID |

## Field mapping

| Briyo | Shopify |
|---|---|
| `order_date` | `createdAt` |
| `customer_name` | `customer.firstName lastName`, falling back to `shippingAddress.name` |
| `customer_email` / `customer_phone` | `customer.email` / `customer.phone`, falling back to `email`, `phone` and `shippingAddress.phone` |
| `order_value`, `currency` | `currentTotalPriceSet.shopMoney` (after edits and refunds) |
| `fulfillment_type` | `merchant` |
| `dispatch_type` | `easy_ship` (the website channel's only type) |
| `order_status` | `new`; `cancelled` only per the rules below; never `completed` |
| item `sku` | Line `sku`, or **NULL** when Shopify has none. A title is never used as a SKU. |
| item `title` | `title — variantTitle` |
| item `quantity` | `currentQuantity` (after edits and removals) |
| item `item_price` | `originalTotalSet` (the line total, before discounts) |
| item `item_tax` | Sum of `taxLines` |
| item `promotion_discount` | `−totalDiscountSet`. Negative, as in the Amazon import. |
| item `shipping_*` | NULL. Shopify charges shipping per order; it is kept in the payload (`shipping_lines`, `total_shipping`) and never spread over lines. |

The payload also keeps: financial and fulfilment status, gateways, tags, note, cancel time and reason, shipping lines, fulfilments with tracking, and the ship-to address. It never contains a token or secret.

### Payment status (`displayFinancialStatus`)

| Shopify | Briyo |
|---|---|
| `PENDING`, `AUTHORIZED` (held, not captured) | `pending` |
| `PAID` | `paid` |
| `PARTIALLY_PAID` | `partially_paid` |
| `REFUNDED` | `refunded` |
| `PARTIALLY_REFUNDED` | `partially_refunded` |
| `VOIDED` | `voided` |
| `EXPIRED`, anything else | not known (NULL); no equivalent |

### Payment method (`paymentGatewayNames`)

| Gateways | Briyo |
|---|---|
| Any cash-on-delivery gateway | `cod` |
| Only recognised online gateways (Shopify Payments, Razorpay, PayU, Cashfree, PhonePe, Paytm, Stripe, PayPal, CCAvenue, Easebuzz, Juspay, UPI) | `prepaid` |
| Anything else (manual, gift card, GoKwik alone, mixed) | `other` |
| None | not known (NULL) |

GoKwik checkouts can be either prepaid or COD, so "gokwik" alone is `other`.

## SKU resolution

1. An exact master SKU code match resolves directly.
2. Otherwise the **`website`** platform mapping (Inventory → SKU → platform SKUs) is used.
3. Otherwise the line imports **unmapped**. It appears in Unmapped SKUs (mappable), and its order cannot be dispatched until the SKU is mapped.

Nothing is fuzzy-matched or guessed, and no SKU is ever created. Once an admin adds the mapping, existing lines resolve immediately, without re-importing. The next sync also re-resolves any still-unmapped lines.

## Sync strategy

- **Initial import:** last 7, 30 or 60 days, or custom dates.
  - Shopify only returns the last **60 days** with `read_orders`; longer windows need `read_all_orders` plus `SHOPIFY_READ_ALL_ORDERS=true`.
  - Always preview first: the preview writes nothing.
- **Incremental:** `updated_at ≥ checkpoint − 5 min`.
  - The checkpoint is the start time of the last *complete* run, so anything changed while a run was going is caught next time.
- **Bounded and resumable:** 10 orders per page and at most 2,500 per run. Each order's detail (lines, discounts, refunds) is fetched in its own requests so every query stays well under Shopify's 1,000-point cost limit — see [ORDER-FINANCIAL-SNAPSHOTS.md](ORDER-FINANCIAL-SNAPSHOTS.md).
  - A longer window ends "partial", with a cursor saved on the run. **Continue** picks it up.
  - Runs are idempotent, so a repeat or a resume only finds the remaining work.
- **Skipped:** Shopify test orders. Orders with more than 50 line items, or with any detail that could not be fetched completely (10 or more refunds, more than 50 lines in a refund, more than 10 discount applications, 5 or more tax lines on a line), are held back whole, never half-imported.
- **Polling:** `SHOPIFY_ORDERS_POLL_ENABLED=true` (default off), every `SHOPIFY_ORDERS_POLL_MINUTES` (default 15). It only runs once an initial import has set a checkpoint.
- **Customer data:** if Shopify refuses protected customer data (name, email, phone, address), the sync continues without those fields and says so.

## Changes and conflicts

These follow the Amazon re-import rules.

- **Never wipes:** an empty Shopify value never clears a recorded one.
- **Team values stand:** payment method and status follow Shopify only while the team hasn't changed them since the last sync. For example, a COD order the team marked **paid** stays paid.
- **Locked lines:** an order is **locked** once stock is reserved for its parcel, or has left (a dispatch movement, or a parcel past dispatch). A Shopify line change is then **not applied**; it's recorded as a `lines_locked` conflict.
- **Locked value:** on a locked order, a change to the Shopify total does **not** overwrite `order_value`. Briyo keeps the value Logistics worked to, records a `value_locked` conflict (shown with the old and new values in the sync history and the order's activity), and keeps Shopify's latest total in `source_payload.shopify.current_total`.
- **Cancellations:** a Shopify cancellation cancels the Briyo order only if it has **no active shipment**. Otherwise it's a `cancelled_with_shipment` conflict for a person to resolve.
- **Logged once:** a conflict is logged on the order once, and again only if Shopify changes the order after that.
- **Never changed by a sync:** Briyo's order status (except the cancellation above), shipments, documents, notes and routing.
- **Possible duplicates:** a website order typed by hand under the Shopify number (`#1001` or `1001`) means the Shopify order is held back as a possible duplicate rather than imported a second time.

## Audit

Every run is a row in `order_imports` with:
- `kind = 'shopify_sync'`
- status: running, completed, partial or failed
- `started_at`, `completed_at`, and who ran it
- counts fetched, created, updated and unchanged, plus line counts
- `conflicts`, `unmapped_lines`, `errors`
- `details`: the window, cursor, conflicts, duplicates and skipped tests

Each order also gets `order_created`, `shopify_sync_updated` and `shopify_sync_conflict` events in its history.

## Access

- **Admin only:** connecting (`/auth/shopify/install`), the status card, preview and sync. The API enforces this, not just the UI.
- **Customer data:** follows the existing Orders permissions.
- **Server-side only:** the browser never calls Shopify. The token is sent only in the `X-Shopify-Access-Token` header and never logged or returned.
