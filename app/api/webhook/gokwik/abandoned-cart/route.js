import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { normalizePayload } from '@/lib/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Constant-time-ish compare so the secret isn't leaked by response timing. */
function secretMatches(candidate, expected) {
  if (!candidate || !expected || candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(request) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    console.error('WEBHOOK_SECRET is not set; rejecting webhook');
    return NextResponse.json({ ok: false, error: 'server_not_configured' }, { status: 500 });
  }

  const provided =
    request.headers.get('x-webhook-secret') ||
    new URL(request.url).searchParams.get('secret');

  if (!secretMatches(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Parse defensively: a malformed body should still not produce a retry storm.
  let payload;
  try {
    payload = await request.json();
  } catch {
    const text = await request.text().catch(() => '');
    payload = { _unparsed_body: text };
  }

  const n = normalizePayload(payload);

  try {
    await ensureSchema();
    const { rows } = await sql`
      INSERT INTO abandoned_carts
        (cart_id, customer_name, phone, email, total_price, currency,
         checkout_url, item_count, abandoned_at, raw_payload)
      VALUES
        (${n.cartId}, ${n.customerName}, ${n.phone}, ${n.email}, ${n.totalPrice},
         ${n.currency}, ${n.checkoutUrl}, ${n.itemCount}, ${n.abandonedAt},
         ${JSON.stringify(payload)})
      RETURNING id
    `;
    return NextResponse.json({ ok: true, id: rows[0].id }, { status: 200 });
  } catch (err) {
    // Log loudly, but still 200: GoKwik retries on non-2xx and we'd rather
    // investigate from logs than absorb a retry loop. The payload is in the log.
    console.error('Failed to store abandoned cart', err, JSON.stringify(payload));
    return NextResponse.json({ ok: true, stored: false }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: true, message: 'GoKwik abandoned-cart webhook receiver. POST here.' },
    { status: 200 },
  );
}
