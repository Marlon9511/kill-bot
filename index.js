 

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidGroup,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");

// ──────────────────────────────────────────────
// Konfiguration
// ──────────────────────────────────────────────
const CONFIG = {
  prefix: "!",            // Befehlsprefix
  botName: "BaileysBot",
  authDir: "./auth",      // Session-Ordner (wird auto-erstellt)
  // Pairing-Code statt QR? Setze usePairingCode: true
  // und trage deine Nummer ein (Ländervorwahl ohne +, kein + / () / -)
  usePairingCode: false,
  phoneNumber: "4917612345678",
};

// ──────────────────────────────────────────────
// Hilfsfunktionen
// ──────────────────────────────────────────────

/** Extrahiert den Nachrichtentext aus allen gängigen WhatsApp-Payloads */
function getMessageText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

/** Tippt-Indikator senden */
async function sendTyping(sock, jid) {
  await sock.presenceSubscribe(jid);
  await sock.sendPresenceUpdate("composing", jid);
  await new Promise((r) => setTimeout(r, 500));
  await sock.sendPresenceUpdate("paused", jid);
}

// ──────────────────────────────────────────────
// Befehle definieren
// ──────────────────────────────────────────────
const commands = {
  hilfe: {
    description: "Zeigt alle Befehle",
    handler: async (sock, msg, jid) => {
      const list = Object.entries(commands)
        .map(([name, cmd]) => `▸ *${CONFIG.prefix}${name}* – ${cmd.description}`)
        .join("\n");
      await sock.sendMessage(
        jid,
        { text: `🤖 *${CONFIG.botName} – Befehle:*\n\n${list}` },
        { quoted: msg }
      );
    },
  },

  ping: {
    description: "Testet ob der Bot aktiv ist",
    handler: async (sock, msg, jid) => {
      const start = Date.now();
      await sock.sendMessage(
        jid,
        { text: `🏓 Pong! _(${Date.now() - start}ms)_` },
        { quoted: msg }
      );
    },
  },

  uhrzeit: {
    description: "Aktuelle Uhrzeit & Datum",
    handler: async (sock, msg, jid) => {
      const now = new Date().toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        dateStyle: "full",
        timeStyle: "medium",
      });
      await sock.sendMessage(jid, { text: `🕐 *${now}*` }, { quoted: msg });
    },
  },

  wiederhol: {
    description: "Wiederholt deine Nachricht (!wiederhol <text>)",
    handler: async (sock, msg, jid, args) => {
      if (!args.length) {
        return sock.sendMessage(
          jid,
          { text: "❗ Bitte gib einen Text an.\nBeispiel: `!wiederhol Hallo Welt`" },
          { quoted: msg }
        );
      }
      await sock.sendMessage(
        jid,
        { text: `🔁 ${args.join(" ")}` },
        { quoted: msg }
      );
    },
  },

  würfel: {
    description: "Würfelt eine Zahl (!würfel [seiten])",
    handler: async (sock, msg, jid, args) => {
      const seiten = Math.min(Math.max(parseInt(args[0]) || 6, 2), 1000);
      const ergebnis = Math.floor(Math.random() * seiten) + 1;
      await sock.sendMessage(
        jid,
        { text: `🎲 Du hast eine *${ergebnis}* gewürfelt (1–${seiten})` },
        { quoted: msg }
      );
    },
  },

  rechner: {
    description: "Einfacher Rechner (!rechner 2+2)",
    handler: async (sock, msg, jid, args) => {
      try {
        const ausdruck = args.join(" ").replace(/[^0-9+\-*/().% ]/g, "");
        if (!ausdruck) throw new Error("Kein Ausdruck");
        // eslint-disable-next-line no-new-func
        const ergebnis = Function(`"use strict"; return (${ausdruck})`)();
        await sock.sendMessage(
          jid,
          { text: `🧮 *${ausdruck} = ${ergebnis}*` },
          { quoted: msg }
        );
      } catch {
        await sock.sendMessage(
          jid,
          { text: "❗ Ungültiger Ausdruck.\nBeispiel: `!rechner 10 * (3 + 2)`" },
          { quoted: msg }
        );
      }
    },
  },

  flip: {
    description: "Münze werfen",
    handler: async (sock, msg, jid) => {
      const result = Math.random() < 0.5 ? "🪙 Kopf" : "🪙 Zahl";
      await sock.sendMessage(jid, { text: result }, { quoted: msg });
    },
  },
};

// ──────────────────────────────────────────────
// Auto-Antworten (Schlüsselwörter)
// ──────────────────────────────────────────────
const autoReplies = [
  {
    keywords: ["hallo", "hi", "hey", "moin", "guten morgen", "guten tag"],
    reply: () =>
      `👋 Hallo! Schreib *${CONFIG.prefix}hilfe* um alle Befehle zu sehen.`,
  },
  {
    keywords: ["danke", "dankeschön", "thx", "danke schön"],
    reply: () => "😊 Gern geschehen!",
  },
  {
    keywords: ["tschüss", "bye", "ciao", "auf wiedersehen"],
    reply: () => "👋 Tschüss! Bis bald!",
  },
];

// ──────────────────────────────────────────────
// Bot starten
// ──────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`\n🔧 Baileys Version: ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }), // Auf "debug" setzen zum Debuggen
    printQRInTerminal: !CONFIG.usePairingCode,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: false,
  });

  // ── Credentials speichern ──
  sock.ev.on("creds.update", saveCreds);

  // ── Pairing-Code (Alternative zu QR) ──
  if (CONFIG.usePairingCode && !sock.authState.creds.registered) {
    const code = await sock.requestPairingCode(CONFIG.phoneNumber);
    console.log(`\n🔑 Pairing-Code: *${code}*`);
    console.log("   In WhatsApp: Einstellungen > Verknüpfte Geräte > Mit Telefonnummer verknüpfen\n");
  }

  // ── Verbindungsstatus ──
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 QR-Code erscheint oben – bitte mit WhatsApp scannen.\n");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 0;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `❌ Verbindung getrennt (${statusCode}). ${loggedOut ? "Session abgelaufen." : "Reconnect..."}`
      );

      if (!loggedOut) {
        // Automatisch neu verbinden
        setTimeout(startBot, 3000);
      } else {
        console.log("⚠️  Bitte lösche den ./auth Ordner und starte neu.");
        process.exit(1);
      }
    }

    if (connection === "open") {
      console.log(`\n✅ ${CONFIG.botName} ist online und bereit!\n`);
    }
  });

  // ── Nachrichten verarbeiten ──
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Eigene Nachrichten, Status und leere Nachrichten ignorieren
      if (msg.key.fromMe || !msg.message) continue;

      const jid = msg.key.remoteJid;
      const isGroup = isJidGroup(jid);
      const body = getMessageText(msg).trim();

      if (!body) continue;

      // Tippt-Indikator
      await sendTyping(sock, jid);

      // ── Befehle verarbeiten ──
      if (body.startsWith(CONFIG.prefix)) {
        const [rawCmd, ...args] = body.slice(CONFIG.prefix.length).trim().split(/\s+/);
        const cmdName = rawCmd.toLowerCase();

        if (commands[cmdName]) {
          try {
            await commands[cmdName].handler(sock, msg, jid, args);
          } catch (err) {
            console.error(`[Fehler] Befehl "${cmdName}":`, err.message);
            await sock.sendMessage(
              jid,
              { text: "⚠️ Ups, da ist etwas schiefgelaufen." },
              { quoted: msg }
            );
          }
        } else {
          await sock.sendMessage(
            jid,
            {
              text: `❓ Unbekannter Befehl.\nSchreib *${CONFIG.prefix}hilfe* für alle verfügbaren Befehle.`,
            },
            { quoted: msg }
          );
        }
        continue;
      }

      // ── Auto-Antworten (nur Privatnachrichten, nicht in Gruppen) ──
      if (!isGroup) {
        const bodyLower = body.toLowerCase();
        for (const rule of autoReplies) {
          if (rule.keywords.some((kw) => bodyLower.includes(kw))) {
            await sock.sendMessage(jid, { text: rule.reply() }, { quoted: msg });
            break;
          }
        }
      }
    }
  });

  return sock;
}

// ──────────────────────────────────────────────
// Sauberes Beenden mit Ctrl+C
// ──────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n🛑 Bot wird beendet...");
  process.exit(0);
});

// Bot starten
startBot().catch(console.error);