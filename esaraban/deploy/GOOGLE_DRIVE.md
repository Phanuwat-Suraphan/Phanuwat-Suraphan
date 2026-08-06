# เก็บไฟล์แนบใน Google Drive แทน local disk

ใช้ Google Drive (ฟรี 15GB ต่อบัญชี Google) เป็นที่เก็บไฟล์ PDF แทนดิสก์ของเซิร์ฟเวอร์ —
เหมาะมากถ้าใช้ Render free tier (ไม่มี disk ถาวร) เพราะไฟล์จะไม่หายตอน redeploy/sleep อีกต่อไป
ไฟล์จะถูกจัดเก็บเป็นหมวดหมู่อัตโนมัติ: **ปี พ.ศ. → ประเภทหนังสือ** (ตรงกับที่โรงเรียนคุ้นเคยจากตู้เอกสารจริง)

**สำคัญ**: การเชื่อมต่อจริงทดสอบไม่ได้ในสภาพแวดล้อมพัฒนานี้ (เครือข่ายเข้าถึง Google API ไม่ได้ เหมือนที่
เข้าถึง npm/apt ไม่ได้) โค้ดผ่านการตรวจสอบ logic ทุกจุดแล้ว (การสร้าง/เซ็น JWT, การตัดสาขาระหว่าง local/Drive,
การล้มเหลวอย่างสุภาพเมื่อยังไม่ตั้งค่า) แต่ขั้นตอนด้านล่างต้องลองจริงบนเซิร์ฟเวอร์ของคุณเป็นครั้งแรก

## 1. สร้าง Service Account บน Google Cloud

1. ไปที่ <https://console.cloud.google.com/> (ใช้บัญชี Google เดียวกับที่จะเก็บไฟล์ก็ได้ หรือคนละบัญชีก็ได้)
2. สร้างโปรเจกต์ใหม่ (หรือใช้โปรเจกต์เดิม) — ฟรี ไม่มีค่าใช้จ่ายสำหรับ Drive API ในปริมาณการใช้งานระดับโรงเรียน
3. เปิดใช้งาน **Google Drive API**: เมนู ⋮ → **APIs & Services → Library** → ค้นหา "Google Drive API" → **Enable**
4. สร้าง Service Account: **APIs & Services → Credentials → Create Credentials → Service Account**
   - ตั้งชื่อ เช่น `esaraban-storage`
   - ไม่ต้องให้สิทธิ์ระดับโปรเจกต์ใดๆ (กด Continue → Done ได้เลย)
5. เปิด Service Account ที่สร้าง → แท็บ **Keys** → **Add Key → Create new key → JSON** → ดาวน์โหลดไฟล์ JSON
   - ไฟล์นี้คือรหัสลับ **ห้ามใส่ใน git หรือแชร์ให้ใครเห็น**
6. จดอีเมลของ Service Account ไว้ (รูปแบบ `xxx@xxx.iam.gserviceaccount.com` — ดูได้ในไฟล์ JSON ที่ฟิลด์ `client_email`)

## 2. สร้างโฟลเดอร์ใน Google Drive ของคุณเอง แล้วแชร์ให้ Service Account

Service Account ไม่มีพื้นที่ Drive เป็นของตัวเอง (โควตา 0GB) — ต้องใช้พื้นที่ 15GB ในบัญชี Google
ส่วนตัว/บัญชีโรงเรียนของคุณแทน โดยสร้างโฟลเดอร์แล้ว "แชร์" ให้ Service Account เข้าถึงได้:

1. เข้า Google Drive ของบัญชีที่จะใช้เก็บไฟล์ (ควรเป็นบัญชีกลางของโรงเรียน ไม่ใช่บัญชีส่วนตัวครูคนใดคนหนึ่ง)
2. สร้างโฟลเดอร์ใหม่ เช่น `esaraban-documents`
3. คลิกขวา → **แชร์ (Share)** → ใส่อีเมล Service Account จากขั้นตอนที่แล้ว → ให้สิทธิ์ **ผู้แก้ไข (Editor)** → ส่ง
4. เปิดโฟลเดอร์นั้น ดู URL: `https://drive.google.com/drive/folders/XXXXXXXXXXXXXXXXXXXX` — คัดลอกส่วน
   `XXXXXXXXXXXXXXXXXXXX` ไว้ (คือ Folder ID)

## 3. ตั้งค่า Environment Variables บนเซิร์ฟเวอร์

ไม่ว่าจะ deploy ที่ไหน (Render, VPS) ให้ตั้งตัวแปรเหล่านี้เพิ่ม:

| ตัวแปร | ค่า |
|---|---|
| `STORAGE_PROVIDER` | `google_drive` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | เนื้อหาทั้งหมดของไฟล์ JSON จากขั้นตอนที่ 1 (วางทั้งไฟล์เป็นข้อความบรรทัดเดียว) |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Folder ID จากขั้นตอนที่ 2 |

**บน Render**: Dashboard → service → Environment → Add Environment Variable (ทำทีละตัวแปร) →
สำหรับ `GOOGLE_SERVICE_ACCOUNT_JSON` เปิดไฟล์ JSON ด้วยโปรแกรมข้อความ, copy ทั้งหมด, วางในช่องค่า (value)
ได้เลย ไม่ต้องแก้ format

**บน VPS (systemd)**: เพิ่มบรรทัดใน `/etc/systemd/system/esaraban.service` (ดู `DEPLOY.md` ขั้นตอนที่ 4):
```ini
Environment=STORAGE_PROVIDER=google_drive
Environment=GOOGLE_DRIVE_ROOT_FOLDER_ID=XXXXXXXXXXXXXXXXXXXX
Environment=GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"...", ...}
```
แล้ว `sudo systemctl daemon-reload && sudo systemctl restart esaraban`

## 4. ทดสอบ

1. เข้าระบบ ลองรับหนังสือใหม่พร้อมแนบ PDF
2. ถ้าสำเร็จ ไฟล์จะไปโผล่ในโฟลเดอร์ `esaraban-documents/<ปี>/<ประเภทหนังสือ>/` ใน Google Drive ของคุณ
3. ลองกดเปิดไฟล์แนบจากหน้ารายละเอียดเอกสารในระบบ — ควรเปิด PDF ได้ตามปกติ (ระบบดึงไฟล์ผ่านเซิร์ฟเวอร์
   ของเราเสมอ ไม่ได้ลิงก์ตรงไป Drive จึงยังตรวจสิทธิ์ผู้ใช้ตามปกติทุกครั้ง)
4. ถ้าเจอ error "ไม่ได้ตั้งค่า..." หรือ "เชื่อมต่อ Google Drive ไม่สำเร็จ" ให้เช็ค:
   - ตัวแปรทั้ง 3 ตัวถูกตั้งครบและไม่มีช่องว่าง/บรรทัดใหม่แปลกๆ ปนอยู่หรือไม่
   - แชร์โฟลเดอร์ให้อีเมล Service Account ที่ถูกต้องหรือยัง (ต้องเป็นอีเมลแบบ `...iam.gserviceaccount.com`)
   - เปิดใช้งาน Google Drive API ในโปรเจกต์แล้วหรือยัง

## หมายเหตุ

- ไฟล์ที่อัปโหลดไปแล้วด้วยระบบ local disk (ก่อนเปลี่ยนมาใช้ Google Drive) จะยังเปิดได้ตามปกติ — ระบบ
  จำได้ว่าไฟล์ไหนเก็บที่ไหน ไม่จำเป็นต้องย้ายไฟล์เก่า
- การทำลายเอกสารตามขั้นตอนอนุมัติของคณะกรรมการ (หน้า "อายุการเก็บ/ทำลายหนังสือ") จะลบไฟล์ออกจาก
  Google Drive ให้อัตโนมัติเช่นเดียวกับตอนเก็บบน local disk
