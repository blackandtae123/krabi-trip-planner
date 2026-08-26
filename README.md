# Krabi Trip Planner — Deploy Guide

## โครงสร้างไฟล์
```
index.html                     ← หน้าเว็บทั้งหมด (frontend)
api/analyze-constraints.js     ← Serverless Function เรียก Claude API จริง (ฝั่งเซิร์ฟเวอร์)
package.json
```

## ขั้นตอน Deploy บน Vercel

### 1. ขอ Anthropic API key
1. ไปที่ https://console.anthropic.com
2. สมัคร/ล็อกอิน → เมนู **Billing** → เติมเครดิต (ต้องมีเครดิตก่อนเรียก API ได้จริง)
3. เมนู **API Keys** → **Create Key** → คัดลอก key ที่ขึ้นต้นด้วย `sk-ant-...` เก็บไว้ (จะเห็นครั้งเดียว)

### 2. Deploy ขึ้น Vercel
1. สร้าง repo บน GitHub แล้ว push โฟลเดอร์นี้ทั้งหมดขึ้นไป
2. ไปที่ https://vercel.com → New Project → เลือก repo นี้ → Deploy (ไม่ต้องแก้ Build settings อะไร เพราะเป็น static + serverless function ธรรมดา)
3. หลัง deploy ครั้งแรกเสร็จ (จะยังเรียก AI ไม่ได้เพราะยังไม่มี key) ไปที่ **Project Settings → Environment Variables**
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (key จากขั้นตอนที่ 1)
   - Environment: เลือกทั้ง Production/Preview/Development
4. กลับไปที่ **Deployments** → กด **Redeploy** (ต้อง redeploy ให้ env var มีผล)
5. เสร็จแล้ว จะได้ลิงก์ เช่น `https://your-project.vercel.app` — ส่งให้คณะกรรมการทดลองใช้งานได้เลย

### 3. ทดสอบว่า AI ทำงานจริง
- เปิดเว็บ → กด AI Filter → กรอกจนถึงข้อ "ข้อจำกัด/ข้อมูลเพิ่มเติม" → พิมพ์เช่น `มีเด็ก 4 ขวบ 1 คน แพ้อาหารทะเล มังสวิรัติ` → กด "สร้างโปรแกรม"
- หน้าผลลัพธ์จะขึ้นข้อความ "🤖 กำลังวิเคราะห์..." สั้นๆ แล้วถ้ามีสถานที่ที่ควรระวัง (เช่น วัดถ้ำเสือ บันได 1,237 ขั้น) จะมีคำเตือนสีน้ำตาลใต้การ์ดนั้น
- เปิดหน้ารายละเอียดสถานที่ (Place Detail) จะเห็นกล่องคำแนะนำร้านอาหารจาก AI เหนือรายชื่อร้าน (ถ้ามีข้อจำกัดด้านอาหารที่เกี่ยวข้อง)

### หมายเหตุสำคัญ
- **ถ้าไม่ได้ตั้งค่า `ANTHROPIC_API_KEY`** แอปยังใช้งานได้ปกติทุกส่วน (ระบบ scoring เดิม, itinerary, ร้านอาหาร) เพียงแต่จะไม่มีคำเตือน/คำแนะนำจาก AI เพิ่มเติม — ออกแบบให้ไม่พังทั้งหน้าถ้า AI เรียกไม่สำเร็จ
- ทุกครั้งที่ผู้ใช้กด "สร้างโปรแกรม" จะมีการเรียก Claude API 1 ครั้ง (มีค่าใช้จ่ายตาม pricing ของ Anthropic) — ถ้าคาดว่าจะมีคนทดลองเยอะ ควรเช็คปริมาณเครดิตใน Billing เป็นระยะ
- รูปภาพสถานที่ดึงจาก Wikimedia Commons ตรงๆ ผ่าน URL ถาวร (`Special:FilePath`) ไม่ต้องเก็บไฟล์ภาพเอง — **"น้ำตกร้อน (Hot Spring)" ยังไม่มีรูปเพราะหารูปที่ยืนยันได้ว่าตรงจุดจริงๆ บน Commons ไม่พบ** แนะนำให้ถ่ายรูปเองแล้วอัปโหลด หรือค้นหาเพิ่มที่ `commons.wikimedia.org/wiki/Category:Khao_Phra_Bang_Khram_Nature_Reserve` แล้วเติมใน `PLACES` (ตัวแปรใน `index.html`, ค้นหา `id: "hot-spring"`)
