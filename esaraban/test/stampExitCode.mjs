// ทดสอบว่าการประทับตราลงไฟล์ PDF จริงรับมือกับรหัสจบการทำงานของ qpdf ได้ถูกต้อง
//
// ที่มา: เครื่องใช้งานจริงประทับตราไม่ได้เลย ขึ้นข้อความภาษาอังกฤษดิบๆ ว่า
//   "qpdf exited with code 3: WARNING: ... dictionary has duplicated key /Info ...
//    WARNING: ... stream keyword followed by carriage return only"
//
// qpdf ใช้รหัส 3 = "ทำงานสำเร็จแล้ว แต่มีคำเตือน" ซึ่งต่างจาก 2 = "มีข้อผิดพลาด"
// (ดู qpdf --help=exit-status) และไฟล์ผลลัพธ์ถูกสร้างครบถ้วนแล้วในกรณีนี้ — แต่โค้ดเดิมถือว่า
// "ไม่ใช่ 0 = ล้มเหลว" ทั้งหมด การประทับตราจึงล้มเหลวกับหนังสือจริงเกือบทุกฉบับ เพราะไฟล์ที่สแกน
// จากเครื่องถ่ายเอกสารหรือที่ส่งมาจากหน่วยงานต้นทางเกือบทุกไฟล์มีคำเตือนแบบนี้เป็นปกติ
//
// qpdf ติดตั้งในสภาพแวดล้อมทดสอบไม่ได้ (คลังแพ็กเกจถูกบล็อก) จึงใช้ qpdf จำลองที่ทำตัวเหมือนของจริง
// วางไว้ใน PATH — ส่วน chromium ใช้ตัวจริง เส้นทางที่เหลือจึงเป็นของจริงทั้งหมด
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2] || 'warnings';
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-fakeqpdf-'));

const SCRIPTS = {
  // สำเร็จแต่มีคำเตือน — เหมือนไฟล์สแกนจริงเกือบทุกไฟล์
  warnings: `#!/bin/sh
IN="$1"; OUT="$(eval echo \\\${$#})"
cat "$IN" > "$OUT"
echo "WARNING: original.pdf (trailer, offset 916412): dictionary has duplicated key /Info; last occurrence overrides earlier ones" >&2
echo "WARNING: original.pdf (object 1 0, offset 176): stream keyword followed by carriage return only" >&2
exit 3
`,
  // ล้มเหลวจริง — ต้องยังล้มเหลวตามเดิม
  error: `#!/bin/sh
echo "qpdf: original.pdf: unable to find trailer dictionary while recovering damaged file" >&2
exit 2
`,
  // จบด้วย 3 แต่ไฟล์ที่ได้ไม่ใช่ PDF — ต้องไม่ปล่อยผ่าน ไม่งั้นไปทับสำเนาของหนังสือราชการ
  'bad-output': `#!/bin/sh
OUT="$(eval echo \\\${$#})"
echo "ไม่ใช่ไฟล์ PDF" > "$OUT"
exit 3
`,
};

fs.writeFileSync(path.join(binDir, 'qpdf'), SCRIPTS[mode], { mode: 0o755 });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
process.env.CHROME_BIN = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const out = { mode };
try {
  const { stampPdf } = await import('../src/services/pdfStamp.js');
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n% หนังสือที่สแกนมาจากเครื่องถ่ายเอกสาร\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
    Buffer.alloc(2000, 0x20),
  ]);
  const stamped = await stampPdf({
    originalBuffer: pdf, schoolName: 'โรงเรียนวัดเสาหิน',
    docNumberDisplay: '0042/2569', dateThaiLong: '17 ก.ย. 2569', timeStr: '10:30',
  });
  out.ok = true;
  out.bytes = stamped.length;
  out.isPdf = stamped.subarray(0, 5).toString('latin1') === '%PDF-';
} catch (err) {
  out.ok = false;
  out.error = err?.message || String(err);
} finally {
  fs.rmSync(binDir, { recursive: true, force: true });
}

console.log(JSON.stringify(out));
