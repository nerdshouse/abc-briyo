import express from 'express';
import {
  ensureOrdersSchema, listChannels, listCouriers, saveCourier, listOrders, getOrder,
  orderDocuments, getDocument, orderEvents, createOrder, createShipment, updateOrder, updateShipment, orderShipments,
  addOrderNote, addDocument, removeDocument, ORDER_STATUSES, SHIPMENT_STATUSES, PAYMENT_STATUSES,
  PAYMENT_METHODS, FULFILLMENT_TYPES, DOCUMENT_TYPES, DOCUMENT_FORMATS, LOGISTICS_VIEWS, teamTimezone,
} from './orders.js';
import {
  storage, validateDocument, newStorageKey, MAX_DOCUMENT_BYTES, StorageNotConfigured, DEFAULT_FORMATS,
} from './storage.js';
import { isMockMode } from './db.js';
import { currentUserName } from './auth-routes.js';

/**
 * /api/orders — mounted behind requireAuth + requireOrders, so every handler
 * here already knows the caller is an admin or logistics staff.
 */
export const router = express.Router();

const tz = teamTimezone;

// Orders need Postgres; there is no in-memory stand-in for them.
router.use(async (req, res, next) => {
  if (isMockMode()) return res.status(503).json({ ok: false, error: 'Orders need a database (DATABASE_URL).' });
  try { await ensureOrdersSchema(); return next(); } catch (err) { return next(err); }
});

const send = (res, err) => {
  if (err instanceof StorageNotConfigured) return res.status(503).json({ ok: false, error: err.message });
  if (err.status && err.status < 500) {
    return res.status(err.status).json({
      ok: false, error: err.message, existingId: err.existingId, conflict: err.conflict,
      orderExists: err.orderExists, canFillShipment: err.canFillShipment, shipments: err.shipments,
      duplicateAwb: err.duplicateAwb,
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
    res.json({
      ok: true,
      channels: await listChannels(),
      couriers: await listCouriers({ includeInactive: true }),
      orderStatuses: ORDER_STATUSES,
      shipmentStatuses: SHIPMENT_STATUSES,
      paymentStatuses: PAYMENT_STATUSES,
      paymentMethods: PAYMENT_METHODS,
      fulfillmentTypes: FULFILLMENT_TYPES,
      documentTypes: DOCUMENT_TYPES,
      documentFormats: Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, DOCUMENT_FORMATS[t] || DEFAULT_FORMATS])),
      views: Object.fromEntries(Object.entries(LOGISTICS_VIEWS).map(([k, v]) => [k, v.label])),
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
      storage: store ? { driver: store.name, durable: store.durable } : { driver: null, durable: false, error: storageError },
      timezone: tz(),
      isAdmin: Boolean(req.session?.isAdmin),
      viewCounts: (await listOrders({}, { tz: tz(), limit: 1 })).viewCounts,
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

router.get('/:id', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    const order = id && await getOrder(id);
    if (!order) return res.status(404).json({ ok: false, error: 'No such order.' });
    const [shipments, documents, events] = await Promise.all([orderShipments(id), orderDocuments(id), orderEvents(id)]);
    res.json({ ok: true, order, shipments, documents, events });
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
const adminOnly = (req, res, next) => (req.session?.isAdmin ? next()
  : res.status(403).json({ ok: false, error: 'Only admins can change courier partners.' }));
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
