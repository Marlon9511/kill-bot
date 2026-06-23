/**
 * WhatsApp Bot - whatsapp-web.js
 * ================================
 * Installation:
 *   npm install whatsapp-web.js qrcode-terminal
 *
 * Starten:
 *   node whatsapp-bot.js
 *
 * Beim ersten Start: QR-Code mit WhatsApp scannen
 * (WhatsApp > Verknüpfte Geräte > Gerät hinzufügen)
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// ──────────────────────────────────────────────
// Konfiguration
// ──────────────────────────────────────────────
const CONFIG = {
  prefix: "!", // Befehlsprefix
  ownerNumber: "49123456789@c.us", // Deine Nummer (Ländervorwahl ohne +)
  botName: "MeinBot",
};

// ──────────────────────────────────────────────
// Befehle definieren
// ──────────────────────────────────────────────
const commands = {
  // !hilfe – zeigt alle Befehle
  hilfe: {
    description: "Zeigt alle verfügbaren Befehle",
    handler: async (msg) => {
      const list = Object.entries(commands)
        .map(([name, cmd]) => `• *${CONFIG.prefix}${name}* – ${cmd.description}`)
        .join("\n");
      await msg.reply(`🤖 *${CONFIG.botName} – Befehle:*\n\n${list}`);
    },
  },

  // !ping – Latenztest
  ping: {
    description: "Testet ob der Bot aktiv ist",
    handler: async (msg) => {
      const start = Date.now();
      const reply = await msg.reply("Pong! 🏓");
      const latency = Date.now() - start;
      await reply.edit(`Pong! 🏓 _(${latency}ms)_`);
    },
  },

  // !info – Chatinfos
  info: {
    description: "Zeigt Infos zum aktuellen Chat",
    handler: async (msg, client) => {
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const text =
        `📋 *Chat-Info*\n` +
        `👤 Name: ${contact.pushname || contact.name || "Unbekannt"}\n` +
        `📱 Nummer: ${contact.number}\n` +
        `💬 Chat-Typ: ${chat.isGroup ? "Gruppe" : "Privat"}\n` +
        (chat.isGroup ? `👥 Mitglieder: ${chat.participants.length}\n` : "");
      await msg.reply(text);
    },
  },

  // !uhrzeit – aktuelle Uhrzeit
  uhrzeit: {
    description: "Zeigt die aktuelle Uhrzeit",
    handler: async (msg) => {
      const now = new Date().toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        dateStyle: "full",
        timeStyle: "medium",
      });
      await msg.reply(`🕐 *${now}*`);
    },
  },

  // !wiederhol <text> – Echo
  wiederhol: {
    description: "Wiederholt deine Nachricht",
    handler: async (msg, _client, args) => {
      if (!args.length) return msg.reply("❗ Bitte gib einen Text an.");
      await msg.reply(`🔁 ${args.join(" ")}`);
    },
  },

  // !würfel [seiten] – Würfelwurf
  würfel: {
    description: "Würfelt eine Zahl (Standard: 1–6)",
    handler: async (msg, _client, args) => {
      const seiten = parseInt(args[0]) || 6;
      if (seiten < 2 || seiten > 1000)
        return msg.reply("❗ Seiten müssen zwischen 2 und 1000 liegen.");
      const ergebnis = Math.floor(Math.random() * seiten) + 1;
      await msg.reply(`🎲 Du hast eine *${ergebnis}* gewürfelt (1–${seiten})`);
    },
  },
};

// ──────────────────────────────────────────────
// Auto-Antworten (Schlüsselwörter)
// ──────────────────────────────────────────────
const autoReplies = [
  {
    keywords: ["hallo", "hi", "hey", "moin", "guten morgen", "guten tag"],
    reply: (name) => `Hallo ${name}! 👋 Schreib *${CONFIG.prefix}hilfe* für alle Befehle.`,
  },
  {
    keywords: ["danke", "dankeschön", "thx", "danke schön"],
    reply: () => "Gern geschehen! 😊",
  },
  {
    keywords: ["tschüss", "bye", "ciao", "auf wiedersehen"],
    reply: (name) => `Tschüss ${name}! 👋 Bis bald!`,
  },
];

// ──────────────────────────────────────────────
// Bot initialisieren
// ──────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "mein-bot" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// QR-Code anzeigen
client.on("qr", (qr) => {
  console.log("\n📱 Scanne diesen QR-Code in WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

// Bereit-Meldung
client.on("ready", () => {
  console.log(`\n✅ ${CONFIG.botName} ist online und bereit!\n`);
});

// Verbindung unterbrochen
client.on("disconnected", (reason) => {
  console.log("❌ Bot getrennt:", reason);
  process.exit(1);
});

// ──────────────────────────────────────────────
// Nachrichten verarbeiten
// ──────────────────────────────────────────────
client.on("message", async (msg) => {
  // Eigene Nachrichten und Status ignorieren
  if (msg.fromMe || msg.isStatus) return;

  const body = msg.body.trim();
  const contact = await msg.getContact();
  const senderName = contact.pushname || contact.name || "Unbekannt";

  // ── Befehle verarbeiten ──
  if (body.startsWith(CONFIG.prefix)) {
    const [rawCmd, ...args] = body.slice(CONFIG.prefix.length).trim().split(/\s+/);
    const cmdName = rawCmd.toLowerCase();

    if (commands[cmdName]) {
      try {
        await commands[cmdName].handler(msg, client, args);
      } catch (err) {
        console.error(`Fehler bei Befehl "${cmdName}":`, err);
        await msg.reply("⚠️ Ein Fehler ist aufgetreten.");
      }
      return;
    } else {
      await msg.reply(
        `❓ Unbekannter Befehl. Schreib *${CONFIG.prefix}hilfe* für alle Befehle.`
      );
      return;
    }
  }

  // ── Auto-Antworten prüfen ──
  const bodyLower = body.toLowerCase();
  for (const rule of autoReplies) {
    if (rule.keywords.some((kw) => bodyLower.includes(kw))) {
      await msg.reply(rule.reply(senderName));
      return;
    }
  }
});

// Bot starten
client.initialize();

// ──────────────────────────────────────────────
// Sauberes Beenden mit Ctrl+C
// ──────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n🛑 Bot wird beendet...");
  await client.destroy();
  process.exit(0);
});