// Race Control Discord bot.
// Roblox (the DiscordRelay script) POSTs events to  <this server>/event  with the header  x-api-key.
// The bot turns them into messages in your race control channel:
//   * a LIVE STATUS message that is edited in place (session, track status, sectors, pit exit)
//   * a new line for every flag change ("FCY ACTIVE", "YELLOW FLAG - sector 2", ...)
//   * start lights: DELAYED START, start aborted, lights out
//   * session start / end, pit exit lights, and (optional) penalties / race control messages

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { flagEmbed, statusEmbed, sessionEmbed, pitEmbed, logEmbed, startEmbed } from './format.js';

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
  pit: { green: false, blue: false, red: false }, by: '', start: '', updatedAt: Date.now(),
};

// ---- discord ------------------------------------------------------------------------------------------
let client = null;            // created by connect() (below), re-created if a login attempt fails
let ready = false;            // true once Discord has accepted the bot
let discordError = '';        // the last reason the connection failed (shown on /health)
let lastEvent = null;         // the last thing Roblox sent (shown on /health)
const startedAt = Date.now();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// events can arrive a few seconds before the bot has finished connecting (Roblox sends "hello" at once): wait for it
async function waitReady(ms = 40_000) {
  const until = Date.now() + ms;
  while (!ready && Date.now() < until) await sleep(250);
  if (!ready) throw new Error('not connected to Discord (message dropped)' + (discordError ? ': ' + discordError : ''));
}

async function channelOf(id) {
  await waitReady();
  const ch = await client.channels.fetch(id);
  if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} is not a text channel the bot can see`);
  return ch;
}

// everything that goes to Discord is sent one after the other, in order
let chain = Promise.resolve();
function enqueue(job) {
  chain = chain.then(() => withTimeout(Promise.resolve().then(job), 60_000, 'Discord request')).catch((err) => console.error('[discord]', err?.message || err));
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
    case 'startlights': {
      // DELAYED START / start aborted / start sequence / lights out (sent by the DiscordRelay script)
      const state = String(ev.state || '').toLowerCase();
      const embed = startEmbed({ ...ev, state }, now);
      if (!embed) return false;
      current.start = (state === 'delayed' || state === 'aborted') ? state : ''; // the live status shows it only while it is up
      current.updatedAt = now;
      if (LOG_CHANGES) enqueue(() => sendEmbed(CHANNEL_ID, embed));
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
app.get('/health', (_req, res) => res.json({
  ok: true,
  discordReady: ready || DRY_RUN,
  discordError: discordError || undefined,       // why the connection to Discord is not working (if it is not)
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  lastEvent,                                      // the last thing Roblox sent: proves Roblox reaches this bot
}));

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
  lastEvent = { type: String(req.body.type), at: new Date().toISOString() };
  if (!handleEvent(req.body)) return res.status(400).json({ ok: false, error: 'unknown event type' });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`HTTP listening on port ${PORT}`));

// ---- start discord -----------------------------------------------------------------------------------------------
process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.message || err));

const LOGIN_TIMEOUT_MS = Number(env.LOGIN_TIMEOUT_MS || 60_000);   // how long one login attempt may take
const RETRY_SCALE = Number(env.RETRY_SCALE || 1);                  // (only for testing: makes the waits between attempts shorter)

function createClient() {
  const c = new Client({ intents: [GatewayIntentBits.Guilds] });

  // gateway / network problems are printed instead of staying silent
  c.on(Events.Error, (err) => console.error('[discord] client error:', err?.message || err));
  c.on(Events.Warn, (msg) => console.warn('[discord] warning:', msg));
  c.on(Events.ShardError, (err) => console.error('[discord] connection error:', err?.message || err));
  c.on(Events.ShardReady, (id) => console.log(`[discord] shard ${id} connected`));
  c.on(Events.ShardDisconnect, (event, id) => console.warn(`[discord] shard ${id} disconnected (code ${event?.code})`));
  c.rest.on('rateLimited', (info) => console.warn(`[discord] RATE LIMITED on ${info.method} ${info.route}: wait ${Math.ceil((info.timeToReset || 0) / 1000)}s (global: ${info.global})`));
  if (env.DEBUG_DISCORD === 'true') c.on(Events.Debug, (msg) => console.log('[discord debug]', msg));

  c.once(Events.ClientReady, async (cl) => {
    ready = true;
    discordError = '';
    console.log(`Logged in as ${cl.user.tag} - the bot is in ${cl.guilds.cache.size} server(s)`);
    try { await channelOf(CHANNEL_ID); console.log('Race control channel found.'); }
    catch (err) { console.error('CANNOT USE CHANNEL_ID:', err.message, '- is the bot in the server and allowed to see / write in that channel?'); }

    if (GUILD_ID) {
      try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        const cmd = new SlashCommandBuilder().setName('status').setDescription('Show the current race status');
        await rest.put(Routes.applicationGuildCommands(cl.user.id, GUILD_ID), { body: [cmd.toJSON()] });
        console.log('/status registered');
      } catch (err) { console.warn('could not register /status:', err.message); }
    }
    refreshStatus();
  });

  c.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== 'status') return;
    await i.reply({ embeds: [statusEmbed(current)], allowedMentions: { parse: [] } });
  });
  return c;
}

// log in; if Discord does not answer (a hosting / network problem) try again with a fresh client instead of waiting for ever
async function connect() {
  const waits = [5, 15, 30, 60, 120];
  console.log(`Node ${process.version} - connecting to Discord...`);
  console.log(`Settings found: DISCORD_TOKEN=${TOKEN ? 'yes (' + TOKEN.length + ' characters)' : 'NO'}, CHANNEL_ID=${CHANNEL_ID ? 'yes' : 'NO'}, API_KEY=${API_KEY ? 'yes' : 'NO'}, GUILD_ID=${GUILD_ID ? 'yes' : 'no'}`);

  for (let attempt = 1; !ready; attempt++) {
    client = createClient();
    console.log(`[discord] login attempt ${attempt}...`);
    try {
      await withTimeout(client.login(TOKEN), LOGIN_TIMEOUT_MS, 'Discord login');
      for (let i = 0; i < 80 && !ready; i++) await sleep(500);          // "ready" follows the login a moment later
      if (ready) return;
      throw new Error('logged in, but the connection never became ready');
    } catch (err) {
      const msg = String(err?.message || err);
      discordError = msg;
      console.error('[discord] login failed:', msg);
      try { await client.destroy(); } catch { /* already closed */ }

      if (/invalid token|TokenInvalid/i.test(msg)) {
        console.error('[discord] The DISCORD_TOKEN is wrong, or it was reset. Copy the NEW token (Developer Portal -> Bot -> Reset Token) into the environment variable DISCORD_TOKEN and redeploy. Not trying again.');
        return;
      }
      if (/disallowed intent|intents/i.test(msg)) {
        console.error('[discord] Discord refused the intents. This bot only needs the default ones - nothing has to be switched on in the Developer Portal. Not trying again.');
        return;
      }
      const wait = waits[Math.min(attempt - 1, waits.length - 1)] * RETRY_SCALE;
      console.error(`[discord] trying again in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

// free hosts put a service to sleep when nobody visits it. KEEP_ALIVE=true makes the bot visit its own /health every 10 minutes
if (env.KEEP_ALIVE === 'true') {
  const self = env.RENDER_EXTERNAL_URL || env.PUBLIC_URL;
  if (self) {
    setInterval(() => { fetch(self.replace(/\/+$/, '') + '/health').catch(() => {}); }, 10 * 60_000).unref();
    console.log('keep-alive on: calling ' + self + '/health every 10 minutes');
  } else {
    console.warn('KEEP_ALIVE=true but RENDER_EXTERNAL_URL / PUBLIC_URL is not set - nothing to ping');
  }
}

// a redeploy stops the old copy: leave Discord cleanly so two copies never run at once
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    try { await client?.destroy(); } catch { /* ignore */ }
    process.exit(0);
  });
}

if (!DRY_RUN) {
  connect().catch((err) => console.error('[discord] connect crashed:', err?.message || err));
}
