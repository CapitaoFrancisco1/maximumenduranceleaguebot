// Race Control Discord bot.
// Roblox (the DiscordRelay script) POSTs events to  <this server>/event  with the header  x-api-key.
// The bot turns them into messages in your race control channel:
//   * a LIVE STATUS message that is edited in place (session, track status, sectors, pit exit)
//   * a new line for every flag change ("FCY ACTIVE", "YELLOW FLAG - sector 2", ...)
//   * session start / end, pit exit lights, and (optional) penalties / race control messages

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { flagEmbed, statusEmbed, sessionEmbed, pitEmbed, logEmbed } from './format.js';

const env = process.env;
const DRY_RUN = env.DRY_RUN === 'true';                      // prints instead of sending (for testing without Discord)
const TOKEN = env.DISCORD_TOKEN || '';
const CHANNEL_ID = env.CHANNEL_ID || '';
const LOG_CHANNEL_ID = env.LOG_CHANNEL_ID || CHANNEL_ID;
const API_KEY = env.API_KEY || '';
const GUILD_ID = env.GUILD_ID || '';
const PORT = Number(env.PORT || 3000);
const STATUS_MESSAGE = (env.STATUS_MESSAGE ?? 'true') !== 'false';
const LOG_CHANGES = (env.LOG_CHANGES ?? 'true') !== 'false';

const missing = [];
if (!API_KEY) missing.push('API_KEY');
if (!DRY_RUN) {
  if (!TOKEN) missing.push('DISCORD_TOKEN');
  if (!CHANNEL_ID) missing.push('CHANNEL_ID');
}
if (missing.length) {
  console.error('Missing in your .env / environment variables: ' + missing.join(', '));
  process.exit(1);
}

// ---- small persistent state (the id of the live status message) ----------------------------------
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(saved));
  } catch (err) { console.warn('could not save state:', err.message); }
}

// ---- what the race looks like right now ---------------------------------------------------------------
const current = {
  state: 'none', sector: '', sectors: ['none', 'none', 'none'], mode: '', timer: 0, paused: false, countdown: 0,
  pit: { green: false, blue: false, red: false }, by: '', updatedAt: Date.now(),
};

// ---- discord ------------------------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let ready = false;

async function channelOf(id) {
  const ch = await client.channels.fetch(id);
  if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} is not a text channel the bot can see`);
  return ch;
}

// everything that goes to Discord is sent one after the other, in order
let chain = Promise.resolve();
function enqueue(job) {
  chain = chain.then(job).catch((err) => console.error('[discord]', err?.message || err));
}

async function sendEmbed(channelId, embed) {
  if (DRY_RUN) { console.log('[DRY RUN] ->', channelId || '(channel)', JSON.stringify(embed)); return; }
  const ch = await channelOf(channelId);
  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

let statusTimer = null;
function refreshStatus() {
  if (!STATUS_MESSAGE) return;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => enqueue(async () => {
    const embed = statusEmbed(current);
    if (DRY_RUN) { console.log('[DRY RUN] status message ->', JSON.stringify(embed)); return; }
    const ch = await channelOf(CHANNEL_ID);
    if (!saved.statusMessageId) {
      // after a restart on a host that forgets files: find the status message the bot made earlier
      try {
        const recent = await ch.messages.fetch({ limit: 40 });
        const mine = recent.find((m) => m.author.id === client.user.id && m.embeds[0]?.title === 'RACE CONTROL - LIVE STATUS');
        if (mine) { saved.statusMessageId = mine.id; save(); }
      } catch { /* no permission to read history: a new message will be made */ }
    }
    if (saved.statusMessageId) {
      try {
        const msg = await ch.messages.fetch(saved.statusMessageId);
        await msg.edit({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
      } catch { saved.statusMessageId = null; } // deleted by someone: make a new one
    }
    const msg = await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
    saved.statusMessageId = msg.id;
    save();
    try { await msg.pin(); } catch { /* the bot has no "Manage Messages": fine */ }
  }), 800);
}

// ---- events from Roblox -------------------------------------------------------------------------------------
function handleEvent(ev) {
  const now = Date.now();
  switch (ev.type) {
    case 'status': {
      Object.assign(current, {
        state: String(ev.state || 'none').toLowerCase(), sector: String(ev.sector || ''), sectors: Array.isArray(ev.sectors) ? ev.sectors : current.sectors,
        mode: ev.mode ?? current.mode, timer: Number(ev.timer) || 0, paused: ev.paused === true, countdown: Number(ev.countdown) || 0,
        pit: ev.pit ?? current.pit, by: String(ev.by || ''), updatedAt: now,
      });
      if (LOG_CHANGES) enqueue(() => sendEmbed(CHANNEL_ID, flagEmbed(current)));
      refreshStatus();
      break;
    }
    case 'session': {
      current.mode = ev.mode ?? '';
      current.timer = Number(ev.timer) || 0;
      current.paused = false;
      current.updatedAt = now;
      if (LOG_CHANGES) enqueue(() => sendEmbed(CHANNEL_ID, sessionEmbed(ev, now)));
      refreshStatus();
      break;
    }
    case 'pit': {
      current.pit = ev.pit ?? current.pit;
      current.updatedAt = now;
      if (LOG_CHANGES) enqueue(() => sendEmbed(CHANNEL_ID, pitEmbed(ev, now)));
      refreshStatus();
      break;
    }
    case 'log': {
      enqueue(() => sendEmbed(LOG_CHANNEL_ID, logEmbed(ev, now)));
      break;
    }
    case 'hello': {
      console.log(`[roblox] server online: ${String(ev.place || '').slice(0, 60)} (${String(ev.server || '').slice(0, 12)})`);
      refreshStatus();
      break;
    }
    case 'test': {
      enqueue(() => sendEmbed(CHANNEL_ID, { title: '✅  Connection test', description: 'The Roblox server can reach the bot.', color: 0x2ecc71, timestamp: new Date(now).toISOString() }));
      break;
    }
    default:
      return false;
  }
  return true;
}

// ---- http server ------------------------------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway / Render / nginx the real address is in the forwarded header
app.use(express.json({ limit: '32kb' }));

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function authorised(req) {
  return crypto.timingSafeEqual(sha(req.get('x-api-key') || ''), sha(API_KEY));
}

// tiny rate limit: 240 requests per minute per address
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

app.get('/', (_req, res) => res.type('text').send('Race control bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true, discordReady: ready || DRY_RUN }));

app.post('/event', (req, res) => {
  const ip = req.ip;
  hits.set(ip, (hits.get(ip) || 0) + 1);
  if (hits.get(ip) > 240) return res.status(429).json({ ok: false, error: 'slow down' });
  if (!authorised(req)) {
    console.warn('[event] REJECTED: the x-api-key sent by Roblox is not the same as API_KEY on this server');
    return res.status(401).json({ ok: false, error: 'wrong api key' });
  }
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'json body needed' });
  console.log('[event]', req.body.type, req.body.state || req.body.kind || req.body.mode || '');
  if (!handleEvent(req.body)) return res.status(400).json({ ok: false, error: 'unknown event type' });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`HTTP listening on port ${PORT}`));

// ---- start discord -----------------------------------------------------------------------------------------------
process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.message || err));

if (!DRY_RUN) {
  console.log(`Node ${process.version} - connecting to Discord...`);
  console.log(`Settings found: DISCORD_TOKEN=${TOKEN ? 'yes (' + TOKEN.length + ' characters)' : 'NO'}, CHANNEL_ID=${CHANNEL_ID ? 'yes' : 'NO'}, API_KEY=${API_KEY ? 'yes' : 'NO'}, GUILD_ID=${GUILD_ID ? 'yes' : 'no'}`);

  console.log(`DEBUG_DISCORD is ${env.DEBUG_DISCORD === 'true' ? 'ON' : 'OFF (value seen: ' + JSON.stringify(env.DEBUG_DISCORD ?? null) + ')'}`);

  // ---- connection probe: tells exactly WHY the bot does not connect (token / blocked IP / gateway) ----------
  (async () => {
    try {
      const r = await fetch('https://discord.com/api/v10/gateway/bot', { headers: { Authorization: `Bot ${TOKEN}` } });
      const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
      let verdict = '';
      if (r.status === 200) verdict = 'OK: the token is valid and this host can reach Discord';
      else if (r.status === 401) verdict = 'THE DISCORD_TOKEN IS WRONG (reset it in the Developer Portal -> Bot and paste it again, no quotes / spaces)';
      else if (r.status === 429 || r.status === 403 || /1015|cloudflare|banned/i.test(body)) verdict = 'THIS HOST\'S IP ADDRESS IS BLOCKED / RATE LIMITED BY DISCORD (Cloudflare). Redeploy later or use another host';
      console.log(`[probe] discord.com REST -> HTTP ${r.status} - ${verdict} | ${body}`);
    } catch (err) {
      console.error('[probe] cannot reach discord.com at all:', err?.message || err);
    }
    try {
      const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
      const timer = setTimeout(() => { console.error('[probe] gateway.discord.gg: NO ANSWER in 15 s (the websocket connection is blocked from this host)'); try { ws.close(); } catch {} }, 15_000);
      ws.addEventListener('message', (m) => { clearTimeout(timer); console.log('[probe] gateway.discord.gg websocket OK:', String(m.data).slice(0, 60)); ws.close(); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); console.error('[probe] gateway.discord.gg websocket error:', e?.message || 'connection failed'); });
    } catch (err) {
      console.error('[probe] websocket test failed:', err?.message || err);
    }
  })();

  // gateway / network problems used to be silent: now they are printed
  client.on(Events.Error, (err) => console.error('[discord] client error:', err?.message || err));
  client.on(Events.Warn, (msg) => console.warn('[discord] warning:', msg));
  client.on(Events.ShardError, (err) => console.error('[discord] connection error:', err?.message || err));
  client.on(Events.ShardReady, (id) => console.log(`[discord] shard ${id} connected`));
  client.on(Events.ShardDisconnect, (event, id) => console.warn(`[discord] shard ${id} disconnected (code ${event?.code})`));
  client.rest.on('rateLimited', (info) => console.warn(`[discord] RATE LIMITED on ${info.method} ${info.route}: wait ${Math.ceil((info.timeToReset || 0) / 1000)}s (global: ${info.global})`));
  if (env.DEBUG_DISCORD === 'true') client.on(Events.Debug, (msg) => console.log('[discord debug]', msg));

  const watchdog = setInterval(() => {
    if (ready) { clearInterval(watchdog); return; }
    console.error('[discord] still NOT connected to Discord after waiting. Possible reasons: wrong DISCORD_TOKEN on this host, this host\'s IP address is blocked / rate limited by Discord, or an unsupported Node version. Set DEBUG_DISCORD=true to see more.');
  }, 30_000);
  watchdog.unref();

  client.once(Events.ClientReady, async (c) => {
    ready = true;
    console.log(`Logged in as ${c.user.tag} - the bot is in ${c.guilds.cache.size} server(s)`);
    try { await channelOf(CHANNEL_ID); console.log('Race control channel found.'); }
    catch (err) { console.error('CANNOT USE CHANNEL_ID:', err.message, '- is the bot in the server and allowed to see / write in that channel?'); }

    if (GUILD_ID) {
      try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        const cmd = new SlashCommandBuilder().setName('status').setDescription('Show the current race status');
        await rest.put(Routes.applicationGuildCommands(c.user.id, GUILD_ID), { body: [cmd.toJSON()] });
        console.log('/status registered');
      } catch (err) { console.warn('could not register /status:', err.message); }
    }
    refreshStatus();
  });

  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== 'status') return;
    await i.reply({ embeds: [statusEmbed(current)], allowedMentions: { parse: [] } });
  });

  client.login(TOKEN).catch((err) => { console.error('Discord login failed:', err.message); process.exit(1); });
}
