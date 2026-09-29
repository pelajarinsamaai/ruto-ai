// Polyfill: Baileys expects the Web Crypto API as a global, which some
// Node 18 runtimes don't expose by default (causes "crypto is not defined").
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidDecode,
  fetchLatestBaileysVersion,
  generateMessageID,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
// ── Konfigurasi (dulu di lib/config.js, sekarang digabung di sini) ──────────
// Sengaja digabung supaya bot tidak bergantung pada file lib/config.js lagi.
const fsp = require('fs/promises');
const pathLib = require('path');

console.log('[versi-kode] index.js mandiri v4 (config digabung) 2026-09-28');

const DATA_DIR = process.env.DATA_DIR || pathLib.join(__dirname, 'data');
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info';
const CONFIG_PATH = pathLib.join(DATA_DIR, 'config.json');
const VALID_PROVIDERS_CFG = ['openai', 'gemini', 'mistral', 'anthropic'];
const DEFAULT_CONFIG = {
  activeProvider: 'mistral',
  apiKeys: { openai: null, gemini: null, mistral: null, anthropic: null },
};
const ENV_KEY_NAMES = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

async function readConfig() {
  let parsed = {};
  try {
    parsed = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf-8'));
  } catch {
    // file belum ada / rusak: pakai default
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(parsed.apiKeys || {}) },
  };
}

async function writeConfig(config) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getApiKey(provider) {
  const config = await readConfig();
  const envName = ENV_KEY_NAMES[provider];
  return config.apiKeys[provider] || (envName && process.env[envName]) || null;
}

async function setApiKey(provider, key) {
  const config = await readConfig();
  config.apiKeys[provider] = key;
  await writeConfig(config);
}

async function getActiveProvider() {
  const envProvider = process.env.ACTIVE_PROVIDER;
  if (envProvider && VALID_PROVIDERS_CFG.includes(envProvider)) return envProvider;
  const config = await readConfig();
  return config.activeProvider;
}

async function setActiveProvider(provider) {
  const config = await readConfig();
  config.activeProvider = provider;
  await writeConfig(config);
}

async function getAllKeys() {
  const config = await readConfig();
  return config.apiKeys;
}
// ─────────────────────────────────────────────────────────────────────────
const { askRuto, PROVIDER_NAMES } = require('./lib/ai');

const CONTROL_PIN = '2485';
const PROVIDER_LIST = ['openai', 'gemini', 'mistral', 'anthropic'];

// In-memory state machine for the "control room" flow (self-chat only)
// step: null | 'awaiting_pin' | 'awaiting_provider_for_key' | 'awaiting_apikey' | 'awaiting_active_provider'
let controlState = { step: null, pendingProvider: null };

// Holds the latest raw QR string so the /qr web page can render it as an image
let latestQR = null;
let isConnected = false;

// WhatsApp now often reports our own chat (and others') using a privacy ID
// ("@lid") instead of the phone-number JID ("@s.whatsapp.net"). We resolve
// our own LID once connected so self-chat/mention detection stays correct.
let ownLid = null;

// Compares just the "user" portion of two JIDs (safe across @lid/@s.whatsapp.net
// and device-suffix differences), per Baileys' own JID-handling guidance.
function sameJidUser(jidA, jidB) {
  if (!jidA || !jidB) return false;
  const a = jidDecode(jidA);
  const b = jidDecode(jidB);
  return !!(a && b && a.user === b.user);
}

// ID semua pesan yang dikirim bot sendiri, supaya di self-chat bot tidak
// membalas balasannya sendiri (loop tak berujung).
const botSentIds = new Set();

// Footer kecil di bawah balasan AI (huruf superscript = tampil kecil & pudar)
const BOT_FOOTER = '\n\n_ᵈᵃʳⁱ ᴿᵘᵗᵒ ᵇᵒᵗ ᶜʰᵃᵗ_';

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
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly === CONTROL_PIN) {
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Menggunakan versi WhatsApp Web: ${version.join('.')} (terbaru: ${isLatest})`);

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Tandai setiap pesan keluar dari bot dengan ID yang kita catat sendiri
  const origSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options = {}) => {
    const id = options.messageId || generateMessageID();
    botSentIds.add(id);
    setTimeout(() => botSentIds.delete(id), 10 * 60 * 1000);
    return origSendMessage(jid, content, { ...options, messageId: id });
  };

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

  sock.ev.on('connection.update', async (update) => {
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
      console.log('Info akun (debug):', JSON.stringify(sock.user));
      // Cari LID akun sendiri dari beberapa sumber (urut dari yang paling andal)
      ownLid = null;
      const candidates = [
        ['sock.user.lid', () => sock.user?.lid],
        ['creds.me.lid', () => sock.authState?.creds?.me?.lid],
        ['env OWN_LID', () => process.env.OWN_LID],
        [
          'lidMapping',
          () => sock.signalRepository.lidMapping.getLIDForPN(jidNormalizedUser(sock.user.id)),
        ],
      ];
      for (const [name, fn] of candidates) {
        try {
          const val = await fn();
          if (val) {
            ownLid = val;
            console.log(`LID akun sendiri ditemukan (${name}): ${ownLid}`);
            break;
          }
        } catch (err) {
          console.log(`LID lewat ${name} gagal: ${err.message}`);
        }
      }
      if (!ownLid) {
        console.log('⚠️  LID akun sendiri TIDAK ketemu. Set variable OWN_LID di Railway (contoh: 12345678901234@lid).');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message) return;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const ownJid = sock.user.id;
      const isSelfChat =
        !isGroup && (sameJidUser(remoteJid, ownJid) || (ownLid && sameJidUser(remoteJid, ownLid)));
      const text = extractText(msg);

      console.log(
        `[pesan masuk] remoteJid=${remoteJid} ownJid=${ownJid} ownLid=${ownLid} fromMe=${msg.key.fromMe} isSelfChat=${isSelfChat} text=${JSON.stringify(
          text
        )}`
      );

      if (!text) return;

      // Abaikan pesan yang dikirim bot sendiri (anti-loop)
      if (botSentIds.has(msg.key.id)) return;

      // Control room: messages you send to your own "Message Yourself" chat
      if (isSelfChat && msg.key.fromMe) {
        const handled = await handleControlRoom(sock, remoteJid, text);
        if (handled) return;
      }

      // Pesan dari kita sendiri di chat lain/grup: abaikan.
      // Tapi di self-chat ("Message Yourself"), bot tetap membalas seperti biasa.
      if (msg.key.fromMe && !isSelfChat) return;

      // In groups: only reply when mentioned, replied to, or keyword "ruto" is used
      if (isGroup) {
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const mentioned = mentionedJids.some(
          (j) => sameJidUser(j, ownJid) || (ownLid && sameJidUser(j, ownLid))
        );
        const repliedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        const isReplyToBot =
          repliedParticipant &&
          (sameJidUser(repliedParticipant, ownJid) || (ownLid && sameJidUser(repliedParticipant, ownLid)));
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

      await sock.sendPresenceUpdate('composing', remoteJid);
      await sleep(randomDelay());
      const reply = await askRuto(provider, apiKey, text);
      await sock.sendPresenceUpdate('paused', remoteJid);
      await sock.sendMessage(remoteJid, { text: reply + BOT_FOOTER }, { quoted: msg });
    } catch (err) {
      console.error('Gagal memproses pesan:', err.message);
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
app.get('/version', (req, res) => {
  res.json({
    kode: '[versi-kode] index.js mandiri v4 (config digabung) 2026-09-28',
    getActiveProvider_ada: typeof getActiveProvider === 'function',
    getAllKeys_ada: typeof getAllKeys === 'function',
    waktu_server: new Date().toISOString(),
  });
});

app.listen(port, () => console.log(`Web server jalan di port ${port}`));

startBot();
