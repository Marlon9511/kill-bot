const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_FILE = './data/config.json';
const OWNERS_FILE = './data/owners.json';
const SESSIONS_DIR = './sessions';

function loadJSON(file, def) {
    try {
        if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { return def; }
}
function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

fs.mkdirSync('./data', { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let config = loadJSON(CONFIG_FILE, { prefix: '!' });
let owners = loadJSON(OWNERS_FILE, { owners: [] });

function getPrefix() { return config.prefix || '!'; }
function getOwners() { return owners.owners || []; }
function isOwner(jid) {
    const num = jid.replace('@s.whatsapp.net', '');
    return getOwners().includes(num);
}
function saveConfig() { saveJSON(CONFIG_FILE, config); }
function saveOwners() { saveJSON(OWNERS_FILE, owners); }

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = {};

async function askQuestion(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

async function connectSession(sessionId) {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        browser: ['GroupBan-Bot', 'Chrome', '1.0.0']
    });

    sessions[sessionId] = sock;

    if (!sock.authState.creds.registered) {
        const phone = await askQuestion(`\n[${sessionId}] Telefonnummer (mit Laendercode, z.B. 4917612345678): `);
        const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
        console.log(`\n[${sessionId}] Pair Code: ${code}`);
        console.log(`[${sessionId}] WhatsApp -> Verknuepfte Geraete -> Geraet verknuepfen -> Nummer eingeben\n`);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log(`[${sessionId}] Verbunden!`);
        } else if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`[${sessionId}] Verbindung getrennt (Code: ${code})`);
            if (shouldReconnect) {
                console.log(`[${sessionId}] Verbinde neu in 5s...`);
                setTimeout(() => connectSession(sessionId), 5000);
            } else {
                console.log(`[${sessionId}] Ausgeloggt.`);
                delete sessions[sessionId];
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            await handleMessage(sock, msg, sessionId);
        }
    });

    return sock;
}

// ─── Message Handler ──────────────────────────────────────────────────────────
async function handleMessage(sock, msg, sessionId) {
    const jid    = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const text   = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text || '';

    const prefix = getPrefix();
    if (!text.startsWith(prefix)) return;

    const args    = text.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    console.log(`[CMD][${sessionId}] ${sender} -> ${prefix}${command} ${args.join(' ')}`);

    const reply = (txt) => sock.sendMessage(jid, { text: txt }, { quoted: msg });

    // !  (nur prefix, kein command)
    if (command === '') {
        return reply(`*GroupBan-Bot V1*\nBy Schwamm`);
    }

    // !ping
    if (command === 'ping') {
        const start = Date.now();
        await reply('Pinging...');
        const latency = Date.now() - start;
        console.log(`[PING][${sessionId}] ${latency}ms`);
        return sock.sendMessage(jid, { text: `Pong!\nLatenz: *${latency}ms*` }, { quoted: msg });
    }

    // !menu
    if (command === 'menu') {
        const p = prefix;
        return reply(
`*GroupBan-Bot V1*
By Schwamm

*BEFEHLE*
${p}           - Bot Info
${p}ping        - Ping + Latenz
${p}menu        - Dieses Menu

*OWNER*
${p}addowner @  - Owner hinzufuegen
${p}delowner @  - Owner entfernen
${p}owners      - Alle Owner zeigen

*BAN*
${p}ban [link]  - Gruppe joinen & verlassen (alle Sessions)

*EINSTELLUNGEN*
${p}setprefix x - Prefix aendern

Prefix: *${p}*
Sessions: *${Object.keys(sessions).length}*`
        );
    }

    // Owner-only
    if (!isOwner(sender)) {
        if (['addowner','delowner','owners','ban','setprefix'].includes(command)) {
            return reply('Nur Owner duerfen diesen Befehl nutzen!');
        }
        return;
    }

    // !owners
    if (command === 'owners') {
        const list = getOwners();
        if (list.length === 0) return reply('Keine Owner gesetzt.');
        return reply(`*Owner Liste:*\n${list.map((o, i) => `${i+1}. +${o}`).join('\n')}`);
    }

    // !addowner
    if (command === 'addowner') {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        let target = mentioned[0]?.replace('@s.whatsapp.net','') || args[0]?.replace(/[^0-9]/g,'');
        if (!target) return reply(`Nutze: ${prefix}addowner @user`);
        if (getOwners().includes(target)) return reply(`+${target} ist bereits Owner!`);
        owners.owners.push(target);
        saveOwners();
        console.log(`[OWNER] Hinzugefuegt: +${target}`);
        return reply(`+${target} wurde als Owner hinzugefuegt!`);
    }

    // !delowner
    if (command === 'delowner') {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        let target = mentioned[0]?.replace('@s.whatsapp.net','') || args[0]?.replace(/[^0-9]/g,'');
        if (!target) return reply(`Nutze: ${prefix}delowner @user`);
        const idx = owners.owners.indexOf(target);
        if (idx === -1) return reply(`+${target} ist kein Owner!`);
        owners.owners.splice(idx, 1);
        saveOwners();
        console.log(`[OWNER] Entfernt: +${target}`);
        return reply(`+${target} wurde als Owner entfernt!`);
    }

    // !setprefix
    if (command === 'setprefix') {
        const newPrefix = args[0];
        if (!newPrefix || newPrefix.length > 3) return reply(`Nutze: ${prefix}setprefix <zeichen>`);
        config.prefix = newPrefix;
        saveConfig();
        console.log(`[CONFIG] Prefix geaendert zu: ${newPrefix}`);
        return reply(`Prefix wurde zu *${newPrefix}* geaendert!`);
    }

    // !ban
    if (command === 'ban') {
        const link = args[0];
        if (!link || !link.includes('chat.whatsapp.com')) {
            return reply(`Nutze: ${prefix}ban https://chat.whatsapp.com/xxxxx`);
        }

        const code = link.split('chat.whatsapp.com/')[1]?.split(/[^a-zA-Z0-9]/)[0];
        if (!code) return reply('Ungueltiger Gruppenlink!');

        const sessionList = Object.keys(sessions);
        if (sessionList.length === 0) return reply('Keine aktiven Sessions!');

        await reply(`Ban gestartet mit *${sessionList.length}* Session(s)...\nLink: ${link}`);
        console.log(`[BAN] Starte -> Code: ${code} | Sessions: ${sessionList.length}`);

        let success = 0;
        let failed  = 0;

        const banPromises = sessionList.map(async (sid) => {
            const s = sessions[sid];
            if (!s) return;
            try {
                console.log(`[BAN][${sid}] Tritt Gruppe bei...`);
                const response = await s.groupAcceptInvite(code);
                const groupJid = typeof response === 'string' ? response : response?.gid;
                console.log(`[BAN][${sid}] Beigetreten: ${groupJid}`);
                await delay(200);
                await s.groupLeave(groupJid);
                console.log(`[BAN][${sid}] Verlassen: ${groupJid}`);
                success++;
            } catch (e) {
                console.log(`[BAN][${sid}] Fehler: ${e.message}`);
                failed++;
            }
        });

        await Promise.all(banPromises);

        console.log(`[BAN] Fertig! Erfolg: ${success} | Fehler: ${failed}`);
        return reply(`Ban abgeschlossen!\nErfolgreich: *${success}*\nFehler: *${failed}*`);
    }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
async function main() {
    console.log('GroupBan-Bot V1 - By Schwamm');
    console.log('================================');

    // Vorhandene Sessions laden
    if (fs.existsSync(SESSIONS_DIR)) {
        const existing = fs.readdirSync(SESSIONS_DIR).filter(f =>
            fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
        );
        if (existing.length > 0) {
            console.log(`Lade vorhandene Sessions: ${existing.join(', ')}`);
            for (const sid of existing) {
                await connectSession(sid);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    // Neue Sessions hinzufuegen
    while (true) {
        const answer = await askQuestion('\nNeue Session hinzufuegen? (j/n): ');
        if (answer.toLowerCase() !== 'j') break;
        const sid = `session_${Date.now()}`;
        console.log(`Erstelle Session: ${sid}`);
        await connectSession(sid);
        await new Promise(r => setTimeout(r, 4000));
    }

    if (Object.keys(sessions).length === 0) {
        console.log('Keine Sessions verbunden. Bot beendet.');
        process.exit(1);
    }

    console.log(`\nBot laeuft mit ${Object.keys(sessions).length} Session(s)!`);
    console.log(`Prefix: ${getPrefix()}`);
    console.log(`Owner: ${getOwners().length > 0 ? getOwners().map(o => '+'+o).join(', ') : 'Keine'}`);
    console.log('================================\n');
}

      console.error('messages.upsert error:', err);
      log(`ERROR: ${(err && err.message) ? err.message : String(err)}`);
    }
  });

  console.log('Sword-art-online-bot gestartet.');
}
startBot();
