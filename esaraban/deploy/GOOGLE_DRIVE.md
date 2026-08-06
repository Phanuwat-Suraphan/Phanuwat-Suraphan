# เก็บไฟล์แนบใน Google Drive แทน local disk

ใช้ Google Drive (ฟรี 15GB ต่อบัญชี Google) เป็นที่เก็บไฟล์ PDF แทนดิสก์ของเซิร์ฟเวอร์ —
เหมาะมากถ้าใช้ Render free tier (ไม่มี disk ถาวร) เพราะไฟล์จะไม่หายตอน redeploy/sleep อีกต่อไป
ไฟล์จะถูกจัดเก็บเป็นหมวดหมู่อัตโนมัติในโฟลเดอร์ "ระบบสารบรรณอิเล็กทรอนิกส์ (esaraban)": **ปี พ.ศ. →
ประเภทหนังสือ** (ตรงกับที่โรงเรียนคุ้นเคยจากตู้เอกสารจริง)

## ⚠️ แก้ไขจากเวอร์ชันก่อนหน้า: ทำไมต้องเปลี่ยนวิธี

เวอร์ชันแรกของฟีเจอร์นี้ใช้ **Service Account** ซึ่งพังจริงเมื่อใช้งาน — ขึ้น error
`Service Accounts do not have storage quota` เพราะ Service Account ไม่มีโควตาพื้นที่เก็บข้อมูล
เป็นของตัวเองบนบัญชี Gmail ทั่วไป (ต้องเป็น Google Workspace ถึงจะมี Shared Drive ให้ใช้ได้)
เวอร์ชันนี้เปลี่ยนมาใช้ **OAuth2 เชื่อมต่อบัญชี Google จริงของคุณ** แทน — ไฟล์จะนับพื้นที่ในโควตา
15GB ปกติของบัญชีนั้นเลย ใช้ได้กับ Gmail ทั่วไปไม่ต้องมี Workspace และ **setup ง่ายกว่าเดิมด้วย**
(ไม่ต้องสร้าง/แชร์โฟลเดอร์เอง แอปสร้างโฟลเดอร์ของตัวเองอัตโนมัติ)

## 1. สร้าง OAuth Client บน Google Cloud

1. ไปที่ <https://console.cloud.google.com/> สร้างโปรเจกต์ใหม่ (หรือใช้โปรเจกต์เดิม) — ฟรี
2. เปิดใช้งาน **Google Drive API**: เมนู ⋮ → **APIs & Services → Library** → ค้นหา "Google Drive
   API" → **Enable**
3. ตั้งค่า OAuth consent screen ก่อน (ครั้งแรกเท่านั้น): **APIs & Services → OAuth consent
   screen** → เลือก **External** → กรอกชื่อแอป/อีเมลติดต่อ → ในขั้น **Scopes** ไม่ต้องเพิ่มอะไร
   (แอปจะขอ scope ตอน consent จริงเอง) → ในขั้น **Test users** เพิ่มอีเมล Gmail ของบัญชีที่จะใช้
   เก็บไฟล์ (สำคัญ — ถ้าไม่เพิ่ม จะเชื่อมต่อไม่ได้เพราะแอปยังอยู่ในโหมดทดสอบ)
4. สร้าง OAuth Client: **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: เพิ่ม `https://<โดเมนเว็บของคุณ>/admin/google-drive/callback`
     (เช่น `https://esaraban.onrender.com/admin/google-drive/callback` — ต้องตรงกับโดเมนจริงที่
     deploy ไว้เป๊ะๆ รวม https/http ด้วย)
   - กด Create แล้วจะได้ **Client ID** และ **Client Secret**

## 2. ตั้งค่า Environment Variables

| ตัวแปร | ค่า |
|---|---|
| `STORAGE_PROVIDER` | `google_drive` |
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID จากขั้นตอนที่ 1 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client Secret จากขั้นตอนที่ 1 |

ตั้ง 3 ตัวนี้ก่อน แล้ว deploy/redeploy หนึ่งครั้ง (ยังไม่ต้องมี `GOOGLE_OAUTH_REFRESH_TOKEN` — ได้
มาจากขั้นตอนถัดไป)

**บน Render**: Dashboard → service → Environment → Add Environment Variable

**บน VPS (systemd)**: เพิ่มใน `/etc/systemd/system/esaraban.service` (ดู `DEPLOY.md` ขั้นตอนที่ 4)
แล้ว `sudo systemctl daemon-reload && sudo systemctl restart esaraban`

## 3. เชื่อมต่อบัญชี Google (ทำในเว็บ ไม่ต้องใช้เทอร์มินัล)

1. ล็อกอินเข้าเว็บด้วยบัญชี **admin**
2. ไปที่เมนู **"เชื่อมต่อ Google Drive"** (หรือ URL `/admin/google-drive`)
3. กด **"เชื่อมต่อบัญชี Google"** → ล็อกอิน/ยืนยันตัวตนกับ Google → กด **อนุญาต**
4. หน้าจะแสดงค่า `GOOGLE_OAUTH_REFRESH_TOKEN` ให้คัดลอก — เอาไปตั้งเป็น environment variable
   ตัวที่ 4 บนเซิร์ฟเวอร์ แล้ว redeploy อีกครั้ง (ค่านี้เป็นความลับ ห้ามแชร์ให้ใครเห็น)
5. เสร็จแล้ว — ลองรับหนังสือใหม่พร้อมแนบ PDF ดู ควรอัปโหลดสำเร็จ

## 4. ทดสอบ

1. รับหนังสือใหม่พร้อมแนบ PDF
2. ไฟล์ควรไปโผล่ในโฟลเดอร์ `ระบบสารบรรณอิเล็กทรอนิกส์ (esaraban)/<ปี>/<ประเภทหนังสือ>/` ใน
   Google Drive ของบัญชีที่เชื่อมต่อ (ไม่ใช่โฟลเดอร์ที่คุณสร้างเอง — แอปสร้างโฟลเดอร์นี้ให้อัตโนมัติ)
3. กดเปิดไฟล์แนบจากหน้ารายละเอียดเอกสาร — ควรเปิด PDF ได้ตามปกติ (ระบบดึงไฟล์ผ่านเซิร์ฟเวอร์เสมอ
   ไม่ได้ลิงก์ตรงไป Drive จึงยังตรวจสิทธิ์ผู้ใช้ตามปกติทุกครั้ง)

หากเจอ error ให้เช็ค:
- **"ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID..."** — ยังไม่ได้ตั้ง 2 ตัวแรกหรือยังไม่ redeploy
- **"ยังไม่ได้เชื่อมต่อ Google Drive"** — ยังไม่ได้ทำขั้นตอนที่ 3 หรือยังไม่ได้ตั้ง
  `GOOGLE_OAUTH_REFRESH_TOKEN`
- **redirect_uri_mismatch** จาก Google — Authorized redirect URI ในขั้นตอนที่ 1 ไม่ตรงกับโดเมนจริง
  เป๊ะๆ (เช็ค https/http และไม่มี `/` ท้ายเกิน)
- **access_denied / ไม่มีชื่อในรายชื่อผู้ทดสอบ** — ลืมเพิ่มอีเมลเป็น Test user ในขั้นตอนที่ 1.3
- เชื่อมต่อใหม่แล้วไม่ได้ `refresh_token` กลับมา (เคยยินยอมไปแล้วรอบก่อน) — ไปที่
  <https://myaccount.google.com/permissions> เพิกถอนสิทธิ์แอปนี้ก่อน แล้วเชื่อมต่อใหม่

## หมายเหตุ

- ไฟล์ที่อัปโหลดไปแล้วด้วยระบบ local disk (ก่อนเปลี่ยนมาใช้ Google Drive) จะยังเปิดได้ตามปกติ —
  ระบบจำได้ว่าไฟล์ไหนเก็บที่ไหน ไม่จำเป็นต้องย้ายไฟล์เก่า
- การทำลายเอกสารตามขั้นตอนอนุมัติของคณะกรรมการ (หน้า "อายุการเก็บ/ทำลายหนังสือ") และการลบเอกสาร
  โดยแอดมิน จะลบไฟล์ออกจาก Google Drive ให้อัตโนมัติเช่นเดียวกับตอนเก็บบน local disk
- ใช้ scope `drive.file` (แคบที่สุดเท่าที่ทำได้) — แอปเข้าถึงได้เฉพาะไฟล์ที่แอปสร้างขึ้นเอง ไม่เห็น
  ไฟล์อื่นในบัญชี Google Drive ของคุณเลย
