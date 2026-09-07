import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.get('limit') ?? '50', 10) || 50));
  const offset = (page - 1) * limit;

  try {
    await ensureSchema();

    const { rows } = await sql`
      SELECT id, cart_id, customer_name, phone, email, total_price, currency,
             checkout_url, item_count, abandoned_at, created_at
      FROM abandoned_carts
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const { rows: stats } = await sql`
      SELECT
        COUNT(*)::int                                              AS total_count,
        COALESCE(SUM(total_price), 0)::float                       AS total_value,
        COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
        COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int   AS last_7d
      FROM abandoned_carts
    `;

    return NextResponse.json({
      ok: true,
      page,
      limit,
      totals: stats[0],
      carts: rows.map((r) => ({
        ...r,
        total_price: r.total_price === null ? null : Number(r.total_price),
      })),
    });
  } catch (err) {
    console.error('Failed to read abandoned carts', err);
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 500 });
  }
}
