/**
 * Key shape of a REAL GoKwik abandoned-cart payload, with synthetic values.
 * Captured from production on 2026-09-09. Values are fake; the KEY NAMES are
 * what matters — this fixture exists because rto_risk_flag and mkt_source were
 * mapped wrong for a day and no test caught it.
 */
export const GOKWIK_REAL_PAYLOAD = {
  "request_id": "FIXTURE-1",
  "abc_url": "https://www.briyosupplements.com?mrid=fixture",
  "checkout_url": "https://www.briyosupplements.com/checkout/fixture",
  "created_at": "2026-09-09T07:23:34Z",
  "drop_stage": "Payment Page",
  "drop_off_reasons": null,
  "rto_risk_flag": "High Risk",
  "mkt_source": "facebook",
  "mkt_campaign": "120251248645910304",
  "mkt_medium": "paid",
  "orig_referrer": "http://m.facebook.com/",
  "currency": "INR",
  "total_price": "715.00",
  "items_subtotal_price": "499.00",
  "total_discount": "0.00",
  "cod_charges": 19,
  "taxes": "0.00",
  "convenience_fees": "0.00",
  "item_count": 2,
  "brand_order_count": 0,
  "items": [
    {
      "name": "Fixture Product",
      "price": "499.00",
      "quantity": 2,
      "product_id": "FIX-1"
    }
  ],
  "customer": {
    "firstname": "Fixture",
    "lastname": "Customer",
    "phone": "+919000000000",
    "email": "fixture@example.invalid"
  },
  "address": {
    "line1": "1 Fixture Road",
    "city": "Bengaluru",
    "state": "Karnataka",
    "pincode": "560001",
    "country": "India"
  },
  "shipping": {
    "price": "0.00",
    "method": "Standard"
  },
  "abc_email_sent": false,
  "message_enqueued": true,
  "email_enqueued": false,
  "notify_customer": true,
  "is_abandoned": true,
  "store_platform": "Shopify",
  "ip": "203.0.113.9",
  "user_agent": "Mozilla/5.0 (fixture)",
  "session_id": "sess-fixture",
  "gst_details_enc": "ENCRYPTED",
  "mapped_email_enc": "ENCRYPTED",
  "billing_address_details_pii": {
    "any": "thing"
  }
};
