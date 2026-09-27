// Polyfill: Baileys expects the Web Crypto API as a global, which some
// Node 18 runtimes don't expose by default (causes "crypto is not defined").
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const {
  getApiKey,
  setApiKey,
  getActiveProvider,
  setActiveProvider,
  getAllKeys,
} = require('./lib/config');
const { askRuto, PROVIDER_NAMES } = require('./lib/ai');

const CONTROL_PIN = '2485';
const PROVIDER_LIST = ['openai', 'gemini', 'mistral', 'anthropic'];

// In-memory state machine for the "control room" flow (self-chat only)
// step: null | 'awaiting_pin' | 'awaiting_provider_for_key' | 'awaiting_apikey' | 'awaiting_active_provider'
let controlState = { step: null, pendingProvider: null };

// Holds the latest raw QR string so the /qr web page can render it as an image
let latestQR = null;
let isConnected = false;

const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;

function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null
  );
}

function maskKey(key) {
  if (!key) return '(belum diset)';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function providerMenuText() {
  return (
    '1. ChatGPT (OpenAI)\n' +
    '2. Gemini\n' +
    '3. Mistral\n' +
    '4. Anthropic (Claude)\n\n' +
    'Balas dengan angka atau nama provider.'
  );
}

function parseProviderInput(text) {
  const t = text.trim().toLowerCase();
  if (t === '1' || t === 'chatgpt' || t === 'openai') return 'openai';
  if (t === '2' || t === 'gemini') return 'gemini';
  if (t === '3' || t === 'mistral') return 'mistral';
  if (t === '4' || t === 'anthropic' || t === 'claude') return 'anthropic';
  return null;
}

async function handleControlRoom(sock, jid, text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (controlState.step === null) {
    if (lower === 'ganti api key') {
      controlState.step = 'awaiting_pin';
      controlState.pendingProvider = null;
      await sock.sendMessage(jid, { text: 'Masukkan PIN terlebih dahulu' });
      return true;
    }

    if (lower === 'ganti provider') {
      const keys = await getAllKeys();
      const available = PROVIDER_LIST.filter((p) => keys[p]);
      if (available.length === 0) {
        await sock.sendMessage(jid, {
          text: 'Belum ada API key yang diset. Ketik "ganti api key" dulu.',
        });
        return true;
      }
      controlState.step = 'awaiting_active_provider';
      await sock.sendMessage(jid, {
        text:
          'Pilih provider yang mau diaktifkan:\n\n' +
          available.map((p) => `- ${PROVIDER_NAMES[p]}`).join('\n') +
          '\n\nBalas dengan nama providernya (contoh: gemini).',
      });
      return true;
    }

    if (lower === 'cek api key') {
      const keys = await getAllKeys();
      const active = await getActiveProvider();
      const lines = PROVIDER_LIST.map(
        (p) => `${p === active ? '➡️' : '  '} ${PROVIDER_NAMES[p]}: ${maskKey(keys[p])}`
      );
      await sock.sendMessage(jid, { text: `Status API key:\n\n${lines.join('\n')}` });
      return true;
    }

    if (lower === 'menu' || lower === 'help') {
      await sock.sendMessage(jid, {
        text:
          'Ruang Kendali Ruto AI\n\n' +
          '- ganti api key : ganti/isi API key salah satu provider\n' +
          '- ganti provider : pilih provider yang aktif dipakai\n' +
          '- cek api key : lihat status semua API key',
      });
      return true;
    }

    return false; // not a control command, let it fall through
  }

  if (controlState.step === 'awaiting_pin') {
    if (trimmed === CONTROL_PIN) {
      controlState.step = 'awaiting_provider_for_key';
      await sock.sendMessage(jid, {
        text: `Provider mana yang mau diganti key-nya?\n\n${providerMenuText()}`,
      });
    } else {
      controlState.step = null;
      await sock.sendMessage(jid, { text: 'PIN salah. Ketik "ganti api key" untuk coba lagi.' });
    }
    return true;
  }

  if (controlState.step === 'awaiting_provider_for_key') {
    const provider = parseProviderInput(trimmed);
    if (!provider) {
      await sock.sendMessage(jid, {
        text: `Tidak dikenali. ${providerMenuText()}`,
      });
      return true;
    }
    controlState.pendingProvider = provider;
    controlState.step = 'awaiting_apikey';
    await sock.sendMessage(jid, {
      text: `Masukkan kode API key untuk ${PROVIDER_NAMES[provider]}`,
    });
    return true;
  }

  if (controlState.step === 'awaiting_apikey') {
    const provider = controlState.pendingProvider;
    await setApiKey(provider, trimmed);
    controlState.step = null;
    controlState.pendingProvider = null;
    await sock.sendMessage(jid, {
      text: `API key ${PROVIDER_NAMES[provider]} berhasil diganti ✅\n\nKetik "ganti provider" kalau mau langsung memakainya.`,
    });
    return true;
  }

  if (controlState.step === 'awaiting_active_provider') {
    const provider = parseProviderInput(trimmed);
    const keys = await getAllKeys();
    if (!provider || !keys[provider]) {
      await sock.sendMessage(jid, {
        text: 'Tidak dikenali atau key provider itu belum diset. Coba lagi.',
      });
      return true;
    }
    await setActiveProvider(provider);
    controlState.step = null;
    await sock.sendMessage(jid, { text: `Provider aktif sekarang: ${PROVIDER_NAMES[provider]} ✅` });
    return true;
  }

  return false;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Menggunakan versi WhatsApp Web: ${version.join('.')} (terbaru: ${isLatest})`);

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing code flow: set PAIR_PHONE_NUMBER in Railway/Render env vars
  // (format: kode negara + nomor, tanpa "+" atau spasi, contoh 6281234567890)
  const pairPhoneNumber = process.env.PAIR_PHONE_NUMBER;
  if (pairPhoneNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairPhoneNumber);
        const formatted = code.match(/.{1,4}/g).join('-');
        console.log('==========================================');
        console.log(`KODE PAIRING: ${formatted}`);
        console.log('Masukkan kode ini di WhatsApp: Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon');
        console.log('==========================================');
      } catch (err) {
        console.error('Gagal minta kode pairing:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !pairPhoneNumber) {
      latestQR = qr;
      console.log('QR baru tersedia. Buka halaman /qr bot ini di browser untuk melihatnya sebagai gambar.');
      qrcodeTerminal.generate(qr, { small: true }); // fallback kalau dijalankan lokal
    }
    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `Koneksi terputus. Status: ${statusCode}. Pesan: ${errorMessage}. Reconnect: ${shouldReconnect}`
      );
      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      } else {
        console.log('Sesi logged out. Hapus folder auth_info lalu deploy ulang untuk scan QR baru.');
      }
    } else if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      console.log('✅ Ruto AI tersambung ke WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const ownJid = jidNormalizedUser(sock.user.id);
    const isSelfChat = jidNormalizedUser(remoteJid) === ownJid;
    const text = extractText(msg);
    if (!text) return;

    // Control room: messages you send to your own "Message Yourself" chat
    if (isSelfChat && msg.key.fromMe) {
      const handled = await handleControlRoom(sock, remoteJid, text);
      if (handled) return;
    }

    // Never respond to our own outgoing messages elsewhere (avoids loops)
    if (msg.key.fromMe) return;

    // In groups: only reply when mentioned, replied to, or keyword "ruto" is used
    if (isGroup) {
      const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const mentioned = mentionedJids.some((j) => jidNormalizedUser(j) === ownJid);
      const repliedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
      const isReplyToBot = repliedParticipant && jidNormalizedUser(repliedParticipant) === ownJid;
      const keywordTrigger = /\bruto\b/i.test(text);
      if (!mentioned && !isReplyToBot && !keywordTrigger) return;
    }

    const provider = await getActiveProvider();
    const apiKey = await getApiKey(provider);
    if (!apiKey) {
      console.log(
        `⚠️  Belum ada API key untuk provider aktif (${provider}). Set lewat ruang kendali: "ganti api key"`
      );
      return;
    }

    try {
      await sock.sendPresenceUpdate('composing', remoteJid);
      await sleep(randomDelay());
      const reply = await askRuto(provider, apiKey, text);
      await sock.sendPresenceUpdate('paused', remoteJid);
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
    } catch (err) {
      console.error('Gagal membalas pesan:', err.message);
    }
  });
}

// Minimal web server: Railway/Render (web service plans) expect a bound port,
// and this also serves the QR code as an actual image at /qr
const app = express();

app.get('/', (req, res) => res.send('Ruto AI is running'));

app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(
      '<h2 style="font-family:sans-serif">✅ Bot sudah tersambung ke WhatsApp. Tidak perlu scan lagi.</h2>'
    );
  }
  if (!latestQR) {
    return res.send(
      '<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding-top:40px">' +
        '<h2>Belum ada QR. Menyiapkan koneksi...</h2><p>Halaman ini refresh otomatis tiap 5 detik.</p></body></html>'
    );
  }
  try {
    const dataUrl = await QRCode.toDataURL(latestQR, { width: 320 });
    res.send(
      '<html><head><meta http-equiv="refresh" content="20"></head><body style="font-family:sans-serif;text-align:center;padding-top:20px">' +
        '<h2>Scan QR ini dengan WhatsApp</h2>' +
        '<p>Setelan &gt; Perangkat Tertaut &gt; Tautkan Perangkat</p>' +
        `<img src="${dataUrl}" style="width:320px;height:320px;border:8px solid white" />` +
        '<p style="color:gray">Halaman ini refresh otomatis tiap 20 detik (QR WhatsApp berganti berkala).</p>' +
        '</body></html>'
    );
  } catch (err) {
    res.status(500).send('Gagal membuat gambar QR: ' + err.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web server jalan di port ${port}`));

startBot();
