// httpError คัดลอกไว้ในไฟล์นี้เอง (ไม่ import จาก workflow.js) เพื่อเลี่ยง circular import —
// workflow.js เองก็ต้อง import จากไฟล์นี้ (สำหรับ forceDeleteDocument ลบไฟล์บน Drive)
export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// ใช้ Google Drive เป็นที่เก็บไฟล์แนบแทน local disk — เหมาะกับ hosting ที่ไม่มี disk ถาวร
// (เช่น Render free tier) เพราะไฟล์อยู่นอกเซิร์ฟเวอร์ ไม่หายตอน redeploy
// เปิดใช้งานด้วย env var STORAGE_PROVIDER=google_drive (ค่าเริ่มต้นคือ local disk เหมือนเดิม)
//
// ใช้ OAuth2 "act as the real Google account" แทน Service Account — เพราะ Service Account
// ไม่มีโควตาพื้นที่เก็บข้อมูลเป็นของตัวเองบนบัญชี Gmail ทั่วไป (ไม่ใช่ Google Workspace) ทำให้อัปโหลด
// fail ด้วย "Service Accounts do not have storage quota" เสมอ — พิสูจน์แล้วจากการใช้งานจริง
// ไฟล์ที่อัปโหลดจะนับพื้นที่ในโควตา 15GB ของบัญชี Google ที่เชื่อมต่อจริง ไม่ใช่โควตาแยกต่างหาก
// ดูขั้นตอนติดตั้งทั้งหมดใน deploy/GOOGLE_DRIVE.md — เชื่อมต่อผ่านหน้า /admin/google-drive

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const ROOT_FOLDER_NAME = 'ระบบสารบรรณอิเล็กทรอนิกส์ (esaraban)';

export function isGoogleDriveEnabled() {
  return process.env.STORAGE_PROVIDER === 'google_drive';
}

export function getOAuthClientConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw httpError(500, 'ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET — ดูขั้นตอนใน deploy/GOOGLE_DRIVE.md');
  }
  return { clientId, clientSecret };
}

export function isGoogleDriveConnected() {
  return Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

let cachedToken = null; // { accessToken, expiresAt }
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.accessToken;
  const { clientId, clientSecret } = getOAuthClientConfig();
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) throw httpError(500, 'ยังไม่ได้เชื่อมต่อ Google Drive — ไปที่หน้า /admin/google-drive เพื่อเชื่อมต่อบัญชี Google ก่อน');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(502, `เชื่อมต่อ Google Drive ไม่สำเร็จ (ต่ออายุ token ล้มเหลว): ${data.error_description || data.error || res.statusText} — อาจต้องเชื่อมต่อบัญชีใหม่ที่ /admin/google-drive`);
  }
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function driveFetch(url, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  return res;
}

// ค้นหาโฟลเดอร์ชื่อ name ใต้ parentId ถ้าไม่มีให้สร้างใหม่ — ใช้จัดหมวดหมู่ ปี/ประเภทหนังสือ
// หมายเหตุ: scope drive.file ทำให้แอปมองเห็นเฉพาะไฟล์/โฟลเดอร์ที่แอปสร้างเองเท่านั้น จึงต้องให้แอป
// เป็นผู้สร้างโฟลเดอร์รากเองเสมอ (ห้ามให้ผู้ใช้สร้างโฟลเดอร์เองแล้วส่ง ID มาให้ จะมองไม่เห็น)
async function findOrCreateFolder(name, parentId) {
  const escaped = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchRes = await driveFetch(`${API_BASE}?q=${q}&fields=files(id,name)&spaces=drive`);
  const searchData = await searchRes.json().catch(() => ({}));
  if (!searchRes.ok) throw httpError(502, `ค้นหาโฟลเดอร์ Google Drive ไม่สำเร็จ: ${searchData.error?.message || searchRes.statusText}`);
  if (searchData.files?.length) return searchData.files[0].id;

  const createRes = await driveFetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) throw httpError(502, `สร้างโฟลเดอร์ Google Drive ไม่สำเร็จ: ${createData.error?.message || createRes.statusText}`);
  return createData.id;
}

// จัดหมวดหมู่: root (แอปสร้างเอง) / ปี พ.ศ. / ประเภทหนังสือ — ตรงกับที่โรงเรียนคุ้นเคยจากตู้เอกสารจริง
export async function ensureCategoryFolder({ yearBe, typeName }) {
  const root = await findOrCreateFolder(ROOT_FOLDER_NAME, 'root');
  const yearFolder = await findOrCreateFolder(String(yearBe), root);
  return findOrCreateFolder(typeName, yearFolder);
}

// อัปโหลดไฟล์ด้วย resumable upload (รองรับไฟล์ได้ถึง 10MB ตามเพดานของระบบอย่างน่าเชื่อถือ)
export async function uploadFile({ buffer, filename, mimeType, folderId }) {
  const token = await getAccessToken();
  const initRes = await fetch(`${UPLOAD_BASE}?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(buffer.length),
    },
    body: JSON.stringify({ name: filename, parents: [folderId] }),
  });
  if (!initRes.ok) {
    const errData = await initRes.json().catch(() => ({}));
    throw httpError(502, `เริ่มอัปโหลดไป Google Drive ไม่สำเร็จ: ${errData.error?.message || initRes.statusText}`);
  }
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw httpError(502, 'Google Drive ไม่ส่ง upload session URL กลับมา');

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(buffer.length) },
    body: buffer,
  });
  const putData = await putRes.json().catch(() => ({}));
  if (!putRes.ok) throw httpError(502, `อัปโหลดไฟล์ไป Google Drive ไม่สำเร็จ: ${putData.error?.message || putRes.statusText}`);
  return putData.id; // Google Drive file ID
}

// ดาวน์โหลดเนื้อหาไฟล์ (คืนค่าเป็น web ReadableStream สำหรับ pipe ต่อไปยัง response)
export async function downloadFileStream(fileId) {
  const res = await driveFetch(`${API_BASE}/${fileId}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw httpError(502, `ดาวน์โหลดไฟล์จาก Google Drive ไม่สำเร็จ: ${errData.error?.message || res.statusText}`);
  }
  return res.body;
}

export async function deleteFile(fileId) {
  const res = await driveFetch(`${API_BASE}/${fileId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const errData = await res.json().catch(() => ({}));
    throw httpError(502, `ลบไฟล์บน Google Drive ไม่สำเร็จ: ${errData.error?.message || res.statusText}`);
  }
}

export async function exchangeCodeForTokens({ code, redirectUri }) {
  const { clientId, clientSecret } = getOAuthClientConfig();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `แลก authorization code ไม่สำเร็จ: ${data.error_description || data.error || res.statusText}`);
  return data; // { access_token, refresh_token, expires_in, ... } — refresh_token มาเฉพาะครั้งแรกที่ยินยอม (prompt=consent)
}
