import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Document storage. The database only ever holds an object key; the bytes
 * live behind this interface.
 *
 *   DOCUMENT_STORAGE=r2     Cloudflare R2 (private bucket). Production.
 *   DOCUMENT_STORAGE=local  Local disk. Development and tests only — refused
 *                           in production, where Render's disk is wiped on
 *                           every deploy.
 *
 * Downloads always go through the app (authenticated), never a public or
 * pre-signed bucket URL.
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

export class StorageNotConfigured extends Error {}
const isProduction = () => process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

// ---------------------------------------------------------------------------
// Local disk (dev/tests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cloudflare R2 over its S3-compatible API, signed with AWS Signature V4.
// Three calls (PUT, GET, DELETE) don't justify the AWS SDK as a dependency.
// ---------------------------------------------------------------------------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signature V4 for a request with no query string. Exported so the test suite
 * can check it against AWS's published example.
 */
export function signV4({ method, path: reqPath, headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [
    method, reqPath, '',
    ...names.map((n) => `${n}:${lower[n]}`), '',
    names.join(';'), payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

function r2Driver({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
  const base = new URL(endpoint || `https://${accountId}.r2.cloudflarestorage.com`);
  async function call(method, key, body = null, contentType = null) {
    const reqPath = `/${rfc3986(bucket)}/${key.split('/').map(rfc3986).join('/')}`;
    const payloadHash = sha256(body || '');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const headers = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (contentType) headers['content-type'] = contentType;
    const authorization = signV4({
      method, path: reqPath, headers, payloadHash, accessKeyId, secretAccessKey, region: 'auto', amzDate,
    });
    const { host, ...sendHeaders } = headers; // fetch sets Host itself
    const res = await fetch(new URL(reqPath, base), { method, headers: { ...sendHeaders, authorization }, body });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || '';
      throw Object.assign(new Error(`R2 ${method} failed: HTTP ${res.status} ${code}`), { status: res.status });
    }
    return res;
  }
  return {
    name: 'r2',
    durable: true,
    async put(key, buffer, mime) { await call('PUT', key, buffer, mime || 'application/octet-stream'); },
    async get(key) { return Buffer.from(await (await call('GET', key)).arrayBuffer()); },
    async remove(key) { await call('DELETE', key); },
  };
}

// ---------------------------------------------------------------------------

let driverInstance = null;

/** The configured driver. Throws StorageNotConfigured rather than fall back silently. */
export function storage() {
  if (driverInstance) return driverInstance;
  const name = process.env.DOCUMENT_STORAGE || (isProduction() ? 'r2' : 'local');
  if (name === 'r2') {
    const cfg = {
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET,
      endpoint: process.env.R2_ENDPOINT || null,
    };
    const missing = ['accessKeyId', 'secretAccessKey', 'bucket'].filter((k) => !cfg[k]);
    if (!cfg.accountId && !cfg.endpoint) missing.push('accountId');
    if (missing.length) {
      throw new StorageNotConfigured('Document storage is not set up yet (R2 credentials missing). Uploads are disabled.');
    }
    driverInstance = r2Driver(cfg);
  } else if (name === 'local') {
    if (isProduction()) {
      throw new StorageNotConfigured('Local document storage is not allowed in production. Configure R2.');
    }
    driverInstance = localDriver(process.env.DOCUMENT_STORAGE_DIR || path.resolve('data/documents'));
  } else {
    throw new StorageNotConfigured(`Unknown DOCUMENT_STORAGE "${name}".`);
  }
  return driverInstance;
}

/** For tests: forget the cached driver so env changes take effect. */
export function _resetStorage() { driverInstance = null; }

/** A fresh, unguessable key. The original filename is kept in the database only. */
export function newStorageKey(orderId, ext) {
  const month = new Date().toISOString().slice(0, 7);
  return `orders/${month}/${orderId}-${crypto.randomUUID()}.${ext}`;
}
