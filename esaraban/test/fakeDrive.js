// Google Drive จำลองไว้ในหน่วยความจำ — ใช้ทดสอบเส้นทางสำรอง/กู้คืนฐานข้อมูลจริงๆ ทั้งเส้น
//
// ทำไมต้องมี: การกู้คืนฐานข้อมูลจากสำเนาบน Drive คือเส้นทางที่ข้อมูลทั้งโรงเรียนแขวนอยู่ ดิสก์ของ
// โฮสต์ฟรีถูกล้างทุกครั้งที่ deploy ทะเบียนหนังสือทั้งเล่มกลับมาได้ด้วยเส้นทางนี้เส้นเดียว แต่เดิม
// ทดสอบได้แค่ทางที่ "ไม่ทำอะไร" ส่วนทางที่ทำงานจริง (ดาวน์โหลดแล้วเขียนไฟล์) ไม่มีเทสต์แตะเลย
//
// ตัวนี้เลียนแบบเฉพาะส่วนของ Drive API ที่ระบบเรียกใช้จริงเท่านั้น ไม่ได้ทำครบทั้ง API
// และตั้งใจให้ "งอแง" ได้เหมือนของจริง (สั่งให้ตอบ error ได้) เพื่อทดสอบทางที่ล้มเหลวด้วย
import { Readable } from 'node:stream';

export function createFakeDrive() {
  // ไฟล์/โฟลเดอร์ทั้งหมด: id -> { id, name, mimeType, parents, body }
  const items = new Map();
  let seq = 0;
  const newId = () => `fake-${++seq}`;
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  // สั่งให้ Drive จำลองงอแงได้ — ใช้ทดสอบว่าระบบรับมือถูกต้องไหม
  // truncateIds = ทำให้เฉพาะไฟล์ที่ระบุขาดกลางคัน ใช้ทดสอบการถอยไปใช้สำเนาก่อนหน้า
  const faults = { failToken: false, failDownload: false, failList: false, truncateDownload: false, truncateIds: new Set() };

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function childrenOf(parentId) {
    return [...items.values()].filter((f) => (f.parents || []).includes(parentId));
  }

  // แกะเงื่อนไข q= ของ Drive API เท่าที่ระบบนี้ใช้จริง: ชื่อ + parent + ชนิด
  function runQuery(q) {
    const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const wantFolder = q.includes(`mimeType='${FOLDER_MIME}'`);
    const notFolder = q.includes(`mimeType != '${FOLDER_MIME}'`);
    return [...items.values()].filter((f) => {
      if (name !== undefined && f.name !== name) return false;
      if (parent && !(f.parents || []).includes(parent)) return false;
      if (wantFolder && f.mimeType !== FOLDER_MIME) return false;
      if (notFolder && f.mimeType === FOLDER_MIME) return false;
      return true;
    });
  }

  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();

    // ---- ต่ออายุ access token ----
    if (u.includes('oauth2.googleapis.com/token')) {
      if (faults.failToken) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'fake-token', expires_in: 3600 });
    }

    // ---- อัปโหลดแบบ resumable: รอบแรกขอที่อยู่ รอบสองส่งเนื้อไฟล์ ----
    if (u.includes('/upload/drive/v3/files')) {
      const meta = JSON.parse(opts.body || '{}');
      const id = newId();
      items.set(id, { id, name: meta.name, mimeType: meta.mimeType || 'application/octet-stream', parents: meta.parents || [], body: Buffer.alloc(0) });
      return new Response(null, { status: 200, headers: { Location: `https://fake-upload.local/${id}` } });
    }
    if (u.startsWith('https://fake-upload.local/')) {
      const id = u.split('/').pop();
      const item = items.get(id);
      if (item) item.body = Buffer.from(opts.body);
      return json({ id });
    }

    // ---- ดาวน์โหลดเนื้อไฟล์ ----
    const dl = /\/drive\/v3\/files\/([^/?]+)\?alt=media/.exec(u);
    if (dl) {
      if (faults.failDownload) return json({ error: { message: 'จำลองว่าดาวน์โหลดไม่สำเร็จ' } }, 500);
      const item = items.get(dl[1]);
      if (!item) return json({ error: { message: 'not found' } }, 404);
      // ขาดกลางคัน — ต้องไม่เหลือไฟล์ฐานข้อมูลพังๆ ไว้ (ดู restoreDatabaseIfMissing)
      const cut = faults.truncateDownload || faults.truncateIds.has(item.id) || faults.truncateIds.has(item.name);
      const body = cut ? item.body.subarray(0, Math.floor(item.body.length / 2)) : item.body;
      return new Response(Readable.toWeb(Readable.from([body])), { status: 200 });
    }

    // ---- ลบไฟล์/โฟลเดอร์ (ลบลูกทั้งหมดตามไปด้วยเหมือน Drive จริง) ----
    const del = /\/drive\/v3\/files\/([^/?]+)/.exec(u);
    if (del && method === 'DELETE') {
      const drop = (id) => { childrenOf(id).forEach((c) => drop(c.id)); items.delete(id); };
      drop(del[1]);
      return new Response(null, { status: 204 });
    }

    // ---- อ่าน parents ของไฟล์ ----
    if (del && method === 'GET' && u.includes('fields=parents')) {
      const item = items.get(del[1]);
      return item ? json({ parents: item.parents || [] }) : json({ error: { message: 'not found' } }, 404);
    }

    // ---- ค้นหา / สร้างโฟลเดอร์ ----
    if (u.includes('/drive/v3/files')) {
      if (method === 'POST') {
        const meta = JSON.parse(opts.body || '{}');
        const id = newId();
        items.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || [], body: Buffer.alloc(0) });
        return json({ id, name: meta.name });
      }
      if (faults.failList) return json({ error: { message: 'จำลองว่าค้นหาไม่สำเร็จ' } }, 500);
      const q = decodeURIComponent(new URL(u).searchParams.get('q') || '');
      const found = runQuery(q);
      return json({
        files: found.map((f) => ({
          id: f.id, name: f.name, mimeType: f.mimeType,
          size: String(f.body?.length ?? 0), createdTime: new Date().toISOString(),
        })),
      });
    }

    throw new Error(`Drive จำลองไม่รู้จักคำขอนี้: ${method} ${u}`);
  };

  return {
    fetch: fetchImpl,
    faults,
    /** ไฟล์สำเนาฐานข้อมูลทั้งหมดที่อยู่บน Drive จำลองตอนนี้ */
    backupFiles: () => [...items.values()].filter((f) => f.name?.startsWith('esaraban-') && f.name.endsWith('.db')),
    folderNames: () => [...items.values()].filter((f) => f.mimeType === FOLDER_MIME).map((f) => f.name),
    size: () => items.size,
  };
}
