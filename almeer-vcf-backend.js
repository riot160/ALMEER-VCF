/**
 * ╔═══════════════════════════════════════════╗
 * ║        ALMEER VCF — BACKEND SERVER        ║
 * ║   WhatsApp Number + Bot Verifier v3.0     ║
 * ║   Pairing rebuilt from RIOT2 structure    ║
 * ╚═══════════════════════════════════════════╝
 *
 * ENV VARS:
 *   PORT=3788
 *   PAIRING_NUMBER=254712345678   ← digits only, NO + sign, NO spaces
 *   BOT_PING_ENABLED=true
 *   BOT_PING_TIMEOUT=6000
 *   BOT_PING_MESSAGE=.
 *   SESSION_DIR=./almeer_session
 */

import express  from 'express';
import cors     from 'cors';
import pino     from 'pino';
import { existsSync, mkdirSync } from 'fs';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

/* ── CONFIG ── */
const PORT             = process.env.PORT             || 3788;
const SESSION_DIR      = process.env.SESSION_DIR      || './almeer_session';
const PAIRING_NUMBER   = (process.env.PAIRING_NUMBER  || '').replace(/[^\d]/g, '');
const BOT_PING_ENABLED = process.env.BOT_PING_ENABLED === 'true';
const BOT_PING_TIMEOUT = parseInt(process.env.BOT_PING_TIMEOUT || '6000');
const BOT_PING_MSG     = process.env.BOT_PING_MESSAGE || '.';

/* ── LOGGER ── */
const logger = pino({ level: 'silent' });

/* ── GLOBAL STATE ── */
let sock        = null;
let isConnected = false;

/* ── ENSURE SESSION FOLDER ── */
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */
const toJid = (num) => `${num.replace(/[^\d]/g, '')}@s.whatsapp.net`;
const delay = (ms)  => new Promise(r => setTimeout(r, ms));

/* ══════════════════════════════════════════
   BOT PING
══════════════════════════════════════════ */
const pendingPings = new Map();

async function pingForBot(jid) {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      pendingPings.delete(jid);
      resolve(false);
    }, BOT_PING_TIMEOUT);

    pendingPings.set(jid, () => {
      clearTimeout(timer);
      pendingPings.delete(jid);
      resolve(true);
    });

    try {
      await sock.sendMessage(jid, { text: BOT_PING_MSG });
    } catch {
      clearTimeout(timer);
      pendingPings.delete(jid);
      resolve(false);
    }
  });
}

/* ══════════════════════════════════════════
   BAILEYS CONNECT  — mirrors RIOT2 structure
   Key fix: pairing code is requested RIGHT
   after makeWASocket(), NOT inside 'open'.
   WhatsApp needs the code during the handshake
   phase; requesting it after 'open' is too late
   and causes infinite 408 timeout loops.
══════════════════════════════════════════ */
async function startSock(isReconnect = false) {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  /* 1️⃣  Create the socket */
  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal:              false,
    markOnlineOnConnect:            false,
    generateHighQualityLinkPreview: false,
    browser: ['ALMEER VCF', 'Chrome', '120.0'],
  });

  /* 2️⃣  Save creds on every update */
  sock.ev.on('creds.update', saveCreds);

  /* 3️⃣  REQUEST PAIRING CODE HERE — same pattern as RIOT2 session.js
          - Only on fresh (unregistered) sessions, not reconnects
          - Wait 3 s after socket init so the WS handshake is ready
          - Strip any non-digit chars from the number just in case     */
  if (!isReconnect && PAIRING_NUMBER && !state.creds.registered) {
    await delay(3000);
    try {
      const code      = await sock.requestPairingCode(PAIRING_NUMBER);
      const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

      console.log('\n  ┌─────────────────────────────────────┐');
      console.log('  │     ALMEER VCF — PAIRING CODE        │');
      console.log('  ├─────────────────────────────────────┤');
      console.log(`  │  Number : ${PAIRING_NUMBER.padEnd(26)}│`);
      console.log(`  │  Code   : ${formatted.padEnd(26)}│`);
      console.log('  ├─────────────────────────────────────┤');
      console.log('  │  1. Open WhatsApp on your phone      │');
      console.log('  │  2. Linked Devices → Link a Device   │');
      console.log('  │  3. Link with phone number           │');
      console.log('  │  4. Enter the 8-digit code above     │');
      console.log('  └─────────────────────────────────────┘\n');
    } catch (err) {
      console.error('[ALMEER VCF] Pairing code error:', err.message);
    }
  }

  /* 4️⃣  Connection lifecycle events */
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

    if (connection === 'open') {
      isConnected = true;
      console.log('[ALMEER VCF] WhatsApp connected successfully!');
      console.log(`[ALMEER VCF] API ready on port ${PORT}`);
      console.log(`[ALMEER VCF] Bot ping: ${BOT_PING_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode  = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[ALMEER VCF] Disconnected. Code: ${statusCode}`);

      if (isLoggedOut) {
        console.log('[ALMEER VCF] Logged out — delete the session folder and restart.');
      } else {
        console.log('[ALMEER VCF] Reconnecting in 5s...');
        setTimeout(() => startSock(true), 5000);
      }
    }
  });

  /* 5️⃣  Incoming messages — used by bot-ping detection */
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (pendingPings.has(jid)) {
        pendingPings.get(jid)(msg);
      }
    }
  });
}

/* ══════════════════════════════════════════
   EXPRESS API
══════════════════════════════════════════ */
const app = express();
app.use(cors());
app.use(express.json());

/* GET /health */
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    connected: isConnected,
    botPing:   BOT_PING_ENABLED,
    number:    PAIRING_NUMBER || 'not set',
  });
});

/* POST /verify
   Body:    { "number": "254712345678" }
   Returns: { number, jid, onWhatsApp, isBot, allowed }
*/
app.post('/verify', async (req, res) => {
  const { number } = req.body;

  if (!number || typeof number !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid number' });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected yet. Check logs for pairing code.' });
  }

  const jid = toJid(number);

  try {
    const [result]   = await sock.onWhatsApp(number.replace(/[^\d]/g, ''));
    const onWhatsApp = !!(result?.exists);

    if (!onWhatsApp) {
      return res.json({ number, jid, onWhatsApp: false, isBot: null, allowed: false });
    }

    let isBot = null;
    if (BOT_PING_ENABLED) isBot = await pingForBot(jid);

    const allowed = BOT_PING_ENABLED ? (onWhatsApp && isBot === true) : onWhatsApp;

    return res.json({ number, jid, onWhatsApp, isBot, allowed });

  } catch (err) {
    console.error('[ALMEER VCF] /verify error:', err.message);
    return res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

/* ══════════════════════════════════════════
   START
══════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║    ALMEER VCF BACKEND — STARTING...   ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`[ALMEER VCF] Port        : ${PORT}`);
  console.log(`[ALMEER VCF] Session     : ${SESSION_DIR}`);
  console.log(`[ALMEER VCF] Pair number : ${PAIRING_NUMBER || 'NOT SET — set PAIRING_NUMBER in env!'}`);
  console.log(`[ALMEER VCF] Bot ping    : ${BOT_PING_ENABLED}`);
  console.log('');
});

startSock(false);
