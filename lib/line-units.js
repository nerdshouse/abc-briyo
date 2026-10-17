// No imports: lib/inventory.js imports lib/orders.js, so the SQL both use lives here (orders.js builds its list query
// from it at load time, which an import from inventory.js could reach before that module had run).

/**
 * Master-SKU units per unit of an order line (alias oi, its order o, master s).
 * A line a person matched by hand (it had no product code) takes the units they
 * gave; a line resolved by the master's own code is 1; a line resolved through a
 * platform mapping takes that mapping's units_per_listing. The only place a
 * channel quantity becomes an inventory quantity is through this.
 */
export const LINE_UNITS_SQL = `coalesce(oi.matched_units_per_listing, CASE WHEN oi.sku_id IS NULL OR lower(oi.sku) = lower(s.sku) THEN 1
  ELSE coalesce((SELECT m.units_per_listing FROM sku_platform_mappings m
                 WHERE m.sku_id = oi.sku_id AND m.platform = o.channel AND lower(m.platform_sku) = lower(oi.sku)
                 LIMIT 1), 1) END)`;
