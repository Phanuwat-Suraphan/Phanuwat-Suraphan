// อ่านไฟล์ .xlsx โดยไม่พึ่ง npm package ใดๆ (ตามกติกา zero-dependency ของโปรเจกต์นี้)
// .xlsx จริงๆ คือไฟล์ ZIP ที่ข้างในเป็น XML — Node มี zlib ในตัวอยู่แล้ว จึงแกะ ZIP เองได้
// รองรับเท่าที่ต้องใช้จริง: อ่านค่าข้อความในเซลล์ของชีตที่ต้องการ ไม่รองรับสูตร/รูปแบบตัวเลข/ZIP64
import zlib from 'node:zlib';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// แกะ ZIP: หา End of Central Directory จากท้ายไฟล์ แล้วไล่อ่านรายการไฟล์ข้างใน
function readZipEntries(buf) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 65558); // 64KB comment สูงสุด + 22 ไบต์ EOCD
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw httpError(400, 'ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) ที่อ่านได้');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw httpError(400, 'ไฟล์ Excel ขนาดใหญ่แบบ ZIP64 ยังไม่รองรับ');

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // ความยาว extra field ของ local header มักไม่เท่ากับของ central directory ต้องอ่านจาก local จริง
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      try {
        entries.set(name, method === 0 ? data : zlib.inflateRawSync(data));
      } catch { /* ข้ามไฟล์ย่อยที่แตกไม่ได้ ไม่ให้ทั้งไฟล์พัง */ }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // ต้องเป็นตัวสุดท้าย ไม่งั้น &amp;lt; จะกลายเป็น < ผิด
}

// ข้อความในเซลล์อาจถูกซอยเป็นหลาย <t> (เช่นมีการจัดรูปแบบบางส่วน) ต้องต่อกันทั้งหมด
function textOfRuns(xml) {
  const parts = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]));
  return parts.join('');
}

function parseSharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOfRuns(m[1]));
}

function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// คืนค่าเป็นตาราง 2 มิติของข้อความ (แถว x คอลัมน์) — เซลล์ว่างเป็น ''
function parseSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of rowMatch[1].matchAll(/<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] || cell[2] || '';
      const inner = cell[3] || '';
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      let text = '';
      if (type === 'inlineStr') {
        text = textOfRuns(inner);
      } else {
        const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if (v != null) {
          text = type === 's' ? (shared[Number(v)] ?? '') : decodeEntities(v);
        }
      }
      const idx = ref ? colToIndex(ref) : cells.length;
      while (cells.length < idx) cells.push('');
      cells[idx] = text.trim();
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * อ่านไฟล์ .xlsx ทุกชีต — คืน [{ name, rows }] โดย rows เป็น array ของ array ข้อความ
 * ลำดับชีตอ้างอิงตาม workbook.xml (ลำดับที่ผู้ใช้เห็นในโปรแกรม Excel)
 */
export function readWorkbook(buffer) {
  const entries = readZipEntries(buffer);
  if (!entries.has('xl/workbook.xml')) throw httpError(400, 'ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) ที่อ่านได้');
  const shared = parseSharedStrings(entries);

  // จับคู่ชื่อชีต -> ไฟล์ worksheet ผ่าน r:id ใน workbook.xml.rels
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relTarget = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = m[1].match(/Id="([^"]+)"/)?.[1];
    const target = m[1].match(/Target="([^"]+)"/)?.[1];
    if (id && target) relTarget.set(id, target.replace(/^\/?(xl\/)?/, ''));
  }

  const wbXml = entries.get('xl/workbook.xml').toString('utf8');
  const sheets = [];
  let fallbackIndex = 0;
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    fallbackIndex += 1;
    const name = decodeEntities(m[1].match(/name="([^"]*)"/)?.[1] || `Sheet${fallbackIndex}`);
    const rid = m[1].match(/r:id="([^"]+)"/)?.[1];
    const path = (rid && relTarget.get(rid)) || `worksheets/sheet${fallbackIndex}.xml`;
    const xml = entries.get(`xl/${path}`);
    if (!xml) continue;
    sheets.push({ name, rows: parseSheet(xml, shared) });
  }
  if (!sheets.length) throw httpError(400, 'ไม่พบชีตข้อมูลในไฟล์ Excel นี้');
  return sheets;
}
