import { getPool, ensureSchema } from './db.js';
import { storage, validateDocument, newPrefixedKey } from './storage.js';

/**
 * Member profiles. The WhatsApp number used to sign in is the member's
 * identity and contact number; it is never asked for again here.
 *
 * A profile is complete with: a real name (not the "Team" placeholder), an
 * email address, and a profile photo the member uploaded. No photo is ever
 * generated or invented; initials are only a stand-in until one exists.
 *
 * Photos live in the same private storage as documents (R2 in production),
 * under members/photos/, and are only ever streamed through the app.
 */

export const PHOTO_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PLACEHOLDER_NAMES = new Set(['', 'team']);

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** What is still missing from a member row: [] when complete. */
export function missingFields(row) {
  const missing = [];
  if (PLACEHOLDER_NAMES.has(String(row?.name ?? '').trim().toLowerCase())) missing.push('name');
  if (!String(row?.email ?? '').trim()) missing.push('email');
  if (!row?.photo_key) missing.push('photo');
  return missing;
}

export const photoUrlOf = (row) => (row?.photo_key
  ? `/api/members/${encodeURIComponent(row.phone)}/photo?v=${new Date(row.photo_updated_at || 0).getTime()}` : null);

/** The public shape of a profile: never the storage key. */
export function profileView(row) {
  const missing = missingFields(row);
  return {
    phone: row.phone,
    name: row.name,
    email: row.email || null,
    photoUrl: photoUrlOf(row),
    hasPhoto: Boolean(row.photo_key),
    complete: missing.length === 0,
    missing,
    // name, email, phone (always present from sign-in), photo
    completion: Math.round(((4 - missing.length) / 4) * 100),
    updatedAt: row.profile_updated_at,
    // Required members cannot use Briyo OS until complete; others are only asked.
    required: row.profile_required === true,
  };
}

export function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) throw bad('Email is required.', 400, { field: 'email' });
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('That email address does not look right.', 400, { field: 'email' });
  return s;
}
export function normalizeName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s || PLACEHOLDER_NAMES.has(s.toLowerCase())) throw bad('Please enter your full name.', 400, { field: 'name' });
  if (s.length > 60) throw bad('Name is too long (60 characters at most).', 400, { field: 'name' });
  return s;
}

const COLUMNS = 'phone, name, email, photo_key, photo_mime, photo_updated_at, profile_updated_at, active, profile_required';

export async function getMemberRow(phone) {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT ${COLUMNS} FROM allowed_users WHERE phone = $1`, [phone]);
  return rows[0] || null;
}

export async function getProfile(phone) {
  const row = await getMemberRow(phone);
  if (!row) throw bad('No such member.', 404);
  return profileView(row);
}

/** Name and email, by the member themself or an admin. Phone is not editable here. */
export async function updateProfile(phone, input, { actor } = {}) {
  await ensureSchema();
  const sets = []; const params = [phone]; const changed = [];
  if (input.name !== undefined) { params.push(normalizeName(input.name)); sets.push(`name = $${params.length}`); changed.push('name'); }
  if (input.email !== undefined) { params.push(normalizeEmail(input.email)); sets.push(`email = $${params.length}`); changed.push('email'); }
  if (!sets.length) return getProfile(phone);
  const { rows } = await getPool().query(
    `UPDATE allowed_users SET ${sets.join(', ')}, profile_updated_at = now() WHERE phone = $1 RETURNING ${COLUMNS}`, params);
  if (!rows[0]) throw bad('No such member.', 404);
  await logProfile(actor, phone, `profile: ${changed.join(', ')}`);
  return profileView(rows[0]);
}

async function logProfile(actor, phone, detail) {
  await getPool().query('INSERT INTO member_log (actor, action, target_phone, detail) VALUES ($1, $2, $3, $4)',
    [actor || 'member', 'profile', phone, detail.slice(0, 300)]).catch(() => {});
}

/**
 * Stores a new photo, then points the member at it, then removes the old one.
 * If the database update fails, the new object is removed: storage never keeps
 * a photo nobody points to, and the member keeps their previous photo.
 */
export async function savePhoto(phone, { filename, buffer }, { actor, store = storage() } = {}) {
  await ensureSchema();
  const name = String(filename || 'photo').slice(0, 120);
  if (!buffer?.length) throw bad('Choose a photo to upload.', 400, { field: 'photo' });
  if (buffer.length > MAX_PHOTO_BYTES) throw bad('That photo is larger than 2 MB. Please choose a smaller one.', 413, { field: 'photo' });
  const check = validateDocument(name, buffer, PHOTO_FORMATS);
  if (!check.ok) throw bad(check.error.startsWith('Only') ? 'Use a JPG, PNG or WebP image.' : `${check.error.replace('That file', 'That photo').replace('The file', 'The photo')} Use a JPG, PNG or WebP image.`, 400, { field: 'photo' });
  const before = await getMemberRow(phone);
  if (!before) throw bad('No such member.', 404);
  const key = newPrefixedKey('members/photos', check.ext === 'jpeg' ? 'jpg' : check.ext);
  await store.put(key, buffer, check.mime);
  let row;
  try {
    const { rows } = await getPool().query(
      `UPDATE allowed_users SET photo_key = $2, photo_mime = $3, photo_updated_at = now(), profile_updated_at = now()
       WHERE phone = $1 RETURNING ${COLUMNS}`, [phone, key, check.mime]);
    row = rows[0];
    if (!row) throw bad('No such member.', 404);
  } catch (err) {
    await store.remove(key).catch(() => console.error(`Orphaned member photo ${key}`));
    throw err;
  }
  if (before.photo_key) await store.remove(before.photo_key).catch(() => console.error(`Old member photo for ${phone} not removed`));
  await logProfile(actor, phone, before.photo_key ? 'profile: photo replaced' : 'profile: photo added');
  return profileView(row);
}

/**
 * An admin takes a photo down (e.g. not a photo of the person). The profile is
 * then incomplete again, so the member is asked for a new one at their next
 * request. Members cannot remove their own photo, only replace it.
 */
export async function clearPhoto(phone, { actor, store = storage() } = {}) {
  await ensureSchema();
  const row = await getMemberRow(phone);
  if (!row) throw bad('No such member.', 404);
  if (!row.photo_key) throw bad('This member has no photo.', 404);
  // Only if it is still the same photo (a concurrent replace wins).
  const { rowCount } = await getPool().query(
    `UPDATE allowed_users SET photo_key = NULL, photo_mime = NULL, photo_updated_at = now(), profile_updated_at = now()
     WHERE phone = $1 AND photo_key = $2`, [phone, row.photo_key]);
  if (!rowCount) throw bad('The photo changed meanwhile. Reload and try again.', 409, { conflict: true });
  const rows = [{ old: row.photo_key }];
  await store.remove(rows[0].old).catch(() => console.error(`Member photo for ${phone} not removed from storage`));
  await logProfile(actor, phone, 'profile: photo removed by an admin (a new one is required)');
  return getProfile(phone);
}

/** The photo bytes for an authenticated viewer. */
export async function photoFile(phone, { store = storage() } = {}) {
  const row = await getMemberRow(phone);
  if (!row?.photo_key) throw bad('No photo.', 404);
  return { buffer: await store.get(row.photo_key), mime: row.photo_mime || 'application/octet-stream', etag: `"${row.photo_key.split('/').pop()}"` };
}

/** One member's recent account history for the profile drawer (admins). */
export async function memberActivity(phone, { limit = 30 } = {}) {
  const [log, logins] = await Promise.all([
    getPool().query('SELECT actor, action, detail, at FROM member_log WHERE target_phone = $1 ORDER BY at DESC LIMIT $2', [phone, limit]),
    getPool().query('SELECT ok, reason, at FROM login_log WHERE phone = $1 ORDER BY at DESC LIMIT 10', [phone]),
  ]);
  return { changes: log.rows, signIns: logins.rows };
}
