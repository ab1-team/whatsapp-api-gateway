# WhatsApp API Gateway

Gateway WhatsApp multi-device yang ringan dan anti-spam menggunakan **Node.js**, **Baileys**, **BullMQ (Redis)**, dan **SQLite**.

## Stack

| Komponen | Teknologi |
|---|---|
| WA Library | @whiskeysockets/baileys |
| HTTP Server | Express.js |
| WebSocket | Socket.io |
| Queue | BullMQ + Redis |
| Database | SQLite (better-sqlite3) |
| Logging | Pino |

---

## Instalasi

```bash
# Clone / masuk ke folder
cd whatsapp-api-gateway

# Install dependencies
npm install

# Salin konfigurasi
cp .env.example .env
# → Edit .env: ganti MASTER_API_KEY!

# Jalankan server
npm start
```

> Pastikan Redis berjalan di `localhost:6379` sebelum menjalankan server.

---

## Konfigurasi `.env`

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | 3000 | Port HTTP server |
| `MASTER_API_KEY` | *wajib diisi* | API key untuk operasi admin |
| `REDIS_HOST` | 127.0.0.1 | Host Redis |
| `RATE_LIMIT_MESSAGES` | 20 | Maks pesan/menit per device (queue limiter) |
| `MIN_DELAY_MS` | 1000 | Delay minimum antar pesan (ms) |
| `MAX_DELAY_MS` | 3500 | Delay maksimum antar pesan (ms) |
| `DAILY_MESSAGE_LIMIT` | 500 | Maks pesan/hari per device (0 = tidak terbatas) |

---

## API Reference

### Autentikasi

Semua request membutuhkan `X-API-Key` header.

- **Master Key** → operasi admin (daftar device, list semua device)
- **Device Key** → kirim pesan pada device tertentu

---

### Devices

#### Daftar device baru
```http
POST /api/devices
X-API-Key: {MASTER_KEY}
Content-Type: application/json

{
  "name": "Nama Device",
  "webhook_url": "https://your-app.com/webhook",  // optional
  "webhook_events": ["message"]                   // optional
}
```

**Response:**
```json
{
  "success": true,
  "device": {
    "id": "abc123",
    "name": "Nama Device",
    "api_key": "wag_xxxxxxxxxxxx",
    "status": "connecting"
  }
}
```

#### List semua device
```http
GET /api/devices
X-API-Key: {MASTER_KEY}
```

#### Info device
```http
GET /api/devices/:id
X-API-Key: {MASTER_KEY atau DEVICE_KEY}
```

#### Hapus device (logout + hapus sesi)
```http
DELETE /api/devices/:id
X-API-Key: {MASTER_KEY}
```

#### Restart koneksi device
```http
POST /api/devices/:id/restart
X-API-Key: {MASTER_KEY atau DEVICE_KEY}
```

#### Logout device (tanpa hapus)
```http
POST /api/devices/:id/logout
X-API-Key: {MASTER_KEY atau DEVICE_KEY}
```

#### Update webhook
```http
PATCH /api/devices/:id/webhook
X-API-Key: {MASTER_KEY atau DEVICE_KEY}
Content-Type: application/json

{
  "webhook_url": "https://your-app.com/new-webhook",
  "webhook_events": ["message", "status"]
}
```

#### Log pesan (50 terakhir)
```http
GET /api/devices/:id/logs
X-API-Key: {MASTER_KEY atau DEVICE_KEY}
```

---

### Kirim Pesan

**Semua endpoint kirim pesan membutuhkan `X-API-Key: {DEVICE_KEY}`**

#### Teks
```http
POST /api/send/text
Content-Type: application/json

{
  "device_id": "abc123",
  "to": "628123456789",
  "message": "Halo, ini pesan dari gateway!"
}
```

#### Gambar
```http
POST /api/send/image
{
  "device_id": "abc123",
  "to": "628123456789",
  "url": "https://picsum.photos/800/600",
  "caption": "Caption gambar"
}
```

#### Video
```http
POST /api/send/video
{
  "device_id": "abc123",
  "to": "628123456789",
  "url": "https://example.com/video.mp4",
  "caption": "Caption video"
}
```

#### Dokumen / File
```http
POST /api/send/document
{
  "device_id": "abc123",
  "to": "628123456789",
  "url": "https://example.com/laporan.pdf",
  "filename": "Laporan Bulanan.pdf",
  "mimetype": "application/pdf"
}
```

#### Audio / Voice Note
```http
POST /api/send/audio
{
  "device_id": "abc123",
  "to": "628123456789",
  "url": "https://example.com/audio.mp3",
  "ptt": false
}
```
> Set `"ptt": true` untuk mengirim sebagai voice note (tampilan berbeda di WA).

#### Lokasi
```http
POST /api/send/location
{
  "device_id": "abc123",
  "to": "628123456789",
  "latitude": -6.2088,
  "longitude": 106.8456,
  "name": "Jakarta Pusat",
  "address": "DKI Jakarta, Indonesia"
}
```

#### Kontak (vCard)
```http
POST /api/send/contact
{
  "device_id": "abc123",
  "to": "628123456789",
  "contact_name": "John Doe",
  "contact_phone": "629876543210"
}
```

#### Blast / Bulk (kirim ke banyak nomor - pesan sama)
```http
POST /api/send/bulk
{
  "device_id": "abc123",
  "numbers": ["628123456789", "628987654321"],
  "type": "text",
  "message": "Pesan broadcast ini"
}
```

#### Personalized Messages (pesan berbeda tiap nomor)
```http
POST /api/send/personalized
{
  "device_id": "abc123",
  "messages": [
    { "to": "628123456789", "message": "Halo Budi, tagihan Anda Rp 50.000" },
    { "to": "628987654321", "message": "Halo Ani, tagihan Anda Rp 75.000" }
  ]
}
```
> Setiap nomor menjadi job terpisah di queue. Anti-spam delay berlaku per job.

---

## WebSocket (QR Scanning)

Gunakan Socket.io client untuk menerima QR code secara real-time.

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  query: {
    device_id: 'abc123',
    api_key: 'wag_xxxxxxxxxxxx',
  },
});

socket.on('qr', ({ qr_image }) => {
  // qr_image adalah Data URL base64 (tampilkan dengan <img src={qr_image} />)
  console.log('Scan QR ini:', qr_image);
});

socket.on('status', ({ status }) => {
  console.log('Status:', status);
  // disconnected | connecting | waiting_qr | connected | error
});

socket.on('ready', ({ phone_number }) => {
  console.log('Device terhubung! Nomor:', phone_number);
});
```

---

## Deployment (Docker)

Aplikasi ini sudah dilengkapi dengan `Dockerfile` dan `docker-compose.yml` untuk memudahkan deployment.

### Menjalankan dengan Docker Compose

1.  Pastikan Docker dan Docker Compose sudah terinstal.
2.  Edit file `.env` (isi `MASTER_API_KEY`, `REDIS_PASSWORD`, dll).
3.  Jalankan perintah:
    ```bash
    docker compose up -d
    ```
4.  Aplikasi akan berjalan di port `3000` (atau sesuai konfigurasi `PORT` di `.env`).
5.  Volume `data/` dan `sessions/` akan dibuat secara otomatis untuk persistensi data.

---

## GitHub CI/CD

Aplikasi ini menyertakan workflow GitHub Actions (`.github/workflows/ci.yml`) yang otomatis melakukan:
1.  **Build Check**: Memastikan aplikasi dapat terinstall dengan Node 22.
2.  **Docker Build Check**: Memastikan `Dockerfile` valid dan dapat di-build.

Setiap kali Anda melakukan `push` ke branch `main`, GitHub akan menjalankan pengecekan ini secara otomatis.

---

## Anti-Spam Protection

| Mekanisme | Keterangan |
|---|---|
| **Random Delay** | Setiap pesan mendapat delay 1–3.5 detik secara acak sebelum dikirim |
| **Rate Limiter** | Maks 20 pesan/menit per device (dikonfigurasi via `RATE_LIMIT_MESSAGES`) |
| **Daily Limit** | Maks 500 pesan/hari per device (dikonfigurasi via `DAILY_MESSAGE_LIMIT`) |
| **Queue** | Semua pesan diproses berurutan melalui BullMQ, bukan dikirim langsung |
| **Browser Spoofing** | Baileys dikonfigurasi sebagai WhatsApp Web di macOS |
| **Backoff Reconnect** | Reconnect dengan delay exponential (2s, 4s, 8s… maks 60s) |

---

## Struktur Folder

```
src/
├── config/index.js        # Konfigurasi global
├── utils/logger.js        # Pino logger
├── database/
│   ├── db.js              # Koneksi SQLite
│   └── migrations.js      # Schema & migrasi tabel
├── services/
│   ├── WhatsAppClient.js  # Wrapper Baileys per device
│   ├── DeviceManager.js   # Mengelola semua WhatsApp client
│   └── MessageQueue.js    # BullMQ queue + anti-spam
├── middlewares/
│   ├── auth.js            # API key authentication
│   └── validator.js       # Zod validation helper
├── routes/
│   ├── index.js           # Route aggregator
│   ├── devices.js         # Device CRUD
│   └── messages.js        # Kirim pesan (semua tipe)
├── websocket/
│   └── handler.js         # Socket.io setup & events
└── app.js                 # Entry point
```

---

## Production (PM2)

```bash
npm install -g pm2

pm2 start src/app.js --name wag --interpreter node
pm2 save
pm2 startup
```
