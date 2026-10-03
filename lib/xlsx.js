import zlib from 'node:zlib';

/**
 * Reads the first worksheet of an .xlsx file into rows of strings.
 *
 * Small on purpose: an .xlsx is a zip of XML parts, and an order export needs
 * only the cell values — no styles, formulas or second sheets. Hand-rolled
 * like the CSV parser, so the app keeps its four dependencies.
 */

function unzip(buf) {
  // End of central directory: the last record with signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Not a valid .xlsx file.');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files.set(name, () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
  if (named) return named;
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const textOf = (xml) => unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => ref.replace(/\d+/g, '').split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** Numbers as Excel stores them, written back without exponent or float noise. */
function numberText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return n.toFixed(0);
  return String(Math.round(n * 1e10) / 1e10);
}

export function readXlsx(buffer) {
  const files = unzip(buffer);
  const read = (name) => files.get(name)?.();
  // The first sheet listed in the workbook, via its relationship id.
  const workbook = read('xl/workbook.xml') || '';
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstId && new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('The spreadsheet has no readable sheet.');
  const shared = [...(read('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = cm[2] || '';
      let value = '';
      if (type === 's') value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v === undefined ? '' : (type === 'str' || type === 'b' || type === 'e' ? unescapeXml(v) : numberText(v));
      }
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (v) => v ?? ''));
  }
  return rows;
}

/** Excel's day serial (1900 date system) as an ISO instant, for date cells. */
export function excelSerialToIso(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86_400_000);
  return new Date(ms).toISOString();
}
