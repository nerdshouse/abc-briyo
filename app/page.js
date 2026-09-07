'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const COLUMNS = [
  { key: 'customer_name', label: 'Customer' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'total_price', label: 'Cart value', numeric: true },
  { key: 'currency', label: 'Currency' },
  { key: 'item_count', label: 'Items', numeric: true },
  { key: 'checkout_url', label: 'Checkout' },
  { key: 'created_at', label: 'Received', numeric: true },
];

function money(value, currency) {
  if (value === null || value === undefined) return null;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency || ''} ${value}`.trim();
  }
}

function when(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/carts?page=${page}&limit=${limit}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, limit]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const carts = data?.carts ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? carts.filter((c) =>
          [c.customer_name, c.phone, c.email, c.cart_id]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(q)),
        )
      : carts;

    const { key, dir } = sort;
    return [...filtered].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;   // blanks always last
      if (bv === null || bv === undefined) return -1;
      let cmp;
      if (key === 'created_at' || key === 'abandoned_at') {
        cmp = new Date(av) - new Date(bv);
      } else if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv));
      }
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [data, query, sort]);

  const totals = data?.totals;

  function toggleSort(key) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' },
    );
  }

  return (
    <div className="wrap">
      <header className="page">
        <div>
          <h1>Briyo Supplements — Abandoned Carts</h1>
          <div className="sub">Events received from GoKwik. Contains customer PII — do not share this URL.</div>
        </div>
        <button onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </header>

      <div className="stats">
        <div className="stat">
          <div className="label">Total carts</div>
          <div className="value">{totals ? totals.total_count.toLocaleString('en-IN') : '—'}</div>
        </div>
        <div className="stat">
          <div className="label">Total abandoned value</div>
          <div className="value">{totals ? money(totals.total_value, 'INR') : '—'}</div>
        </div>
        <div className="stat">
          <div className="label">Last 24 hours</div>
          <div className="value">{totals ? totals.last_24h.toLocaleString('en-IN') : '—'}</div>
        </div>
        <div className="stat">
          <div className="label">Last 7 days</div>
          <div className="value">{totals ? totals.last_7d.toLocaleString('en-IN') : '—'}</div>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Filter by name, phone, email, cart ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
          {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
        </select>
      </div>

      {error && <p style={{ color: '#b42318' }}>Could not load carts: {error}</p>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sort.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  {loading ? 'Loading…' : 'No abandoned carts recorded yet.'}
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className={c.customer_name ? '' : 'empty'}>{c.customer_name || '—'}</td>
                <td className={c.phone ? '' : 'empty'}>{c.phone || '—'}</td>
                <td className={c.email ? '' : 'empty'}>{c.email || '—'}</td>
                <td className="num">{money(c.total_price, c.currency) || '—'}</td>
                <td>{c.currency || '—'}</td>
                <td className="num">{c.item_count ?? '—'}</td>
                <td>
                  {c.checkout_url
                    ? <a href={c.checkout_url} target="_blank" rel="noopener noreferrer">Open</a>
                    : <span className="empty">—</span>}
                </td>
                <td className="num">{when(c.created_at) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="footer-row">
        <span>
          Showing {rows.length} of {data?.carts?.length ?? 0} on page {page}
          {query ? ' (filtered)' : ''}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1 || loading}>
            ← Previous
          </button>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={loading || (data?.carts?.length ?? 0) < limit}
          >
            Next →
          </button>
        </span>
      </div>

      <p className="note">
        Blank columns usually mean GoKwik&apos;s payload uses field names the parser doesn&apos;t
        recognise yet. Every event is stored in full in the <code>raw_payload</code> column —
        inspect it and extend <code>lib/normalize.js</code> to fix the mapping. No data is lost.
      </p>
    </div>
  );
}
