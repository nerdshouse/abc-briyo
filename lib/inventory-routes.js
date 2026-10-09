import express from 'express';
import { teamTimezone } from './orders.js';
import { can } from './permissions.js';
import {
  ensureInventorySchema, inventoryOverview, listSkus, skuDetail, createSku, updateSku, receiveInventory, adjustStock,
  transferStock, updateBatch, uploadBatchDocument, getBatchDocument, removeBatchDocument, listSuppliers, saveSupplier,
  listWarehouses, saveWarehouse, unmappedSkus, unmappedLinesWithoutCode, shipmentStock, reserveShipmentStock, releaseShipmentStock,
  getInventoryCutover, setInventoryCutover, listPlatforms, savePlatform, addPlatformMappings, removePlatformMapping, updateMappingUnits, mappingUsage,
  MOVEMENT_TYPES, MANUAL_MOVEMENTS, BATCH_STATUSES, EFFECTIVE_STATUSES, BATCH_DOCUMENT_TYPES, EXPIRY_WINDOWS,
} from './inventory.js';
import { storage, MAX_DOCUMENT_BYTES, StorageNotConfigured } from './storage.js';
import {
  createOutward, updateOutward, cancelOutward, issueOutward, recordOutwardReturn, closeOutward, listOutwards, getOutward,
  outwardReport, outwardStockOptions, outwardPeople,
} from './stock-outward.js';
import { OUTWARD_PURPOSES, OUTWARD_STATUSES } from './inventory.js';
import { previewSkuImport, commitSkuImport } from './sku-master-import.js';
import { isMockMode } from './db.js';
import { currentUserName } from './auth-routes.js';

/**
 * /api/inventory — mounted behind requireAuth + requireOrders: admins and
 * logistics staff read stock and work shipments; only admins change the SKU
 * master, receive or adjust stock, edit batches and upload batch papers.
 * Callers have no access at all.
 */
export const router = express.Router();

router.use(async (req, res, next) => {
  if (isMockMode()) return res.status(503).json({ ok: false, error: 'Inventory needs a database (DATABASE_URL).' });
  try { await ensureInventorySchema(); return next(); } catch (err) { return next(err); }
});

const send = (res, err) => {
  if (err instanceof StorageNotConfigured) return res.status(503).json({ ok: false, error: err.message });
  if (err.status && err.status < 500) {
    return res.status(err.status).json({
      ok: false, error: err.message, conflict: err.conflict, insufficientStock: err.insufficientStock,
      unsellable: err.unsellable, unmappedSkus: err.unmappedSkus, needsStock: err.needsStock,
      mappingConflict: err.mappingConflict, importErrors: err.importErrors,
      duplicateMapping: err.duplicateMapping, outstanding: err.outstanding, field: err.field, confirmRequired: err.confirmRequired, reasonRequired: err.reasonRequired, invalidPlatformSku: err.invalidPlatformSku,
    });
  }
  console.error(err);
  return res.status(500).json({ ok: false, error: 'Something went wrong. Nothing was saved.' });
};
const idOf = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
// Each inventory action needs its capability (lib/permissions.js). Reading
// needs inventory.view, except a shipment's stock panel, which Logistics uses.
const need = (cap, message) => (req, res, next) => (can(req.session?.caps || [], cap) ? next()
  : res.status(403).json({ ok: false, error: message }));
const viewInventory = need('inventory.view', 'You do not have access to Inventory. Ask an admin.');
const moveStock = need('inventory.move', 'Only an Inventory operator, an Inventory manager or an admin can receive, adjust or move stock.');
const catalog = need('inventory.catalog', 'Only an Inventory manager or an admin can change SKUs, suppliers and warehouses.');
const shipmentView = need(['inventory.view', 'logistics.view'], 'You do not have access to this shipment\'s stock.');
const shipmentStockEdit = need('logistics.edit', 'Only a Logistics operator, a Logistics manager or an admin can reserve or release stock for a shipment.');

router.get('/meta', viewInventory, async (req, res) => {
  try {
    let storageError = null;
    try { storage(); } catch (err) { storageError = err.message; }
    res.json({
      ok: true,
      isAdmin: Boolean(req.session?.isAdmin),
      movementTypes: Object.entries(MOVEMENT_TYPES).map(([key, v]) => ({ key, label: v.label, sign: v.sign })),
      manualMovements: MANUAL_MOVEMENTS,
      batchStatuses: BATCH_STATUSES,
      effectiveStatuses: EFFECTIVE_STATUSES,
      documentTypes: BATCH_DOCUMENT_TYPES,
      expiryWindows: EXPIRY_WINDOWS,
      warehouses: await listWarehouses(),
      platforms: await listPlatforms(),
      suppliers: await listSuppliers(),
      storage: { error: storageError },
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
      timezone: teamTimezone(),
    });
  } catch (err) { send(res, err); }
});

router.get('/', viewInventory, async (req, res) => {
  try {
    const f = {};
    for (const k of ['q', 'warehouse', 'location', 'status', 'expiring', 'stock']) if (req.query[k]) f[k] = String(req.query[k]);
    if (req.query.inactive === '1') f.showInactive = true;
    res.json({ ok: true, ...(await inventoryOverview(f)) });
  } catch (err) { send(res, err); }
});

// ---- SKUs
router.get('/skus', viewInventory, async (_req, res) => {
  try { res.json({ ok: true, skus: await listSkus() }); } catch (err) { send(res, err); }
});
router.get('/skus/:id', viewInventory, async (req, res) => {
  try {
    const d = await skuDetail(idOf(req.params.id));
    if (!d) return res.status(404).json({ ok: false, error: 'No such SKU.' });
    res.json({ ok: true, ...d, mappingUsage: await mappingUsage(d.sku.id) });
  } catch (err) { send(res, err); }
});
router.post('/skus', catalog, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await createSku(req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.patch('/skus/:id', catalog, async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    res.json({ ok: true, ...(await updateSku(idOf(req.params.id), fields, { actor: await currentUserName(req), version })) });
  } catch (err) { send(res, err); }
});
// ---- platforms and platform SKUs (marketplace identifiers that point at a master SKU)
// ---- stock cutover: orders before it never reserve or consume stock
router.get('/cutover', viewInventory, async (_req, res) => {
  try { res.json({ ok: true, ...(await getInventoryCutover()) }); } catch (err) { send(res, err); }
});
router.put('/cutover', catalog, async (req, res) => {
  try {
    const { cutover_at: value, confirm, version } = req.body ?? {};
    res.json({ ok: true, ...(await setInventoryCutover(value === undefined ? '' : value, { actor: await currentUserName(req), confirm: confirm === true, version })) });
  } catch (err) { send(res, err); }
});
router.get('/platforms', viewInventory, async (_req, res) => {
  try { res.json({ ok: true, platforms: await listPlatforms() }); } catch (err) { send(res, err); }
});
router.post('/platforms', catalog, async (req, res) => {
  try { res.status(201).json({ ok: true, platform: await savePlatform(req.body ?? {}, { actor: await currentUserName(req) }) }); } catch (err) { send(res, err); }
});
router.post('/skus/:id/platform-skus', catalog, async (req, res) => {
  try {
    const { platform, platform_skus: codes, confirm_duplicate: confirmDuplicate, duplicate_reason: reason, from_order: fromOrder, units_per_listing: unitsPerListing } = req.body ?? {};
    res.status(201).json({ ok: true, ...(await addPlatformMappings(idOf(req.params.id), platform, codes, {
      actor: await currentUserName(req), confirmDuplicate: confirmDuplicate === true, reason, fromOrder: fromOrder === true, unitsPerListing,
    })) });
  } catch (err) { send(res, err); }
});
router.patch('/platform-skus/:id', catalog, async (req, res) => {
  try { res.json({ ok: true, ...(await updateMappingUnits(idOf(req.params.id), (req.body ?? {}).units_per_listing, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.delete('/platform-skus/:id', catalog, async (req, res) => {
  try { res.json({ ok: true, ...(await removePlatformMapping(idOf(req.params.id), { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});

// ---- master SKU sheet import: preview (writes nothing), then all-or-nothing import
const sheetBody = express.raw({ type: () => true, limit: 5 * 1024 * 1024 });
const sheetFile = (req) => ({
  buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
  filename: decodeURIComponent(String(req.get('x-filename') || '')).replace(/[\\/]/g, '_').trim().slice(0, 200),
});
router.post('/import/skus/preview', catalog, sheetBody, async (req, res) => {
  try { const { buffer, filename } = sheetFile(req); res.json({ ok: true, ...(await previewSkuImport(buffer, filename)) }); } catch (err) { send(res, err); }
});
router.post('/import/skus/commit', catalog, sheetBody, async (req, res) => {
  try {
    const { buffer, filename } = sheetFile(req);
    res.json({ ok: true, ...(await commitSkuImport(buffer, filename, { actor: await currentUserName(req) })) });
  } catch (err) { send(res, err); }
});

router.get('/unmapped', viewInventory, async (_req, res) => {
  try { res.json({ ok: true, unmapped: await unmappedSkus(), unmappedNoCode: await unmappedLinesWithoutCode() }); } catch (err) { send(res, err); }
});

// ---- stock outward (lib/stock-outward.js): reading needs inventory.view; every change needs inventory.move.
// Who acted is always the signed-in user (never a field in the request).
router.get('/outward/meta', viewInventory, async (req, res) => {
  try {
    res.json({ ok: true, purposes: Object.entries(OUTWARD_PURPOSES).map(([key, label]) => ({ key, label })), statuses: OUTWARD_STATUSES,
      people: await outwardPeople(), skus: (await listSkus({ includeInactive: false })).filter((x) => x.track_inventory !== false)
        .map((x) => ({ id: x.id, sku: x.sku, product_name: x.product_name, variant_name: x.variant_name, available: x.available })) });
  } catch (err) { send(res, err); }
});
router.get('/outward/report', viewInventory, async (req, res) => {
  try { res.json({ ok: true, ...(await outwardReport(req.query)) }); } catch (err) { send(res, err); }
});
router.get('/outward/stock/:skuId', viewInventory, async (req, res) => {
  try { res.json({ ok: true, ...(await outwardStockOptions(idOf(req.params.skuId), Number(req.query.quantity) || 0)) }); } catch (err) { send(res, err); }
});
router.get('/outward', viewInventory, async (req, res) => {
  try { res.json({ ok: true, outwards: await listOutwards(req.query) }); } catch (err) { send(res, err); }
});
router.get('/outward/:id', viewInventory, async (req, res) => {
  try {
    const o = await getOutward(idOf(req.params.id));
    if (!o) return res.status(404).json({ ok: false, error: 'No such stock outward.' });
    return res.json({ ok: true, outward: o });
  } catch (err) { return send(res, err); }
});
router.post('/outward', moveStock, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await createOutward(req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.patch('/outward/:id', moveStock, async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    res.json({ ok: true, ...(await updateOutward(idOf(req.params.id), fields, { actor: await currentUserName(req), version })) });
  } catch (err) { send(res, err); }
});
router.post('/outward/:id/issue', moveStock, async (req, res) => {
  try { res.json({ ok: true, ...(await issueOutward(idOf(req.params.id), req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.post('/outward/:id/return', moveStock, async (req, res) => {
  try { res.json({ ok: true, ...(await recordOutwardReturn(idOf(req.params.id), req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.post('/outward/:id/close', moveStock, async (req, res) => {
  try { res.json({ ok: true, ...(await closeOutward(idOf(req.params.id), { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.post('/outward/:id/cancel', moveStock, async (req, res) => {
  try { res.json({ ok: true, ...(await cancelOutward(idOf(req.params.id), { actor: await currentUserName(req), reason: req.body?.reason })) }); } catch (err) { send(res, err); }
});

// ---- stock in, adjustments, transfers, batches
router.post('/receive', moveStock, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await receiveInventory(req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.post('/adjust', moveStock, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await adjustStock(req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.post('/transfer', moveStock, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await transferStock(req.body ?? {}, { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
router.patch('/batches/:id', moveStock, async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    res.json({ ok: true, ...(await updateBatch(idOf(req.params.id), fields, { actor: await currentUserName(req), version })) });
  } catch (err) { send(res, err); }
});

// ---- batch documents (COA etc.): raw body, name in x-filename, as order documents
router.post('/batches/:id/documents', moveStock,
  express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 }),
  async (req, res) => {
    try {
      const documentId = await uploadBatchDocument({
        batchId: idOf(req.params.id),
        filename: decodeURIComponent(String(req.get('x-filename') || '')).replace(/[\\/]/g, '_').trim(),
        buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        documentType: String(req.query.type || 'coa'),
        actor: await currentUserName(req),
      });
      res.status(201).json({ ok: true, documentId });
    } catch (err) { send(res, err); }
  });
router.get('/batches/:id/documents/:docId', viewInventory, async (req, res) => {
  try {
    const doc = await getBatchDocument(idOf(req.params.id), idOf(req.params.docId));
    if (!doc) return res.status(404).json({ ok: false, error: 'No such document.' });
    let bytes;
    try { bytes = await storage().get(doc.storage_path); } catch (err) {
      if (err instanceof StorageNotConfigured) throw err;
      console.error(`Batch document ${doc.id} unreadable:`, err.message);
      return res.status(err.status === 404 || err.code === 'ENOENT' ? 410 : 502).json({ ok: false, error: 'The file could not be read from storage.' });
    }
    res.set('Content-Type', doc.mime_type);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`);
    res.send(bytes);
  } catch (err) { send(res, err); }
});
router.delete('/batches/:id/documents/:docId', moveStock, async (req, res) => {
  try {
    await removeBatchDocument(idOf(req.params.id), idOf(req.params.docId), { actor: await currentUserName(req) });
    res.json({ ok: true });
  } catch (err) { send(res, err); }
});

// ---- suppliers & warehouses
router.get('/suppliers', viewInventory, async (_req, res) => {
  try { res.json({ ok: true, suppliers: await listSuppliers() }); } catch (err) { send(res, err); }
});
router.post('/suppliers', catalog, async (req, res) => {
  try { res.status(201).json({ ok: true, supplier: await saveSupplier(req.body ?? {}, { actor: await currentUserName(req) }) }); } catch (err) { send(res, err); }
});
router.patch('/suppliers/:id', catalog, async (req, res) => {
  try { res.json({ ok: true, supplier: await saveSupplier({ ...req.body, id: idOf(req.params.id) }, { actor: await currentUserName(req) }) }); } catch (err) { send(res, err); }
});
router.get('/warehouses', viewInventory, async (_req, res) => {
  try { res.json({ ok: true, warehouses: await listWarehouses() }); } catch (err) { send(res, err); }
});
router.post('/warehouses', catalog, async (req, res) => {
  try { res.status(201).json({ ok: true, warehouse: await saveWarehouse(req.body ?? {}) }); } catch (err) { send(res, err); }
});
router.patch('/warehouses/:id', catalog, async (req, res) => {
  try { res.json({ ok: true, warehouse: await saveWarehouse({ ...req.body, id: idOf(req.params.id) }) }); } catch (err) { send(res, err); }
});

// ---- shipments: logistics and admins confirm batches and reserve
router.get('/shipments/:id', shipmentView, async (req, res) => {
  try { res.json({ ok: true, stock: await shipmentStock(idOf(req.params.id)) }); } catch (err) { send(res, err); }
});
router.post('/shipments/:id/reserve', shipmentStockEdit, async (req, res) => {
  try {
    const r = await reserveShipmentStock(idOf(req.params.id), req.body?.allocations, { actor: await currentUserName(req) });
    res.json({ ok: true, ...r, stock: await shipmentStock(idOf(req.params.id)) });
  } catch (err) { send(res, err); }
});
router.post('/shipments/:id/release', shipmentStockEdit, async (req, res) => {
  try {
    const r = await releaseShipmentStock(idOf(req.params.id), { actor: await currentUserName(req), reason: 'released by staff' });
    res.json({ ok: true, ...r, stock: await shipmentStock(idOf(req.params.id)) });
  } catch (err) { send(res, err); }
});

router.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: `Files must be ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB or smaller.` });
  }
  return next(err);
});
