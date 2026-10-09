import express from 'express';
import {
  ensureOrdersSchema, listChannels, listCouriers, saveCourier, listDestinations, saveDestination,
  DISPATCH_TYPES, DISPATCH_TYPE_LABELS, listOrders, getOrder,
  shipmentMembers, sharedShipmentOf, attachableOrders, attachToShipment, detachFromShipment,
  orderDocuments, getDocument, orderEvents, createOrder, manualLineSkuOptions, addManualOrderLine, updateManualOrderLine, removeManualOrderLine, matchManualOrderLine, createShipment, updateOrder, updateShipment, orderShipments,
  addOrderNote, addDocument, removeDocument, orderItems, createShipmentForOrders, ORDER_STATUSES, SHIPMENT_STATUSES, PAYMENT_STATUSES,
  PAYMENT_METHODS, FULFILLMENT_TYPES, DOCUMENT_TYPES, DOCUMENT_FORMATS, LOGISTICS_VIEWS, teamTimezone,
} from './orders.js';
import {
  storage, validateDocument, newStorageKey, MAX_DOCUMENT_BYTES, StorageNotConfigured, DEFAULT_FORMATS,
} from './storage.js';
import { isMockMode } from './db.js';
import { previewAmazonImport, commitAmazonImport, recentImports } from './amazon-import.js';
import { runShopifySync, shopifyOrdersStatus, shopifySyncHistory, startFullHistorySync, fullHistoryStatus, assertNoSyncRunning, startIncrementalSync, shopifySyncStatus, cancelShopifySync } from './shopify-orders.js';
import { startAmazonIncrementalSync, amazonSyncStatus } from './amazon-orders.js';
import { ensureInventorySchema, unmappedSkus, listPlatforms } from './inventory.js';
import { currentUserName } from './auth-routes.js';
import { can } from './permissions.js';

/**
 * /api/orders — mounted behind requireAuth + requireOrders, so every handler
 * here already knows the caller is an admin or logistics staff.
 */
export const router = express.Router();
// Reading orders needs logistics.view (checked where this router is mounted);
// every change — orders, shipments, documents, notes, Amazon import — needs
// logistics.edit. A Logistics viewer can look but not change anything.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || can(req.session?.caps || [], 'logistics.edit')) return next();
  return res.status(403).json({ ok: false, error: 'You can view orders but not change them. Ask an admin for Logistics operator access.' });
});

const tz = teamTimezone;

// Orders need Postgres; there is no in-memory stand-in for them. Order lines
// point at the SKU master, so the inventory tables come up with them.
router.use(async (req, res, next) => {
  if (isMockMode()) return res.status(503).json({ ok: false, error: 'Orders need a database (DATABASE_URL).' });
  try { await ensureInventorySchema(); return next(); } catch (err) { return next(err); }
});

const send = (res, err) => {
  if (err instanceof StorageNotConfigured) return res.status(503).json({ ok: false, error: err.message });
  if (err.status && err.status < 500) {
    return res.status(err.status).json({
      ok: false, error: err.message, existingId: err.existingId, conflict: err.conflict,
      orderExists: err.orderExists, canFillShipment: err.canFillShipment, shipments: err.shipments,
      duplicateAwb: err.duplicateAwb, needsPhoto: err.needsPhoto, alreadyShipped: err.alreadyShipped,
      needsStock: err.needsStock, unmappedSkus: err.unmappedSkus, stockDispatched: err.stockDispatched,
      insufficientStock: err.insufficientStock, unsellable: err.unsellable, noInventoryLines: err.noInventoryLines,
    });
  }
  console.error(err);
  return res.status(500).json({ ok: false, error: 'Something went wrong. Nothing was saved.' });
};
const idOf = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

router.get('/meta', async (req, res) => {
  try {
    let store = null;
    let storageError = null;
    try { store = storage(); } catch (err) { storageError = err.message; }
    // Independent lookups: one database round trip for all of them, not five in a row.
    const [channels, destinations, couriers, unmapped, counts] = await Promise.all([
      listChannels(), listDestinations({ includeInactive: true }), listCouriers({ includeInactive: true }),
      unmappedSkus(), listOrders({}, { tz: tz(), limit: 1 }),
    ]);
    res.json({
      ok: true,
      channels,
      dispatchTypes: DISPATCH_TYPES.map((key) => ({ key, label: DISPATCH_TYPE_LABELS[key], needsDestination: key !== 'easy_ship' })),
      destinations,
      couriers,
      orderStatuses: ORDER_STATUSES,
      shipmentStatuses: SHIPMENT_STATUSES,
      paymentStatuses: PAYMENT_STATUSES,
      paymentMethods: PAYMENT_METHODS,
      fulfillmentTypes: FULFILLMENT_TYPES,
      documentTypes: DOCUMENT_TYPES,
      inventory: { unmappedSkus: unmapped.length },
      documentFormats: Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, DOCUMENT_FORMATS[t] || DEFAULT_FORMATS])),
      views: Object.fromEntries(Object.entries(LOGISTICS_VIEWS).map(([k, v]) => [k, v.label])),
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
      storage: store ? { driver: store.name, durable: store.durable } : { driver: null, durable: false, error: storageError },
      timezone: tz(),
      isAdmin: Boolean(req.session?.isAdmin),
      viewCounts: counts.viewCounts,
    });
  } catch (err) { send(res, err); }
});

router.get('/', async (req, res) => {
  try {
    const f = req.query;
    res.json({ ok: true, ...(await listOrders(f, { tz: tz(), limit: f.limit, offset: f.offset })) });
  } catch (err) { send(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const id = await createOrder(req.body ?? {}, { actor: await currentUserName(req) });
    res.status(201).json({ ok: true, order: await getOrder(id) });
  } catch (err) { send(res, err); }
});

// New Shipment: creates the order and its shipment in one step, or — when the
// order already exists and the person confirms — adds a shipment to it.
router.post('/shipments', async (req, res) => {
  try {
    const { addToExisting, ...fields } = req.body ?? {};
    const r = await createShipment(fields, { actor: await currentUserName(req), addToExisting: addToExisting === true });
    res.status(201).json({ ok: true, ...r, order: await getOrder(r.orderId) });
  } catch (err) { send(res, err); }
});

// One shipment for several orders that have none yet (chosen in the list).
router.post('/shipments/from-orders', async (req, res) => {
  try {
    const { order_ids: orderIds, ...fields } = req.body ?? {};
    const r = await createShipmentForOrders(orderIds, fields, { actor: await currentUserName(req) });
    res.status(201).json({ ok: true, ...r });
  } catch (err) { send(res, err); }
});

// Shared shipments: which orders could join, add some, take one out.
router.get('/shipments/:shipmentId/attachable', async (req, res) => {
  try { res.json({ ok: true, orders: await attachableOrders(idOf(req.params.shipmentId), { q: req.query.q }) }); }
  catch (err) { send(res, err); }
});
router.post('/shipments/:shipmentId/orders', async (req, res) => {
  try {
    const sid = idOf(req.params.shipmentId);
    if (!sid) return res.status(404).json({ ok: false, error: 'No such shipment.' });
    const { order_ids: orderIds = [], new_orders: newOrders = [] } = req.body ?? {};
    const r = await attachToShipment(sid, { orderIds, newOrders }, { actor: await currentUserName(req) });
    res.status(201).json({ ok: true, ...r, members: await shipmentMembers(sid) });
  } catch (err) { send(res, err); }
});
router.delete('/shipments/:shipmentId/orders/:orderId', async (req, res) => {
  try {
    await detachFromShipment(idOf(req.params.shipmentId), idOf(req.params.orderId), { actor: await currentUserName(req) });
    res.json({ ok: true });
  } catch (err) { send(res, err); }
});

// Amazon order report import: preview first (writes nothing), then import.
// The raw file is the body and its name travels in x-filename, as with uploads.
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
const importBody = express.raw({ type: () => true, limit: MAX_IMPORT_BYTES });
const importFile = (req) => ({
  buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
  filename: decodeURIComponent(String(req.get('x-filename') || '')).replace(/[\\/]/g, '_').trim().slice(0, 200),
});
router.get('/import/history', async (req, res) => {
  try { res.json({ ok: true, imports: await recentImports() }); } catch (err) { send(res, err); }
});
router.post('/import/amazon/preview', importBody, async (req, res) => {
  try {
    const { buffer, filename } = importFile(req);
    res.json({ ok: true, ...(await previewAmazonImport(buffer, filename)) });
  } catch (err) { send(res, err); }
});
router.post('/import/amazon/commit', importBody, async (req, res) => {
  try {
    const { buffer, filename } = importFile(req);
    res.json({ ok: true, ...(await commitAmazonImport(buffer, filename, { actor: await currentUserName(req) })) });
  } catch (err) { send(res, err); }
});

// Shopify orders: admin only. Preview reads Shopify and the database and writes
// nothing; sync applies. The browser never talks to Shopify, and no response
// carries a token or secret.
const shopifyAdmin = (req, res, next) => (req.session?.isAdmin ? next()
  : res.status(403).json({ ok: false, error: 'Only an admin can connect or sync Shopify.' }));
const syncWindow = (b = {}) => ({ mode: b.mode === 'incremental' ? 'incremental' : 'window', days: b.days, from: b.from, to: b.to });
router.get('/shopify/status', shopifyAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await shopifyOrdersStatus()), history: await shopifySyncHistory() }); } catch (err) { send(res, err); }
});
router.post('/shopify/preview', shopifyAdmin, express.json(), async (req, res) => {
  try { res.json({ ok: true, ...(await runShopifySync({ window: syncWindow(req.body), dryRun: true })) }); } catch (err) { sendShopify(res, err); }
});
// The Orders page Shopify button: orders changed since the last completed sync, in the background; the page polls.
router.post('/shopify/sync-updates', shopifyAdmin, async (req, res) => {
  try {
    const r = await startIncrementalSync({ actor: await currentUserName(req) });
    res.status(202).json({ ok: true, started: r.started, mode: r.mode });
  } catch (err) { sendShopify(res, err); }
});
router.get('/shopify/sync-updates', shopifyAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await shopifySyncStatus()) }); } catch (err) { send(res, err); }
});
// Stop the running Shopify sync (button chain only; Amazon is separate). Cooperative: see cancelShopifySync.
router.post('/shopify/sync/cancel', shopifyAdmin, async (req, res) => {
  try {
    const r = cancelShopifySync({ actor: await currentUserName(req) });
    res.status(202).json({ ok: true, ...r, status: await shopifySyncStatus() });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ ok: false, error: err.message, syncRunning: false });
    send(res, err);
  }
});
// Admin/recovery only — not on any button: the whole order history (needs read_all_orders).
router.post('/shopify/sync-all', shopifyAdmin, async (req, res) => {
  try {
    const r = await startFullHistorySync({ actor: await currentUserName(req) });
    res.status(202).json({ ok: true, started: r.started, resumedFrom: r.resumedFrom });
  } catch (err) { sendShopify(res, err); }
});
router.get('/shopify/sync-all', shopifyAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await fullHistoryStatus()) }); } catch (err) { send(res, err); }
});
router.post('/shopify/sync', shopifyAdmin, express.json(), async (req, res) => {
  try {
    await assertNoSyncRunning();
    const resumeRunId = /^\d+$/.test(String(req.body?.resumeRunId || '')) ? Number(req.body.resumeRunId) : null;
    res.json({ ok: true, ...(await runShopifySync({ window: syncWindow(req.body), dryRun: false, resumeRunId, actor: await currentUserName(req) })) });
  } catch (err) { sendShopify(res, err); }
});
// Amazon orders (SP-API): admin only, one button. The browser never chooses the window: the stored checkpoint (or a
// window being continued) does. The only input is `initial_since`, and only for the very first sync, before any
// checkpoint exists; afterwards it is ignored. No response carries a credential or token.
const amazonAdmin = (req, res, next) => (req.session?.isAdmin ? next()
  : res.status(403).json({ ok: false, error: 'Only an admin can sync Amazon orders.' }));
router.post('/amazon/sync', amazonAdmin, express.json(), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(body).filter((k) => k !== 'initial_since');
    if (extra.length) return res.status(400).json({ ok: false, error: `Only initial_since can be sent (for the first Amazon sync); not ${extra.slice(0, 5).join(', ')}.` });
    const r = await startAmazonIncrementalSync({ actor: await currentUserName(req), startFrom: body.initial_since ?? null });
    r.done.catch(() => {});                                     // the runner logs a failed chain; the page reads it from status
    res.status(202).json({ ok: true, started: r.started, mode: r.mode, resumedFrom: r.resumedFrom, status: await amazonSyncStatus() });
  } catch (err) { sendAmazon(res, err); }
});
router.get('/amazon/sync/status', amazonAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await amazonSyncStatus()) }); } catch (err) { send(res, err); }
});
function sendAmazon(res, err) {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ ok: false, error: err.message, syncRunning: err.syncRunning || undefined, needsInitialSince: err.needsInitialSince || undefined });
  }
  console.error('Amazon orders sync could not start:', String(err.message).slice(0, 300));   // messages are scrubbed in lib/amazon-spapi.js
  return res.status(502).json({ ok: false, error: 'Amazon sync could not start. Try again in a minute.' });
}

// Shopify transport errors are 502s for the browser; their text never includes the token (lib/shopify.js).
function sendShopify(res, err) {
  if (err.status) return send(res, err);
  console.error('Shopify orders sync failed:', String(err.message).slice(0, 300));
  return res.status(502).json({ ok: false, error: `Shopify: ${String(err.message).slice(0, 300)}` });
}

// ---- products on a hand-entered order (master SKU + quantity); see lib/orders.js
router.get('/line-skus', async (_req, res) => {
  try { res.json({ ok: true, skus: await manualLineSkuOptions() }); } catch (err) { send(res, err); }
});
router.post('/:id/items', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'No such order.' });
    const r = await addManualOrderLine(id, req.body ?? {}, { actor: await currentUserName(req) });
    res.status(201).json({ ok: true, ...r, items: await orderItems(id) });
  } catch (err) { send(res, err); }
});
router.patch('/:id/items/:itemId', async (req, res) => {
  try {
    const id = idOf(req.params.id); const itemId = idOf(req.params.itemId);
    if (!id || !itemId) return res.status(404).json({ ok: false, error: 'No such product line.' });
    const r = await updateManualOrderLine(id, itemId, req.body ?? {}, { actor: await currentUserName(req) });
    res.json({ ok: true, ...r, items: await orderItems(id) });
  } catch (err) { send(res, err); }
});
// A retailer line added as "not matched yet": a person picks the Briyo product. Nothing else ever matches it.
router.post('/:id/items/:itemId/match', async (req, res) => {
  try {
    const id = idOf(req.params.id); const itemId = idOf(req.params.itemId);
    if (!id || !itemId) return res.status(404).json({ ok: false, error: 'No such product line.' });
    const r = await matchManualOrderLine(id, itemId, req.body ?? {}, { actor: await currentUserName(req) });
    res.json({ ok: true, ...r, items: await orderItems(id) });
  } catch (err) { send(res, err); }
});
router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    const id = idOf(req.params.id); const itemId = idOf(req.params.itemId);
    if (!id || !itemId) return res.status(404).json({ ok: false, error: 'No such product line.' });
    const r = await removeManualOrderLine(id, itemId, { actor: await currentUserName(req) });
    res.json({ ok: true, ...r, items: await orderItems(id) });
  } catch (err) { send(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    const order = id && await getOrder(id);
    if (!order) return res.status(404).json({ ok: false, error: 'No such order.' });
    const [own, documents, events, shared, items] = await Promise.all([
      orderShipments(id), orderDocuments(id), orderEvents(id), sharedShipmentOf(id), orderItems(id)]);
    // An order inside a shared shipment shows that shipment (not its own blank
    // one); the shipment's photos and papers live on the shipment's lead order.
    const shipments = shared ? [shared] : own;
    const members = {};
    for (const sh of shipments) {
      const list = await shipmentMembers(sh.id);
      if (list.length > 1) members[sh.id] = list;
    }
    const shipmentDocuments = shared ? await orderDocuments(shared.order_id) : null;
    res.json({ ok: true, order, items, shipments, documents, events, members, sharedWith: shared ? shared.order_id : null, shipmentDocuments });
  } catch (err) { send(res, err); }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'No such order.' });
    const { version, ...fields } = req.body ?? {};
    const result = await updateOrder(id, fields, { actor: await currentUserName(req), version });
    res.json({ ok: true, changed: result.changed, order: await getOrder(id) });
  } catch (err) { send(res, err); }
});

router.patch('/:id/shipments/:shipmentId', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    const shipmentId = idOf(req.params.shipmentId);
    if (!id || !shipmentId) return res.status(404).json({ ok: false, error: 'No such shipment.' });
    const { version, ...fields } = req.body ?? {};
    const result = await updateShipment(id, shipmentId, fields, { actor: await currentUserName(req), version });
    res.json({ ok: true, changed: result.changed, order: await getOrder(id) });
  } catch (err) { send(res, err); }
});

router.post('/:id/notes', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'No such order.' });
    await addOrderNote(id, req.body?.note, { actor: await currentUserName(req) });
    res.status(201).json({ ok: true });
  } catch (err) { send(res, err); }
});

/**
 * Stores an uploaded file, then records it. If the database write fails the
 * object is deleted again, so storage never holds a file no order points at.
 * Validation happens before anything is written.
 */
export async function saveUploadedDocument({ orderId, filename, buffer, documentType, actor, store = storage() }) {
  if (!DOCUMENT_TYPES.includes(documentType)) {
    throw Object.assign(new Error('Choose what kind of document this is.'), { status: 400 });
  }
  const check = validateDocument(filename, buffer, DOCUMENT_FORMATS[documentType] || DEFAULT_FORMATS);
  if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
  const key = newStorageKey(orderId, check.ext);
  await store.put(key, buffer, check.mime);
  try {
    return await addDocument(orderId, {
      document_type: documentType, original_filename: filename, storage_path: key,
      mime_type: check.mime, file_size: buffer.length,
    }, { actor });
  } catch (err) {
    await store.remove(key).catch((e) => console.error(`Orphaned document object ${key}:`, e.message));
    throw err;
  }
}

// Upload: the raw file is the body; its name travels in a header and its kind
// in the query. No multipart parser needed, and nothing binary touches Postgres.
router.post('/:id/documents',
  express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 }),
  async (req, res) => {
    try {
      const id = idOf(req.params.id);
      if (!id || !(await getOrder(id))) return res.status(404).json({ ok: false, error: 'No such order.' });
      const documentId = await saveUploadedDocument({
        orderId: id,
        filename: decodeURIComponent(String(req.get('x-filename') || '')).replace(/[\\/]/g, '_').trim(),
        buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        documentType: String(req.query.type || ''),
        actor: await currentUserName(req),
      });
      res.status(201).json({ ok: true, documentId });
    } catch (err) { send(res, err); }
  });

router.get('/:id/documents/:docId', async (req, res) => {
  try {
    const doc = await getDocument(idOf(req.params.id), idOf(req.params.docId));
    if (!doc) return res.status(404).json({ ok: false, error: 'No such document.' });
    let bytes;
    try { bytes = await storage().get(doc.storage_path); } catch (err) {
      if (err instanceof StorageNotConfigured) throw err;
      console.error(`Document ${doc.id} unreadable:`, err.message);
      return res.status(err.status === 404 || err.code === 'ENOENT' ? 410 : 502).json({
        ok: false, error: 'The file could not be read from storage.',
      });
    }
    res.set('Content-Type', doc.mime_type);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`);
    res.send(bytes);
  } catch (err) { send(res, err); }
});

router.delete('/:id/documents/:docId', async (req, res) => {
  try {
    await removeDocument(idOf(req.params.id), idOf(req.params.docId), { actor: await currentUserName(req) });
    res.json({ ok: true });
  } catch (err) { send(res, err); }
});

// Upload limit exceeded is reported in words, not as an Express stack.
router.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: `Files must be ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB or smaller.` });
  }
  return next(err);
});

/** Courier partners: everyone with orders access reads, admins edit. */
export const courierRouter = express.Router();
courierRouter.use(async (req, res, next) => {
  if (isMockMode()) return res.status(503).json({ ok: false, error: 'Orders need a database (DATABASE_URL).' });
  try { await ensureOrdersSchema(); return next(); } catch (err) { return next(err); }
});
courierRouter.get('/', async (_req, res) => {
  try { res.json({ ok: true, couriers: await listCouriers({ includeInactive: true }) }); } catch (err) { send(res, err); }
});
const adminOnly = (req, res, next) => (can(req.session?.caps || [], 'logistics.setup') ? next()
  : res.status(403).json({ ok: false, error: 'Only a Logistics manager or an admin can change courier partners.' }));
courierRouter.post('/', adminOnly, async (req, res) => {
  try { res.status(201).json({ ok: true, courier: await saveCourier(req.body ?? {}, { actor: await currentUserName(req) }) }); } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, error: 'A courier with that name already exists.' });
    send(res, err);
  }
});
courierRouter.patch('/:id', adminOnly, async (req, res) => {
  try {
    const courier = await saveCourier({ ...req.body, id: idOf(req.params.id) }, { actor: await currentUserName(req) });
    if (!courier) return res.status(404).json({ ok: false, error: 'No such courier.' });
    res.json({ ok: true, courier });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, error: 'A courier with that name already exists.' });
    send(res, err);
  }
});

/** Dispatch destinations: everyone with orders access reads, admins edit. */
export const destinationRouter = express.Router();
destinationRouter.use(async (req, res, next) => {
  if (isMockMode()) return res.status(503).json({ ok: false, error: 'Orders need a database (DATABASE_URL).' });
  // The inventory schema too: a retailer destination links to an SKU platform (its product-code list).
  try { await ensureOrdersSchema(); await ensureInventorySchema(); return next(); } catch (err) { return next(err); }
});
destinationRouter.get('/', async (_req, res) => {
  try {
    res.json({
      ok: true, destinations: await listDestinations({ includeInactive: true }), channels: await listChannels(),
      dispatchTypes: DISPATCH_TYPES.map((key) => ({ key, label: DISPATCH_TYPE_LABELS[key] })),
      // Lists a retailer may use: not a sales channel's own (the server refuses those too).
      platforms: await (async () => { const ch = new Set((await listChannels()).map((c) => c.key));
        return (await listPlatforms({ includeInactive: false })).filter((x) => !ch.has(x.key)).map((x) => ({ key: x.key, label: x.label })); })(),
    });
  } catch (err) { send(res, err); }
});
const adminDest = (req, res, next) => (can(req.session?.caps || [], 'logistics.setup') ? next()
  : res.status(403).json({ ok: false, error: 'Only a Logistics manager or an admin can change destinations.' }));
destinationRouter.post('/', adminDest, async (req, res) => {
  try { res.status(201).json({ ok: true, destination: await saveDestination(req.body ?? {}) }); } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, error: 'That destination already exists.' });
    send(res, err);
  }
});
destinationRouter.patch('/:id', adminDest, async (req, res) => {
  try {
    const d = await saveDestination({ ...req.body, id: idOf(req.params.id), channel: undefined, dispatch_type: undefined });
    if (!d) return res.status(404).json({ ok: false, error: 'No such destination.' });
    res.json({ ok: true, destination: d });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, error: 'That destination already exists.' });
    send(res, err);
  }
});
