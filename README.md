# Ruto AI — Bot WhatsApp

Bot WhatsApp AI berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) (tidak resmi, tanpa perlu WhatsApp Business API). Mendukung 4 provider AI: **ChatGPT (OpenAI)**, **Gemini**, **Mistral**, dan **Anthropic (Claude)** — bisa ganti-ganti kapan saja lewat "ruang kendali".

## ⚠️ Penting soal risiko

Baileys memakai protokol WhatsApp Web tidak resmi. Ini **melanggar ToS WhatsApp** dan nomor bisa kena banned, terutama kalau:
- Membalas banyak pesan sangat cepat
- Dipakai untuk broadcast/spam massal
- Membalas semua pesan di banyak grup tanpa filter

Fitur delay (4–9 detik + indikator "mengetik") di bot ini **mengurangi risiko**, bukan menghilangkannya sama sekali. Pakai nomor sekunder (bukan nomor utama kamu), dan jangan pakai untuk volume pesan sangat tinggi.

## Cara kerja

- **Ruang kendali**: chat ke nomor bot sendiri (menu "Message Yourself" / kirim pesan ke diri sendiri di WhatsApp). Di situ kamu bisa:
  - `ganti api key` → minta PIN (`2485`) → pilih provider → masukkan key baru
  - `ganti provider` → pilih provider mana yang aktif dipakai
  - `cek api key` → lihat status semua key (disamarkan) dan provider aktif
  - `menu` / `help` → lihat semua perintah
- **Chat pribadi (teman)**: bot otomatis membalas semua pesan masuk.
- **Grup**: bot hanya membalas kalau di-tag (@mention), di-reply, atau ada kata "ruto" di pesannya — supaya tidak spam ke semua orang di grup.
- Sebelum membalas, bot menunggu 4–9 detik acak sambil menampilkan status "mengetik..." biar terlihat lebih natural.

## Setup lokal

```bash
npm install
npm start
```

Saat pertama kali jalan, akan muncul **QR code di terminal**. Scan pakai WhatsApp di HP:
`Setelan > Perangkat Tertaut > Tautkan Perangkat`.

Setelah tersambung, sesi login tersimpan di folder `auth_info/` — tidak perlu scan ulang selama folder ini tidak dihapus.

Lalu buka chat ke diri sendiri di WhatsApp dan ketik `ganti api key` untuk mulai isi salah satu API key (minimal satu provider harus diisi supaya bot bisa membalas).

## Deploy ke Railway

1. Push folder ini ke repo GitHub.
2. Di Railway: **New Project → Deploy from GitHub repo**.
3. Start command otomatis terbaca dari `npm start`.
4. **Tambahkan Volume** (Settings → Volumes) dan mount ke `/app/auth_info` dan `/app/data` — supaya sesi login & API key tidak hilang tiap kali redeploy.
5. Buka tab **Deployments → Logs** untuk lihat QR code, lalu scan dari HP.

## Deploy ke Render

1. Push folder ini ke repo GitHub.
2. Render: **New → Web Service**, hubungkan repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Plan gratis Render **tidak punya persistent disk** — sesi login (`auth_info/`) dan `data/config.json` akan hilang tiap restart/redeploy. Untuk penyimpanan permanen, perlu upgrade ke plan berbayar dan tambahkan **Persistent Disk**, mount ke `/opt/render/project/src/auth_info` dan `/opt/render/project/src/data`.
5. Lihat tab **Logs** untuk scan QR code pertama kali.

## Struktur file

```
index.js          → logika utama bot (koneksi WA, ruang kendali, trigger balasan)
lib/config.js      → penyimpanan API key & provider aktif (data/config.json)
lib/ai.js          → pemanggilan API ke OpenAI/Gemini/Mistral/Anthropic
data/config.json   → dibuat otomatis saat pertama jalan
auth_info/         → sesi login WhatsApp (dibuat otomatis)
```

## Ganti nama model AI

Model default per provider ada di `lib/ai.js`:
- OpenAI: `gpt-4o-mini`
- Gemini: `gemini-1.5-flash`
- Mistral: `mistral-small-latest`
- Anthropic: `claude-sonnet-4-6`

Ganti langsung di file itu kalau mau pakai model lain.
