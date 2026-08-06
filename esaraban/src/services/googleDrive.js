import { createSign } from 'node:crypto';
import { httpError } from './workflow.js';

// ใช้ Google Drive เป็นที่เก็บไฟล์แนบแทน local disk — เหมาะกับ hosting ที่ไม่มี disk ถาวร
// (เช่น Render free tier) เพราะไฟล์อยู่นอกเซิร์ฟเวอร์ ไม่หายตอน redeploy
// เปิดใช้งานด้วย env var STORAGE_PROVIDER=google_drive (ค่าเริ่มต้นคือ local disk เหมือนเดิม)
// ต้องตั้งค่า GOOGLE_SERVICE_ACCOUNT_JSON และ GOOGLE_DRIVE_ROOT_FOLDER_ID ด้วย
// ดูขั้นตอนติดตั้งทั้งหมดใน deploy/GOOGLE_DRIVE.md

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';

export function isGoogleDriveEnabled() {
  return process.env.STORAGE_PROVIDER === 'google_drive';
}

let cachedCreds = null;
function getCredentials() {
  if (cachedCreds) return cachedCreds;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw httpError(500, 'ไม่ได้ตั้งค่า GOOGLE_SERVICE_ACCOUNT_JSON — ดูขั้นตอนใน deploy/GOOGLE_DRIVE.md');
  try {
    cachedCreds = JSON.parse(raw);
  } catch (e) {
    throw httpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON ไม่ใช่ JSON ที่ถูกต้อง');
  }
  if (!cachedCreds.client_email || !cachedCreds.private_key) {
    throw httpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON ไม่มี client_email หรือ private_key');
  }
  return cachedCreds;
}

function getRootFolderId() {
  const id = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!id) throw httpError(500, 'ไม่ได้ตั้งค่า GOOGLE_DRIVE_ROOT_FOLDER_ID — ดูขั้นตอนใน deploy/GOOGLE_DRIVE.md');
  return id;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: creds.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(creds.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

let cachedToken = null; // { accessToken, expiresAt }
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.accessToken;
  const creds = getCredentials();
  const jwt = signJwt(creds);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(502, `เชื่อมต่อ Google Drive ไม่สำเร็จ (ขอ access token ล้มเหลว): ${data.error_description || data.error || res.statusText}`);
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

// จัดหมวดหมู่: root / ปี พ.ศ. / ประเภทหนังสือ — ตรงกับที่โรงเรียนคุ้นเคยจากตู้เอกสารจริง
export async function ensureCategoryFolder({ yearBe, typeName }) {
  const root = getRootFolderId();
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
