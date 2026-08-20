// อ่านไฟล์ .xlsx โดยไม่พึ่ง npm package ใดๆ (ตามกติกา zero-dependency ของโปรเจกต์นี้)
// .xlsx จริงๆ คือไฟล์ ZIP ที่ข้างในเป็น XML — Node มี zlib ในตัวอยู่แล้ว จึงแกะ ZIP เองได้
// รองรับเท่าที่ต้องใช้จริง: ข้อความในเซลล์ + วันที่ ไม่รองรับสูตร/ZIP64
import zlib from 'node:zlib';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// เพดานขนาดหลังคลายบีบอัดต่อไฟล์ย่อย — กัน "zip bomb" (ไฟล์เล็กแต่คลายออกมาเป็นกิกะไบต์)
// มาทำให้เซิร์ฟเวอร์ล่ม เพราะใครก็ตามที่ล็อกอินได้อัปโหลดไฟล์เข้ามาได้
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

// อ่านสารบัญ ZIP แต่ยังไม่คลายบีบอัด — คลายเฉพาะไฟล์ย่อยที่เรียกใช้จริงเท่านั้น (worksheet ที่ต้องการ)
// ไม่ต้องเสียเวลา/หน่วยความจำกับ theme, drawing, ฯลฯ ที่ไม่ได้ใช้
function readZipIndex(buf) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 65558); // comment ยาวสุด 64KB + EOCD 22 ไบต์
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw httpError(400, 'ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) ที่อ่านได้');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw httpError(400, 'ไฟล์ Excel ขนาดใหญ่แบบ ZIP64 ยังไม่รองรับ');

  const index = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    index.set(name, { method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return (name) => {
    const e = index.get(name);
    if (!e) return null;
    if (e.uncompSize > MAX_ENTRY_BYTES) throw httpError(413, 'ไฟล์ Excel นี้มีข้อมูลภายในใหญ่เกินกว่าที่ระบบจะอ่านได้');
    // ความยาว extra field ของ local header มักไม่เท่ากับของสารบัญ ต้องอ่านจาก local header จริง
    if (e.localOff + 30 > buf.length || buf.readUInt32LE(e.localOff) !== 0x04034b50) return null;
    const lNameLen = buf.readUInt16LE(e.localOff + 26);
    const lExtraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + e.compSize);
    try {
      return e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      return null; // ไฟล์ย่อยเสีย/ใหญ่เกิน — ข้ามไป ไม่ให้ทั้งไฟล์พัง
    }
  };
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
  return [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join('');
}

function parseSharedStrings(read) {
  const xml = read('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOfRuns(m[1]));
}

// Excel เก็บวันที่เป็น "ตัวเลขลำดับวัน" ไม่ใช่ข้อความ — ถ้าไม่แปลงกลับ ช่องกำหนดการจะกลายเป็น "45890"
// รู้ว่าเซลล์ไหนเป็นวันที่ได้จาก numFmtId ของสไตล์ที่เซลล์นั้นอ้างถึง (built-in 14-22/45-47 = วันที่/เวลา
// ส่วนรูปแบบที่ผู้ใช้ตั้งเองดูจากตัวอักษร d/m/y ใน format code)
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function parseDateStyles(read) {
  const xml = read('xl/styles.xml')?.toString('utf8');
  if (!xml) return new Set();

  const customDateFmts = new Set();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/>/g)) {
    const id = Number(m[1].match(/numFmtId="(\d+)"/)?.[1]);
    const code = decodeEntities(m[1].match(/formatCode="([^"]*)"/)?.[1] || '');
    // ตัดข้อความในเครื่องหมายคำพูดออกก่อน กันคำอย่าง "day" ทำให้เข้าใจผิดว่าเป็นวันที่
    if (Number.isFinite(id) && /[dmyhs]/i.test(code.replace(/"[^"]*"/g, ''))) customDateFmts.add(id);
  }

  const cellXfsBlock = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const dateStyleIdx = new Set();
  let i = 0;
  for (const m of cellXfsBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const numFmtId = Number(m[1].match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (BUILTIN_DATE_FMT.has(numFmtId) || customDateFmts.has(numFmtId)) dateStyleIdx.add(i);
    i += 1;
  }
  return dateStyleIdx;
}

// ตัวเลขลำดับวันของ Excel -> วันที่จริง (ฐานคือ 30 ธ.ค. 1899 เพราะ Excel นับปี 1900 เป็นปีอธิกสุรทินผิด)
function excelSerialToThaiDate(serial) {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400000); // 25569 = จำนวนวันจาก 1899-12-30 ถึง 1970-01-01
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// คืนค่าเป็นตาราง 2 มิติของข้อความ (แถว x คอลัมน์) — เซลล์ว่างเป็น ''
function parseSheet(xml, shared, dateStyles) {
  const rows = [];
  for (const rowMatch of xml.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of rowMatch[1].matchAll(/<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] || cell[2] || '';
      const inner = cell[3] || '';
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const styleIdx = Number(attrs.match(/s="(\d+)"/)?.[1] ?? -1);
      let text = '';
      if (type === 'inlineStr') {
        text = textOfRuns(inner);
      } else {
        const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if (v != null) {
          if (type === 's') {
            text = shared[Number(v)] ?? '';
          } else if (!type || type === 'n') {
            text = (dateStyles.has(styleIdx) && excelSerialToThaiDate(Number(v))) || decodeEntities(v);
          } else {
            text = decodeEntities(v);
          }
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
  const read = readZipIndex(buffer);
  const wbBuf = read('xl/workbook.xml');
  if (!wbBuf) throw httpError(400, 'ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) ที่อ่านได้');
  const shared = parseSharedStrings(read);
  const dateStyles = parseDateStyles(read);

  // จับคู่ชื่อชีต -> ไฟล์ worksheet ผ่าน r:id ใน workbook.xml.rels
  const relsXml = read('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relTarget = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = m[1].match(/Id="([^"]+)"/)?.[1];
    const target = m[1].match(/Target="([^"]+)"/)?.[1];
    if (id && target) relTarget.set(id, target.replace(/^\/?(xl\/)?/, ''));
  }

  const wbXml = wbBuf.toString('utf8');
  const sheets = [];
  let fallbackIndex = 0;
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    fallbackIndex += 1;
    const name = decodeEntities(m[1].match(/name="([^"]*)"/)?.[1] || `Sheet${fallbackIndex}`);
    const rid = m[1].match(/r:id="([^"]+)"/)?.[1];
    const path = (rid && relTarget.get(rid)) || `worksheets/sheet${fallbackIndex}.xml`;
    const xml = read(`xl/${path}`);
    if (!xml) continue;
    sheets.push({ name, rows: parseSheet(xml, shared, dateStyles) });
  }
  if (!sheets.length) throw httpError(400, 'ไม่พบชีตข้อมูลในไฟล์ Excel นี้');
  return sheets;
}
