# Order financial snapshots

This table is infrastructure for future affiliate attribution and commission calculation. It does not calculate commissions.

## Why it exists

`orders` and `order_items` are the logistics view of an order. They are built around parcels and stock, and are frozen once stock is reserved or dispatched. They are not a financial record: there is no tax-inclusive flag, no refunds, and line quantities are current while prices are original.

The financial snapshots keep Shopify's own financial record of each order, as an append-only history. They're written by the existing Shopify order sync (`lib/shopify-orders.js`). Nothing else writes them.

## Tables

All five tables are append-only. A database trigger refuses `UPDATE` and `DELETE`. The one exception is the test suite's purge, which runs inside a transaction that sets `app.purge_order_financials`.

| Table | One row per |
|---|---|
| `order_financial_snapshots` | materially different state of an order (`order_id`, `sequence`) |
| `order_financial_snapshot_lines` | line item in that state |
| `order_financial_snapshot_refunds` | refund in that state |
| `order_financial_snapshot_refund_lines` | refunded line |
| `order_financial_snapshot_refund_shipping` | refunded shipping line |

The view `order_financial_latest` gives the latest snapshot of each order, which is its highest `sequence`.

### `order_financial_snapshots`

- **Order link:** `order_id` references `orders(id)` with `ON DELETE RESTRICT`, so an order with financial history cannot be deleted.
- **Identity:** `shopify_order_gid`, `shopify_order_name`, `sequence` (UNIQUE with `order_id`), `content_hash`, `source` and `sync_run_id`.
- **Timing:** `shopify_updated_at` and `captured_at`.
- **Currency and status:** `shop_currency`, `presentment_currency`, `taxes_included`, `financial_status` and `cancelled_at`.
- **Amounts:** `current_subtotal`, `current_total_tax`, `current_shipping`, `current_total_discounts`, `current_total_price`, `total_price`, `total_refunded` and `total_refunded_shipping`.
- **Discounts:** `discount_codes` and `discount_applications`, which records each application's index, type, code or title, allocation method and target, and its value as a percentage or an amount.
- **Attribution inputs:** `custom_attributes` (including `_briyo_ref` and `_briyo_click`) and `shopify_customer_gid`.

### Lines

Each line records:

- its Shopify identity: line GID, SKU, title, and variant and product GIDs;
- quantities: `quantity`, `current_quantity` and `refundable_quantity`;
- flags: `taxable`, `is_gift_card` and `requires_shipping`;
- prices: `original_unit_price`, `discounted_unit_price_after_all`, `original_total`, `discounted_total` and `total_discount`;
- tax: `tax_amount` and `tax_lines`;
- `discount_allocations`, each with the index of its discount application.

### Refunds

- **Refund:** GID, `refunded_at`, note and `total_refunded`.
- **Refund line:** the refunded line's GID, quantity, restock type, price, subtotal and tax.
- **Refund shipping line:** subtotal and tax.

## Money

- **Exact strings:** Shopify's amount strings are kept exactly as received, in both shop and presentment currency, in each row's `money` JSONB.
- **Numeric columns:** these hold the shop-currency amount as `NUMERIC(14,2)`. Postgres converts it from the string. It never passes through a JavaScript number.
- **Sums:** a sum such as a line's tax is added in whole minor units (BigInt).
- **More than 2 decimal places:** the amount is refused rather than rounded, and the order is held back.

## When a snapshot is written

The snapshot is written inside the same transaction as the sync page. If it fails, the whole page rolls back: no order, no line and no snapshot are written.

For every order on the page that Briyo holds (new, updated, unchanged, or locked), the sync does the following:

1. It hashes the snapshot content with SHA-256. Bookkeeping is left out: Shopify's `updatedAt`, which also changes for tags and notes, and the customer GID, which is missing when protected customer data isn't available.
2. If the latest snapshot has the same hash, nothing is written. Re-syncing is therefore a no-op.
3. Otherwise it writes `sequence + 1` together with all its lines and refunds. Earlier snapshots are never touched.

**Locked orders** (stock reserved or dispatched) still get snapshots. The snapshot never changes `orders.order_value`, `order_items`, stock, reservations or shipments.

**Preview (dry run)** reports `newFinancialSnapshots` and writes nothing. A commit reports `financialSnapshotsRecorded`, and stores in the run details the number of Shopify requests and the highest `requestedQueryCost` Shopify reported.

## Fetching within Shopify's cost limit

Shopify refuses any query whose requested cost is over 1,000 points. The queries are defined once in `lib/shopify-order-queries.js`, as trees that produce both the GraphQL text and a conservative worst-case cost estimate. `scripts/db-check.js` checks that every query keeps at least a 20% margin under the limit.

| Request | What it fetches | Estimated worst case | Margin |
|---|---|---|---|
| `BriyoOrdersPage` | 10 orders: header and order-level money | 502 (482 without customer data) | 498 |
| `BriyoOrderDetail` (per order) | shipping (5), fulfilments (10), discount applications (10), refunds (10), first 6 lines | 675 | 325 |
| `BriyoOrderLines` (as needed) | next 8 lines | 707 | 293 |
| `BriyoRefundDetail` (per refund) | refund lines (50), refund shipping lines (5) | 595 | 405 |

Throttling (HTTP 429 or `THROTTLED`) is retried with backoff. The estimate is conservative because Shopify doesn't publish its exact connection formula; the sync records the real `requestedQueryCost` so the first live run confirms it.

### Never truncated

An order is held back whole, and reported as an error in the run, when:

- it has more than 50 line items;
- it has 10 or more refunds (refunds come as a plain list, so a full list may have been cut off);
- a refund has more than 50 lines or more than 5 shipping lines;
- it has more than 10 discount applications;
- a line has 5 or more tax lines;
- any required financial field is missing or malformed.

## Not in this layer

This layer has no attribution, commissions, payouts, referral links, storefront changes, polling or backfill. Snapshots exist only for orders the sync has seen since this shipped.
