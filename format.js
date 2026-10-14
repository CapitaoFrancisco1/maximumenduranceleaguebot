// Turns what Roblox sends into Discord embeds. No dependencies, so it can be tested on its own.
// Change the wording / emojis / colours here - this is the only file you need to touch for that.

const COLOR = {
  green: 0x2ecc71, yellow: 0xf1c40f, orange: 0xe67e22, red: 0xe74c3c, magenta: 0xe91e8c,
  white: 0xecf0f1, blue: 0x3498db, grey: 0x7f8c8d,
};

export function escapeText(text, max = 1000) {
  return String(text ?? '')
    .replace(/[\\*_`~|>]/g, (c) => '\\' + c)
    .replace(/@/g, '@\u200b') // no pings, ever
    .slice(0, max);
}

// "S1 & S3" / "ALL" (from "DOUBLE - S1 & S3")  ->  "sectors 1 & 3" / "all sectors"
function doubleSectors(sector) {
  const rest = String(sector || '').replace(/^DOUBLE\s*-\s*/i, '').trim();
  if (!rest || /^all$/i.test(rest)) return 'all sectors';
  const nums = rest.replace(/S/gi, '');
  return (rest.includes('&') ? 'sectors ' : 'sector ') + nums;
}
// "SECTOR 2" / "SECTORS 1 & 3" / "ALL SECTORS" -> lower case words
function plainSectors(sector) {
  const s = String(sector || '').trim().toLowerCase();
  return s || 'the track';
}

const secs = (n) => (Number(n) > 0 ? `${Math.ceil(Number(n))}s` : '');

// each entry: emoji, title, detail(s) -> text, color
const STATES = {
  none:      { emoji: '🟢', title: 'TRACK CLEAR',            detail: () => 'All sectors are clear.', color: COLOR.green },
  green:     { emoji: '🟢', title: 'GREEN FLAG',             detail: () => 'Green flag - racing at full speed.', color: COLOR.green },
  fcy_start: { emoji: '🟡', title: 'FCY STARTING',           detail: (s) => (secs(s.countdown) ? `Full Course Yellow starts in ${secs(s.countdown)}.` : 'Full Course Yellow is about to start.'), color: COLOR.yellow },
  fcy:       { emoji: '🟡', title: 'FCY ACTIVE',             detail: () => 'Full Course Yellow - slow down, no overtaking.', color: COLOR.yellow },
  fcy_end:   { emoji: '🟢', title: 'FCY ENDING',             detail: (s) => (secs(s.countdown) ? `Full Course Yellow ends in ${secs(s.countdown)} - get ready to race.` : 'Full Course Yellow is ending - get ready to race.'), color: COLOR.green },
  sc:        { emoji: '🚨', title: 'SAFETY CAR',             detail: () => 'Safety Car deployed - follow it, no overtaking.', color: COLOR.orange },
  sc_unlap:  { emoji: '🚨', title: 'SAFETY CAR - UNLAPPING', detail: () => 'Lapped cars may now unlap themselves.', color: COLOR.orange },
  sc_end:    { emoji: '🚨', title: 'SAFETY CAR ENDING',      detail: () => 'The Safety Car comes in this lap - restart soon.', color: COLOR.orange },
  red:       { emoji: '🔴', title: 'RED FLAG',               detail: () => 'Session suspended - return to the pits.', color: COLOR.red },
  pitclosed: { emoji: '⛔', title: 'PIT EXIT CLOSED',        detail: () => 'The pit exit is closed.', color: COLOR.red },
  slow:      { emoji: '🟣', title: 'SLOW ZONE',              detail: (s) => `Slow zone active in ${plainSectors(s.sector)}.`, color: COLOR.magenta },
  slow_end:  { emoji: '🟣', title: 'SLOW ZONE ENDING',       detail: () => 'The slow zone is ending.', color: COLOR.magenta },
  lastlap:   { emoji: '⚪', title: 'LAST LAP',               detail: () => 'This is the last lap.', color: COLOR.white },
  cheq:      { emoji: '🏁', title: 'CHEQUERED FLAG',         detail: () => 'The session is finished.', color: COLOR.white },
  ss:        { emoji: '🔴', title: 'STANDING START',         detail: () => 'Standing start procedure.', color: COLOR.red },
  rs:        { emoji: '🟢', title: 'ROLLING START',          detail: () => 'Rolling start procedure.', color: COLOR.green },
};

export function describeFlag(s) {
  const state = String(s.state || 'none').toLowerCase();
  if (state === 'yellow') {
    if (/^DOUBLE/i.test(s.sector || '')) {
      return { emoji: '🟡', title: 'DOUBLE YELLOW', detail: `Double yellow flags in ${doubleSectors(s.sector)} - be ready to stop.`, color: COLOR.yellow };
    }
    return { emoji: '🟡', title: 'YELLOW FLAG', detail: `Yellow flag in ${plainSectors(s.sector)} - no overtaking.`, color: COLOR.yellow };
  }
  const def = STATES[state];
  if (!def) {
    return { emoji: '⚑', title: state.replace(/_/g, ' ').toUpperCase(), detail: 'Race control changed the track status.', color: COLOR.grey };
  }
  return { emoji: def.emoji, title: def.title, detail: def.detail(s), color: def.color };
}

const SECTOR_ICON = { none: '🟢', yellow: '🟡', double: '🟡🟡', slow: '🟣' };
const SECTOR_NAME = { none: 'clear', yellow: 'yellow', double: 'double yellow', slow: 'slow zone' };
export function sectorsLine(sectors) {
  const list = Array.isArray(sectors) && sectors.length ? sectors : ['none', 'none', 'none'];
  return list.slice(0, 3).map((v, i) => `S${i + 1} ${SECTOR_ICON[v] ?? '⚪'} ${SECTOR_NAME[v] ?? v}`).join('  ·  ');
}

function clock(total) {
  total = Math.max(0, Math.floor(Number(total) || 0));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function modeName(mode) {
  return mode === 'Race' ? 'Race' : mode === 'Quali' ? 'Qualifying' : 'No session';
}

export function sessionLine(st) {
  if (st.mode !== 'Race' && st.mode !== 'Quali') return '⚪ No session running';
  const icon = st.mode === 'Race' ? '🏁' : '⏱️';
  if (st.paused) return `${icon} **${modeName(st.mode)}** - ⏸ clock stopped at ${clock(st.timer)}`;
  if (!(st.timer > 0)) return `${icon} **${modeName(st.mode)}** - time is up`;
  const ends = Math.floor(st.updatedAt / 1000 + st.timer);
  return `${icon} **${modeName(st.mode)}** - ends <t:${ends}:R> (${clock(st.timer)} left)`;
}

export function pitLine(pit, state) {
  const parts = [];
  if ((pit && pit.red) || state === 'pitclosed') parts.push('🔴 closed');
  if (pit && pit.green) parts.push('🟢 green light');
  if (pit && pit.blue) parts.push('🔵 blue light');
  return parts.length ? parts.join('  ·  ') : '⚪ normal';
}

// the one live message that is edited all the time
export function statusEmbed(st) {
  const d = describeFlag(st);
  return {
    title: 'RACE CONTROL - LIVE STATUS',
    color: d.color,
    fields: [
      { name: 'Session', value: sessionLine(st), inline: false },
      { name: 'Track status', value: `${d.emoji} **${d.title}**\n${d.detail}`, inline: false },
      { name: 'Sectors', value: sectorsLine(st.sectors), inline: false },
      { name: 'Pit exit', value: pitLine(st.pit, st.state), inline: false },
    ],
    footer: { text: 'updates automatically' },
    timestamp: new Date(st.updatedAt).toISOString(),
  };
}

// one line per flag change
export function flagEmbed(st) {
  const d = describeFlag(st);
  const embed = {
    title: `${d.emoji}  ${d.title}`,
    description: d.detail,
    color: d.color,
    timestamp: new Date(st.updatedAt).toISOString(),
  };
  if (st.by) embed.footer = { text: `Race control: ${escapeText(st.by, 60)}` };
  return embed;
}

export function sessionEmbed(ev, now) {
  const mode = ev.mode;
  const length = Number(ev.timer) > 0 ? clock(ev.timer) : '';
  if (mode === 'Race' || mode === 'Quali') {
    return {
      title: `${mode === 'Race' ? '🏁' : '⏱️'}  ${modeName(mode).toUpperCase()} STARTED`,
      description: length ? `Session length: **${length}**` : 'The session is now running.',
      color: COLOR.blue,
      timestamp: new Date(now).toISOString(),
    };
  }
  return { title: '⏹️  SESSION ENDED', description: 'No session is running.', color: COLOR.grey, timestamp: new Date(now).toISOString() };
}

export function pitEmbed(ev, now) {
  const on = [];
  if (ev.pit && ev.pit.green) on.push('🟢 green light ON');
  if (ev.pit && ev.pit.red) on.push('🔴 red steady ON');
  if (ev.pit && ev.pit.blue) on.push('🔵 blue light ON');
  return {
    title: '🚦  PIT EXIT LIGHTS',
    description: on.length ? on.join('\n') : 'All pit exit lights are off.',
    color: COLOR.grey,
    timestamp: new Date(now).toISOString(),
  };
}

const LOG_STYLE = {
  RC:  { icon: '📢', title: 'RACE CONTROL MESSAGE', color: COLOR.blue },
  PEN: { icon: '⚖️', title: 'PENALTY',              color: COLOR.orange },
  INV: { icon: '🔍', title: 'INVESTIGATION',        color: COLOR.yellow },
  TL:  { icon: '🚧', title: 'TRACK LIMITS',         color: COLOR.grey },
};
export function logEmbed(ev, now) {
  const style = LOG_STYLE[ev.kind] ?? { icon: '📋', title: String(ev.kind || 'LOG'), color: COLOR.grey };
  const when = ev.t ? new Date(Number(ev.t) * 1000) : new Date(now);
  return {
    title: `${style.icon}  ${style.title}`,
    description: escapeText(ev.text, 1800),
    color: style.color,
    timestamp: when.toISOString(),
  };
}
