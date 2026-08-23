// เขียนไฟล์ .xlsx โดยไม่พึ่ง npm package ใดๆ (ตามกติกา zero-dependency ของโปรเจกต์นี้)
// .xlsx คือไฟล์ ZIP ที่ข้างในเป็น XML — Node มี zlib ในตัวอยู่แล้ว จึงประกอบ ZIP เองได้
// คู่กับ xlsx.js ที่ทำฝั่งอ่าน
//
// ทำไมไม่ใช้ CSV ให้จบ: ทะเบียนหนังสือของโรงเรียนต้องเปิดใน Excel ภาษาไทยแล้วอ่านได้ทันที
// CSV ยังพึ่งการเดารหัสอักขระของ Excel (ต่อให้ใส่ BOM แล้วก็ยังพังบน Excel บางรุ่น/บางเครื่อง)
// และตั้งความกว้างคอลัมน์/หัวตารางตัวหนาไม่ได้ ทะเบียน 500 แถวที่ทุกคอลัมน์กว้างเท่ากันหมด
// เอาไปพิมพ์แจกในที่ประชุมไม่ได้จริง
import zlib from 'node:zlib';

// ---------------- ZIP ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

// วันที่/เวลาแบบ DOS ที่ถูกต้อง — 1980-01-01 00:00 (ปีเริ่มต้นของรูปแบบ ZIP)
// ตั้งเป็น 0 ทั้งคู่ไม่ได้ เพราะแปลว่า "วันที่ 0 เดือน 0" ซึ่งไม่มีอยู่จริง โปรแกรมที่ตรวจเข้มจะไม่ยอมรับไฟล์
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * ประกอบไฟล์ ZIP จากรายการ {name, data} — บีบอัดแบบ deflate ทุกไฟล์ย่อย
 * ไม่รองรับ ZIP64 โดยตั้งใจ (ทะเบียนหนังสือของโรงเรียนไม่มีทางแตะเพดาน 4GB)
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(body, { level: 9 });
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // flag: ชื่อไฟล์เป็น UTF-8
    local.writeUInt16LE(8, 8);       // method: deflate
    local.writeUInt16LE(DOS_TIME, 10); // วันที่คงที่ ให้ export ครั้งไหนก็ได้ไฟล์เหมือนเดิม
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);         // external attributes
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------------- XML ----------------
// อักขระควบคุมที่ XML 1.0 ไม่ยอมรับเลย (เช่น \x00-\x08) ทำให้ Excel ปฏิเสธทั้งไฟล์ว่า "เสียหาย"
// ข้อมูลที่ผู้ใช้พิมพ์เข้ามาหรือคัดลอกมาจากที่อื่นมีโอกาสมีอักขระพวกนี้ปนได้ จึงตัดทิ้งก่อนเสมอ
function xmlText(v) {
  return String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Excel ปฏิเสธไฟล์ที่มีแถวเกินขีดจำกัดของรูปแบบ .xlsx เอง — ตัดที่ตัวเลขจริงของ Excel
const MAX_ROWS = 1048576;

/**
 * สร้างไฟล์ .xlsx หนึ่งชีตจากตารางข้อความล้วน
 *
 * @param {object} opts
 * @param {string} opts.sheetName ชื่อชีต (Excel จำกัด 31 ตัวอักษร และห้ามอักขระ : \ / ? * [ ])
 * @param {string[]} opts.header หัวตาราง (แถวแรก ตัวหนา และตรึงไว้เวลาเลื่อน)
 * @param {Array<Array<string|number|null>>} opts.rows ข้อมูล
 * @param {number[]} [opts.widths] ความกว้างคอลัมน์ (หน่วยเดียวกับที่ Excel ใช้)
 * @returns {Buffer}
 */
export function buildXlsx({ sheetName = 'Sheet1', header = [], rows = [], widths = [] }) {
  const safeSheet = (String(sheetName).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)) || 'Sheet1';
  const all = header.length ? [header, ...rows] : rows;
  if (all.length > MAX_ROWS) throw Object.assign(new Error('ข้อมูลมีจำนวนแถวเกินกว่าที่ไฟล์ Excel รองรับได้'), { statusCode: 400 });

  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const sheetRows = all.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const styleAttr = header.length && r === 0 ? ' s="1"' : '';
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
      const text = String(value ?? '');
      if (!text) return `<c r="${ref}"${styleAttr}/>`;
      // inlineStr แทน sharedStrings — ไม่ต้องมีตารางคำกลาง โค้ดสั้นกว่ามากและ Excel อ่านได้เหมือนกัน
      return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  // ตรึงหัวตารางไว้ เวลาเลื่อนดูทะเบียน 500 แถวจะได้ยังรู้ว่าคอลัมน์ไหนคืออะไร
  const freeze = header.length
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${sheetRows}</sheetData></worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  // ฟอนต์ตัวที่ 1 เป็นตัวหนา ใช้กับหัวตาราง (cellXfs ตัวที่ 1) — ที่เหลือใช้ค่าเริ่มต้น
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ]);
}
