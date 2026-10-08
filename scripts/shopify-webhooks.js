#!/usr/bin/env node
/**
 * Lists or registers the Shopify orders/create webhook for Briyo OS (lib/shopify-webhooks.js).
 *
 *   node scripts/shopify-webhooks.js list
 *   node scripts/shopify-webhooks.js register      # callback: ${APP_BASE_URL}/api/webhook/shopify/orders-create
 *
 * Uses the stored Shopify connection (read_orders is enough for orders/create). Deliveries are signed with the
 * app's client secret (SHOPIFY_CLIENT_SECRET), which the endpoint verifies. Registering twice is refused by
 * Shopify for the same callback, so it is safe to re-run. Prints no token or secret.
 */
import 'dotenv/config';
import { graphql } from '../lib/shopify.js';

const cmd = process.argv[2] || 'list';
const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const callbackUrl = `${base}/api/webhook/shopify/orders-create`;

const list = async () => {
  const r = await graphql(`query { webhookSubscriptions(first: 50) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  return r.webhookSubscriptions.nodes;
};

if (cmd === 'list') {
  for (const w of await list()) console.log(`${w.topic}  ${w.endpoint?.callbackUrl || w.endpoint?.__typename}  ${w.id}`);
} else if (cmd === 'register') {
  if (!/^https:\/\//.test(base)) { console.error('APP_BASE_URL must be the public https URL of Briyo OS.'); process.exit(1); }
  if ((await list()).some((w) => w.topic === 'ORDERS_CREATE' && w.endpoint?.callbackUrl === callbackUrl)) {
    console.log(`Already registered: ORDERS_CREATE → ${callbackUrl}`);
  } else {
    const r = await graphql(`mutation ($cb: URL!) { webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { callbackUrl: $cb, format: JSON }) {
      webhookSubscription { id } userErrors { field message } } }`, { cb: callbackUrl });
    const errs = r.webhookSubscriptionCreate.userErrors;
    if (errs.length) { console.error(errs.map((e) => e.message).join('; ')); process.exit(1); }
    console.log(`Registered ORDERS_CREATE → ${callbackUrl} (${r.webhookSubscriptionCreate.webhookSubscription.id})`);
  }
} else {
  console.error('Usage: node scripts/shopify-webhooks.js list|register');
  process.exit(1);
}
process.exit(0);
