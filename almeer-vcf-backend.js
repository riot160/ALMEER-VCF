/**
 * ╔═══════════════════════════════════════════╗
 * ║        ALMEER VCF — BACKEND SERVER        ║
 * ║   WhatsApp Number + Bot Verifier v4.0     ║
 * ║   Pairing structure cloned from RIOT2     ║
 * ╚═══════════════════════════════════════════╝
 *
 * HOW TO PAIR:
 *   1. Deploy with PAIRING_NUMBER set in env
 *   2. The code will print in logs automatically on first boot
 *   3. OR call: POST /pair  { "phoneNumber": "254712345678" }
 *      to get the code back as JSON + WhatsApp notification
 *
 * ENV VARS:
 *   PORT=3788
 *   PAIRING_NUMBER=254712345678   ← digits only, NO + sign, NO spaces
 *   BOT_PING_ENABLED=false
 *   BOT_PING_TIMEOUT=6000
 *   BOT_PING_MESSAGE=.
 *   SESSION_DIR=./almeer_session
 */

import express        from 'express';
import cors           from 'cors';
import pino           from 'pino';
import { existsSync, mkdirSync } from 'fs';
import { EventEmitter } from 'events';
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

/* ── LOGGER (silent — same as RIOT2) ── */
const logger = pino({ level: 'silent' });

/* ── GLOBAL SESSION STATE (mirrors RIOT2 session object) ── */
const sessionEvents = new EventEmitter();

let sock           = null;
let isConnected    = false;
let linkedNumber   = null;   // auto-detected after connect, just like RIOT2
let pairingCode    = null;   // set when code is generated, cleared on connect
let currentPhone   = null;   // the number pairing was requested for

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
   createSession — CLONED FROM RIOT2 session.js
   ─────────────────────────────────────────
   RIOT2 key points reproduced here:
   1. NO custom browser field (breaks WA pairing)
   2. markOnlineOnConnect: true
   3. requestPairingCode called AFTER makeWASocket
      with a 3 s delay — NOT inside connection.update
   4. pairingMode flag: false on reconnect so code
      is never re-requested after a drop
   5. Auto-detect linkedNumber from sock.user on open
      (same as RIOT2's OWNER_NUMBER auto-set)
══════════════════════════════════════════ */
async function createSession(phoneNumber, pairingMode = true) {
  // Reset state for fresh session
  pairingCode  = null;
  currentPhone = phoneNumber;

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  // ── Build socket — NO browser field, matches RIOT2 exactly ──
  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal:              false,
    markOnlineOnConnect:            true,   // same as RIOT2
    generateHighQualityLinkPreview: true,   // same as RIOT2
    syncFullHistory:                false,  // same as RIOT2
    shouldIgnoreJid:                () => false,
    // ⚠️  NO browser field — RIOT2 omits it and pairing works perfectly
    //     Custom browser strings are known to break WA pairing code flow
  });

  sock.ev.on('creds.update', saveCreds);

  // ── REQUEST PAIRING CODE — exact RIOT2 pattern ──────────────
  // Called right after makeWASocket with a 3 s delay.
  // This is the phase where WA sends a notification to the phone.
  if (pairingMode && !state.creds.registered && phoneNumber) {
    await delay(3000);
    try {
      const raw       = await sock.requestPairingCode(phoneNumber.replace(/[^\d]/g, ''));
      const formatted = raw?.match(/.{1,4}/g)?.join('-') || raw;

      pairingCode = formatted;
      sessionEvents.emit('pairingCode', { code: formatted, phoneNumber });

      // Print to Railway logs — same box style as RIOT2
      console.log(`\n  ┌─────────────────────────────────────┐`);
      console.log(`  │     ALMEER VCF — PAIRING CODE        │`);
      console.log(`  ├─────────────────────────────────────┤`);
      console.log(`  │  Number : ${phoneNumber.padEnd(26)}│`);
      console.log(`  │  Code   : ${formatted.padEnd(26)}│`);
      console.log(`  │  Status : Waiting for verification  │`);
      console.log(`  ├─────────────────────────────────────┤`);
      console.log(`  │  1. Open WhatsApp on your phone      │`);
      console.log(`  │  2. Settings → Linked Devices        │`);
      console.log(`  │  3. Link a Device → Link with number │`);
      console.log(`  │  4. Enter the 8-digit code above     │`);
      console.log(`  └─────────────────────────────────────┘\n`);
    } catch (err) {
      console.error('[ALMEER VCF] ❌ Pairing code error:', err.message);
      sessionEvents.emit('error', { error: err.message });
    }
  }

  // ── Connection events ────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

    if (connection === 'open') {
      isConnected = true;
      pairingCode = null; // clear once linked

      // Auto-detect the linked number — same as RIOT2's owner auto-set
      try {
        const myJid  = sock.user?.id || '';
        linkedNumber = myJid.split(':')[0].split('@')[0].replace(/[^\d]/g, '');
        if (linkedNumber) {
          console.log(`[ALMEER VCF] 👑 Linked number auto-detected: ${linkedNumber}`);
        }
      } catch (e) {
        console.error('[ALMEER VCF] Auto-detect failed:', e.message);
      }

      sessionEvents.emit('connected', { linkedNumber });
      console.log(`[ALMEER VCF] ✅ WhatsApp connected! API ready on port ${PORT}`);
      console.log(`[ALMEER VCF] Bot ping: ${BOT_PING_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    }

    if (connection === 'close') {
      isConnected = false;
      const code        = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;

      sessionEvents.emit('disconnected', { code, loggedOut: isLoggedOut });
      console.log(`[ALMEER VCF] Disconnected. Code: ${code}`);

      if (isLoggedOut) {
        console.log('[ALMEER VCF] Logged out. Delete session folder and redeploy.');
      } else {
        console.log('[ALMEER VCF] 🔄 Reconnecting in 5 s...');
        // pairingMode=false on reconnect — same as RIOT2 (don't re-request code)
        setTimeout(() => createSession(currentPhone, false), 5000);
      }
    }
  });

  // ── Incoming messages for bot-ping ──────────────────────────
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (pendingPings.has(jid)) pendingPings.get(jid)(msg);
    }
  });

  return { pairingCode, phoneNumber };
}

/* ══════════════════════════════════════════
   EXPRESS API
══════════════════════════════════════════ */
const app = express();
app.use(cors());
app.use(express.json());

/* ─────────────────────────────────────────
   GET /health
   Returns connection status + linked number
───────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    connected:    isConnected,
    linkedNumber: linkedNumber || null,
    botPing:      BOT_PING_ENABLED,
  });
});

/* ─────────────────────────────────────────
   POST /pair
   Body: { "phoneNumber": "254712345678" }

   Triggers a new pairing code for the given
   number and waits up to 30 s to return it —
   same pattern as RIOT2's POST /api/pair.
   WhatsApp sends a notification to the phone.
───────────────────────────────────────── */
app.post('/pair', async (req, res) => {
  let { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required' });
  }

  phoneNumber = String(phoneNumber).replace(/[^\d]/g, '');
  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber must contain digits' });
  }

  try {
    // Start a fresh session for this number
    await createSession(phoneNumber, true);

    // Wait up to 30 s for the pairing code — same as RIOT2 server.js
    let waited = 0;
    while (!pairingCode && waited < 30000) {
      await delay(500);
      waited += 500;
    }

    if (!pairingCode) {
      return res.status(504).json({ error: 'Pairing code timeout. Try again.' });
    }

    return res.json({
      success:     true,
      pairingCode: pairingCode,
      phoneNumber: phoneNumber,
      message:     'Enter this code in WhatsApp → Settings → Linked Devices → Link with phone number',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   POST /verify
   Body: { "number": "254712345678" }
   Returns: { number, jid, onWhatsApp, isBot, allowed }
───────────────────────────────────────── */
app.post('/verify', async (req, res) => {
  const { number } = req.body;

  if (!number || typeof number !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid number' });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected. Pair first via POST /pair.' });
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
   BOOT
══════════════════════════════════════════ */
app.listen(PORT, async () => {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║    ALMEER VCF BACKEND — STARTING...   ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`[ALMEER VCF] Port        : ${PORT}`);
  console.log(`[ALMEER VCF] Session     : ${SESSION_DIR}`);
  console.log(`[ALMEER VCF] Bot ping    : ${BOT_PING_ENABLED}`);
  console.log('');

  if (PAIRING_NUMBER) {
    // Auto-pair on boot if PAIRING_NUMBER is set in env
    console.log(`[ALMEER VCF] Auto-pairing → ${PAIRING_NUMBER}`);
    await createSession(PAIRING_NUMBER, true);
  } else {
    console.log('[ALMEER VCF] No PAIRING_NUMBER in env.');
    console.log('[ALMEER VCF] Call POST /pair { "phoneNumber": "254XXXXXXXXX" } to pair.');
    // Start socket in restore mode (no pairing)
    await createSession(null, false);
  }
});
