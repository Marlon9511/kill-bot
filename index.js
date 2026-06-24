 

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidGroup,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

// ──────────────────────────────────────────────
// Konfiguration
// ──────────────────────────────────────────────
const CONFIG = {
  prefix: "!",
  botName: "BaileysBot",
  authDir: "./auth",
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
    reply: () => `👋 Hallo! Schreib *${CONFIG.prefix}hilfe* um alle Befehle zu sehen.`,
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

  
// pair

//=========================//
// Connect Bot + Pairing-Code
//=========================//
async function connectBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false
  });

  if (!sock.authState.creds.registered) {
    let phoneNumber = await question(gradient("#ff0000", "#C00000")("📲 Deine Nummer (inkl. Ländervorwahl, z.B. 49123456789): "));
    phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

    if (!phoneNumber) {
      console.log(chalk.red("❌ Ungültige Telefonnummer!"));
      return;
    }

    console.log(chalk.yellow("⏳ Generiere Pairing-Code... Bitte warten..."));
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(gradient("#00ffcc", "#0099ff")("\n🔑 DEIN PAIRING CODE: " + code + "\n"));
      } catch (error) {
        console.log(chalk.red("❌ Fehler beim Generieren des Pairing-Codes: "), error);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log(chalk.red("❌ Verbindung geschlossen."));
      if (shouldReconnect) {
        console.log(chalk.yellow("🔄 Reconnecte in 5 Sekunden..."));
        setTimeout(connectBot, 5000);
      }
    } else if (connection === "open") {
      console.log(chalk.green("✅ Erfolgreich mit WhatsApp verbunden!"));
      console.log(chalk.green("-----------------------------------------"));
    }
  });

  sock.ev.on("creds.update", saveCreds);
}



// ── Sauberes Beenden mit Ctrl+C ──
process.on("SIGINT", () => {
  console.log("\n🛑 Bot wird beendet...");
  process.exit(0);
});

startBot().catch(console.error);