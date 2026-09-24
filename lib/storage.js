import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Document storage. The database only ever holds a `storage_path` key; the
 * bytes live behind this interface, so moving to S3/R2 later is a new driver,
 * not a schema change.
 *
 * Only a local-disk driver exists today. On Render's free tier the disk is
 * wiped on every deploy and restart, so files stored there are NOT durable in
 * production — `durable` says so, and the UI surfaces it.
 */

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// Declared types are not trusted: the first bytes must agree with them.
const SIGNATURES = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],           // %PDF
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
};
const EXTENSIONS = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** Returns { ok, mime, ext } or { ok:false, error } for an upload. */
export function validateDocument(filename, buffer) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const mime = EXTENSIONS[ext];
  if (!mime) return { ok: false, error: 'Only PDF, PNG, JPG and JPEG files can be uploaded.' };
  if (!buffer?.length) return { ok: false, error: 'The file is empty.' };
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: `Files must be ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB or smaller.` };
  }
  const matches = SIGNATURES[mime].some((sig) => sig.every((b, i) => buffer[i] === b));
  if (!matches) return { ok: false, error: `That file is not a real ${ext.toUpperCase()}.` };
  return { ok: true, mime, ext: ext === 'jpeg' ? 'jpg' : ext };
}

function localDriver(root) {
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Bad storage key');
    return full;
  };
  return {
    name: 'local',
    durable: false,
    async put(key, buffer) {
      const full = resolve(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buffer, { flag: 'wx' }); // never overwrite
    },
    async get(key) { return fs.readFile(resolve(key)); },
    async remove(key) { await fs.rm(resolve(key), { force: true }); },
  };
}

let driverInstance = null;
export function storage() {
  if (!driverInstance) {
    const driverName = process.env.DOCUMENT_STORAGE || 'local';
    if (driverName !== 'local') throw new Error(`Unknown DOCUMENT_STORAGE driver "${driverName}"`);
    driverInstance = localDriver(process.env.DOCUMENT_STORAGE_DIR || path.resolve('data/documents'));
  }
  return driverInstance;
}

/** A fresh, unguessable key. The original filename is kept in the database only. */
export function newStorageKey(orderId, ext) {
  const month = new Date().toISOString().slice(0, 7);
  return `orders/${month}/${orderId}-${crypto.randomUUID()}.${ext}`;
}
