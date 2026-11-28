/**
 * The printable purchase order (/purchase-orders/:id/print), laid out like Briyo's own PO: company name, address, GST
 * no., C.S.T. no. and drug licence nos. (Purchase orders → Company details), PO number and date; the manufacturer's name,
 * address and GST no.; one row per product — product name, GST %, packing style, MRP, product code, order qty, unit
 * price, per unit of, taxable amount, GST amount, total — with totals; then payment terms, delivery date, transport and
 * material booking station, and the authorised signature. Landscape A4; "Print / Save as PDF" makes the PDF.
 */
import { getPurchaseOrder, getPoCompany } from './purchase-orders.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const num = (n) => Number(n).toLocaleString('en-IN');
const amt = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const nl = (s) => esc(s).replace(/\n/g, '<br>');
/** "28-11-2026, 3:05 PM IST" */
const istStamp = (v) => `${new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\//g, '-').toUpperCase()} IST`;
const monthYear = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

export async function purchaseOrderPrintHtml(id) {
  const [po, co] = await Promise.all([getPurchaseOrder(id), getPoCompany()]);
  if (!po) return null;
  const t = po.totals;
  const row = (k, v) => `<tr><td class="k">${esc(k)}</td><td>${v || ''}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(po.po_number)} — Purchase order</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.4 -apple-system, "Segoe UI", Inter, Arial, sans-serif; color: #111; margin: 0; background: #f4f4f5; }
  .sheet { max-width: 297mm; margin: 16px auto; background: #fff; padding: 12mm; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .bar { max-width: 297mm; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .bar button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #d4d4d8; background: #fff; cursor: pointer; }
  .bar button.primary { background: #18181b; color: #fff; border-color: #18181b; }
  table { width: 100%; border-collapse: collapse; }
  .frame td, .frame th, .items td, .items th { border: 1px solid #333; padding: 5px 7px; vertical-align: top; }
  .title { text-align: center; font-weight: 700; font-size: 18px; letter-spacing: .08em; }
  .company { text-align: center; } .company .name { font-weight: 700; font-size: 16px; } .company .addr { font-size: 11px; }
  .logo { height: 36px; display: block; margin: 0 auto 4px; }
  td.k { width: 22%; font-weight: 600; } .mono { font-family: ui-monospace, Menlo, monospace; }
  .items th { background: #f4f4f5; font-size: 10.5px; text-transform: uppercase; text-align: center; }
  .items td.n { text-align: right; white-space: nowrap; } .items td.c { text-align: center; }
  .items tfoot td { font-weight: 700; background: #fafafa; }
  .foot td { border: 1px solid #333; padding: 5px 7px; }
  .thanks { text-align: center; font-weight: 600; padding: 28px 7px !important; } .sign { text-align: center; padding: 28px 7px !important; font-weight: 600; }
  .stamp { color: #b91c1c; font-weight: 700; letter-spacing: .1em; }
  @media print { body { background: #fff; } .bar { display: none; } .sheet { box-shadow: none; margin: 0; padding: 0; max-width: none; } }
</style></head>
<body>
<div class="bar"><button type="button" onclick="history.length > 1 ? history.back() : window.close()">Back</button><button class="primary" type="button" onclick="window.print()">Print / Save as PDF</button></div>
<div class="sheet">
  <table class="frame">
    <tr><td colspan="4" class="title">PURCHASE ORDER${po.status === 'cancelled' ? ' <span class="stamp">— CANCELLED</span>' : ''}</td></tr>
    <tr><td colspan="4" class="company"><img class="logo" src="/brand/briyo-logo.png" alt="Briyo Supplements"><div class="name">${esc(String(co.name).toUpperCase())}</div>${co.address ? `<div class="addr">${nl(co.address)}</div>` : ''}</td></tr>
    <tr><td class="k">Company GST no.</td><td class="mono">${esc(co.gstin || '')}</td><td class="k">Purchase order no.</td><td class="mono"><b>${esc(po.po_number)}</b></td></tr>
    <tr><td class="k">Company C.S.T. no.</td><td class="mono">${esc(co.cst_no || '')}</td><td class="k">Purchase date</td><td>${esc(day(po.po_date))}</td></tr>
    <tr><td class="k">D.L. no.</td><td class="mono">${nl(co.dl_numbers || '')}</td><td class="k">${co.phone || co.email ? 'Contact' : ''}</td><td>${esc([co.phone, co.email].filter(Boolean).join(' · '))}</td></tr>
    <tr><td colspan="4"><b>To,</b><br><b>${esc(String(po.supplier_name).toUpperCase())}</b>${po.manufacturer_unit ? `<br>${nl(po.manufacturer_unit)}` : ''}${po.supplier_address ? `<br>${nl(po.supplier_address)}` : ''}${po.supplier_gstin ? `<br>GST NO: <span class="mono">${esc(po.supplier_gstin)}</span>` : ''}</td></tr>
  </table>
  <table class="items" style="margin-top:-1px">
    <thead><tr><th>Sr. no.</th><th style="width:28%">Product name</th><th>GST (%)</th><th>Packing style</th><th>MRP</th><th>Product code</th><th>Order qty</th><th>Unit price</th><th>Per unit of</th><th>Taxable amt</th><th>GST amt</th><th>Total amt</th></tr></thead>
    <tbody>${po.lines.map((l, i) => {
      const style = `${num(l.pack_size)} ${esc(l.unit_label)}`;
      return `<tr><td class="c">${i + 1}</td><td><b>${esc(l.product_name)}${l.variant_name ? ` ${esc(l.variant_name)}` : ''}</b>${l.remarks ? ` <span>(${esc(l.remarks)})</span>` : ''}<div style="font-size:10.5px;color:#52525b">${esc(l.pack_type)}</div></td>
        <td class="c">${l.gst_pct === null ? '' : esc(String(l.gst_pct))}</td><td class="c">${style}</td><td class="n">${l.mrp === null ? '' : num(l.mrp)}</td><td class="c mono">${esc(l.sku)}</td>
        <td class="n">${num(l.ordered_qty)}</td><td class="n">${l.unit_price === null ? '' : amt(l.unit_price)}</td><td class="c">${style}</td>
        <td class="n">${amt(l.taxable)}</td><td class="n">${amt(l.gst_amount)}</td><td class="n">${amt(l.total)}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td></td><td style="text-align:center">Total</td><td colspan="4"></td><td class="n">${num(po.lines.reduce((n, l) => n + l.ordered_qty, 0))}</td><td colspan="2"></td>
      <td class="n">${t.priced ? amt(t.taxable) : ''}</td><td class="n">${t.priced ? amt(t.gst) : ''}</td><td class="n">${t.priced ? amt(t.total) : ''}</td></tr></tfoot>
  </table>
  <table class="foot" style="margin-top:-1px">
    ${row('1  Payment terms', esc(po.payment_terms || ''))}
    ${row('2  Delivery on date', esc(monthYear(po.expected_date)))}
    ${row('3  Transport', esc(po.transport || ''))}
    ${row('4  Material booking station', esc(po.booking_station || ''))}
    ${po.remarks ? row('5  Remarks', nl(po.remarks)) : ''}
    ${co.terms ? `<tr><td colspan="2" style="font-size:11px">${nl(co.terms)}</td></tr>` : ''}
    <tr><td class="thanks">THANKING YOU</td><td class="sign">(AUTHORISED SIGNATURE)</td></tr>
  </table>
  <p style="font-size:10.5px;color:#52525b;margin-top:10px">Please mention PO no. ${esc(po.po_number)}, the batch number, manufacturing and expiry dates and MRP on the invoice and every carton, and send the COA with each batch.</p>
  <p style="font-size:10px;color:#71717a;margin-top:14px;border-top:1px solid #e4e4e7;padding-top:6px;display:flex;justify-content:space-between;gap:12px">
    <span>Generated on <b>Briyo OS</b> · PO ${esc(po.po_number)} raised by ${esc(po.created_by)} on ${esc(istStamp(po.created_at))}</span><span>Printed ${esc(istStamp(new Date()))}</span></p>
</div>
</body></html>`;
}
