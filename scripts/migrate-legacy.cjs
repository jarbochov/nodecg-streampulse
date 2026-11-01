#!/usr/bin/env node
'use strict';
// Copies the legacy 4s7p-event chat commands, donation alert rules and large-donation chat announcement into StreamPulse through its HTTP API.
// Usage: node scripts/migrate-legacy.cjs [--dry-run] [--force] [--api http://127.0.0.1:3000] [--db path] [--assets dir] [--cfg cfg/4s7p-event.json]
// Idempotent: alert rules use ids "nodecg-<legacy id>", timed messages "nodecg-<name>", media "nodecg-<file>".
// Commands are matched by name; an existing command with different content is left alone unless --force.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const DB = opt('db', path.join(ROOT, 'db', 'nodecg.sqlite3'));
const ASSETS = opt('assets', path.join(ROOT, 'assets', '4s7p-event'));
const LEGACY_CFG = opt('cfg', path.join(ROOT, 'cfg', '4s7p-event.json'));
const API = String(opt('api', process.env.STREAMPULSE_API || 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const CACHE = path.join(__dirname, '..', '.migrate-cache');
if (API.startsWith('https:') && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const notes = [];
const note = text => notes.push(text);

function readReplicant(name) {
    let raw;
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(DB, { readOnly: true });
        raw = db.prepare('SELECT value FROM replicant WHERE namespace = ? AND name = ?').get('4s7p-event', name)?.value;
        db.close();
    } catch (err) {
        if (err.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && err.code !== 'MODULE_NOT_FOUND') throw err;
        raw = execFileSync('sqlite3', ['-readonly', DB, `SELECT value FROM replicant WHERE namespace='4s7p-event' AND name='${name}'`], { encoding: 'utf8' }).trim();
    }
    return raw ? JSON.parse(raw) : null;
}

async function api(method, pathname, body, headers = {}) {
    const res = await fetch(API + pathname, {
        method,
        headers: Buffer.isBuffer(body) ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${await res.text()}`);
    return res.json();
}

// ---- Chat commands -------------------------------------------------------
const chat = readReplicant('chatCommands') || {};
const resp = chat.responses || {};
const repKeys = new Set();
const rep = key => { repKeys.add(key.split('.').slice(0, 2).join('.')); return `{{rep.${key}}}`; };
const VARS = {
    total: () => rep('nodecg-tiltify.total').replace('}}', '|money}}'),
    goal: () => rep('nodecg-tiltify.campaignGoal').replace('}}', '|money}}'),
    current_game: () => rep('4s7p-event.scheduleData.current.title'),
    current_system: () => rep('4s7p-event.scheduleData.current.system'),
    campaign: () => rep('nodecg-tiltify.campaign.name'),
    donate_url: () => resp.donate_url || 'https://4score7pongs.com/donate',
    schedule_url: () => resp.schedule_url || 'https://4score7pongs.com/schedule'
};
for (const [k, v] of Object.entries(chat.customVariables || {})) if (v) VARS[k] = () => v;
function convert(text, where) {
    return String(text || '').replace(/\{(\w+)\}/g, (m, key) => {
        if (VARS[key]) return VARS[key]();
        note(`${where}: variable {${key}} has no StreamPulse equivalent; left as text`);
        return m;
    });
}
const access = (cmd, where) => {
    if (cmd.permission === 'mods') return 'mods';
    if (cmd.permission === 'restricted') { note(`${where}: "restricted" (allowed users ${(cmd.allowedUsers || []).join(', ') || 'none'}) mapped to mods`); return 'mods'; }
    return 'everyone';
};

const BUILTIN_TEMPLATES = {
    total: 'Donation total: {total}',
    goal: 'Campaign goal: {total} / {goal}',
    current: 'Now playing: {current_game} ({current_system})',
    donate: `${resp.donate_message || 'Donate here:'} {donate_url}`
};
// Replies computed by extension/legacy-commands.js and published as {{rep.streampulse.cmd.<name>}}.
for (const name of ['schedule', 'recent', 'gamestats', 'host', 'commentators', 'players']) BUILTIN_TEMPLATES[name] = `{{rep.streampulse.cmd.${name}}}`;
const BUILTIN_ALIASES = { host: ['hosts'], commentators: ['commentator'], players: ['player'] };

const commands = [];
const messages = [];
const skipped = [];
const wantAutofire = (name, cmd, text) => {
    if (!cmd.autofire?.enabled || cmd.enabled === false) return;
    messages.push({ id: `nodecg-${name}`.slice(0, 20), name: `NodeCG !${name}`, enabled: true, kind: 'interval', every: Math.max(1, Math.round((cmd.autofire.interval || 1800) / 60)), minChat: 1, text });
};

for (const name of ['schedule', 'current', 'total', 'goal', 'donate', 'recent', 'gamestats', 'host', 'commentators', 'players']) {
    const b = (chat.builtins || {})[name];
    if (!b) continue;
    const where = `builtin !${name}`;
    const template = b.response && b.response.trim() ? b.response : BUILTIN_TEMPLATES[name];
    if (!template) continue;
    if (name === 'schedule' || name === 'recent') note(`${where}: count argument (e.g. !${name} 5) is ignored; always lists 3`);
    const response = convert(template, where);
    commands.push({ name, aliases: BUILTIN_ALIASES[name] || [], response, access: access(b, where), cooldown: b.cooldown ?? chat.globalCooldown ?? 5, enabled: b.enabled !== false });
    wantAutofire(name, b, response);
}

if (!commands.some(x => x.name === 'target')) {
    commands.push({
        name: 'target', aliases: ['targets'], access: 'everyone', cooldown: 5, enabled: true,
        response: 'Current target: {{rep.nodecg-tiltify.activeTarget.name}} - {{rep.nodecg-tiltify.activeTarget.raised|money}} of {{rep.nodecg-tiltify.activeTarget.amount|money}} ({{rep.nodecg-tiltify.activeTarget.percent}}%)'
    });
}

for (const c of chat.custom || []) {
    const name = String(c.trigger || '').toLowerCase();
    const where = `custom !${name}`;
    if (commands.some(x => x.name === name)) { skipped.push(`!${name} (duplicate trigger${c.enabled === false ? ', disabled copy' : ''})`); continue; }
    const random = c.responseType === 'random' && Array.isArray(c.responses) && c.responses.length > 0;
    const response = random ? c.responses.map(r => convert(r, where).replace(/\s*\n\s*/g, ' ')).join('\n') : convert(c.response, where);
    if (response.length > 1000) note(`${where}: response is ${response.length} chars; StreamPulse keeps the first 1000`);
    if (!random && /\n/.test(response)) note(`${where}: multi-line response; StreamPulse sends it as one message`);
    commands.push({ name, aliases: [], response, random, access: access(c, where), cooldown: c.cooldown ?? chat.globalCooldown ?? 5, enabled: c.enabled !== false });
    wantAutofire(name, c, random ? c.responses[0] : response);
    if (c.overlay) note(`${where}: overlay action is not migrated`);
}
if ((chat.privilegedUsers || []).length) note(`privilegedUsers (${chat.privilegedUsers.join(', ')}) not migrated; add them to StreamPulse chat bot mods`);

// ---- Alert rules ---------------------------------------------------------
const rules = readReplicant('alertRules') || [];
const alertsCfg = readReplicant('alertsConfig') || {};
const media = new Map(); // legacy URL -> { file, uploadName, exists }
const assetFor = url => {
    if (!url) return '';
    const rel = String(url).replace(/^\/assets\/4s7p-event\//, '');
    const file = path.join(ASSETS, rel);
    const base = path.basename(rel).replace(/[^a-zA-Z0-9._-]+/g, '-');
    const uploadName = `nodecg-${base.replace(/\.mov$/i, '.mp4')}`;
    if (!media.has(url)) media.set(url, { file, uploadName, exists: fs.existsSync(file) });
    if (!media.get(url).exists) note(`missing media file ${file}`);
    return `@asset:${uploadName}`;
};
const variantFor = (rule, m, s, i) => {
    const isVideo = /\.(mp4|mov|webm)$/i.test(m || '');
    return {
        id: `v${i + 1}`,
        variantType: 'weighted',
        title: '{{alert.user}} donated ${{alert.amount}}',
        message: '{{alert.message}}',
        image: m && !isVideo ? assetFor(m) : '',
        video: m && isVideo ? assetFor(m) : '',
        videoSound: true,
        videoVolume: 100,
        videoLoop: false,
        sound: s ? assetFor(s) : '',
        volume: 100,
        animIn: 'fade',
        animOut: 'fade',
        duration: Number(rule.durationSeconds) || Number(alertsCfg.durationSeconds) || 8,
        weight: 1
    };
};
const alertRules = [];
for (const r of rules) {
    const type = String(r.type || '').toLowerCase();
    if (type !== 'exact' && type !== 'range') { skipped.push(`alert "${r.name}" (unknown type ${r.type})`); continue; }
    const min = type === 'exact' ? Number(r.amount) : Number(r.minAmount ?? 0);
    const max = type === 'exact' ? Number(r.amount) : (r.maxAmount === undefined || r.maxAmount === null ? 0 : Number(r.maxAmount));
    const alts = (r.alternates || []).filter(a => a && (a.media || a.sound));
    const paired = alts.filter(a => a.media && a.sound);
    if (paired.length) note(`alert "${r.name}": paired alternates replace the primary media (legacy behavior), so the primary is not migrated`);
    const list = paired.length ? paired : [{ media: r.media, sound: r.sound }, ...alts.map(a => ({ media: a.media, sound: a.sound }))];
    if (r.cueName) note(`alert "${r.name}": sound cue "${r.cueName}" (alertPlayCue) is not migrated`);
    if (Number(r.priority)) note(`alert "${r.name}": priority ${r.priority} ignored; StreamPulse picks the highest matching minimum amount`);
    alertRules.push({
        id: `nodecg-${r.id}`,
        name: r.name || `Donation ${min}`,
        enabled: true,
        trigger: 'donation',
        // Legacy alerts only fired for Tiltify donations.
        conditions: type === 'exact' ? { amountMode: 'exact', exactAmount: min, minAmount: min, maxAmount: min, source: 'tiltify' } : { amountMode: max ? 'range' : 'min', minAmount: min, maxAmount: max, source: 'tiltify' },
        pick: 'random',
        variants: list.map((o, i) => variantFor(r, o.media, o.sound, i))
    });
}
// ---- Large donation chat announcement (cfg/4s7p-event.json socialstream) ---
let legacyCfg = {};
try { legacyCfg = JSON.parse(fs.readFileSync(LEGACY_CFG, 'utf8')); } catch (err) { note(`legacy config ${LEGACY_CFG} not read (${err.message}); donation announcement not migrated`); }
const ss = legacyCfg.socialstream;
const donationAnnouncements = ss ? {
    enabled: ss.enabled === true,
    source: 'tiltify',
    minAmount: Number(ss.large_donation_threshold) || 50,
    template: '{user} just donated {amount}! {message}',
    totalVar: 'rep.nodecg-tiltify.total',
    goalVar: 'rep.nodecg-tiltify.campaignGoal'
} : null;
if (donationAnnouncements?.enabled) note('large donation announcements now come from StreamPulse; disable socialstream.enabled in cfg/4s7p-event.json to avoid double posts');

if (alertsCfg.playLocalAudio) note('alertsConfig.playLocalAudio (host-side audio playback) has no StreamPulse equivalent; audio plays in the overlay browser source');

// ---- Report / apply ------------------------------------------------------
function report() {
    const money = n => `$${Number(n).toFixed(2)}`;
    console.log(`Source: ${DB}`);
    console.log(`Target: ${API}${DRY ? ' (dry run, nothing written)' : ''}\n`);
    console.log(`Chat commands (${commands.length}):`);
    for (const c of commands) console.log(`  !${c.name}${c.aliases.length ? ` [${c.aliases.map(a => '!' + a).join(', ')}]` : ''}  ${c.enabled ? 'on ' : 'off'}  ${c.access}  cd ${c.cooldown}s${c.random ? `  random x${c.response.split('\n').length}` : ''}  ${c.response.replace(/\n/g, ' | ').slice(0, 70)}`);
    console.log(`\nTimed messages (${messages.length}):`);
    for (const m of messages) console.log(`  ${m.id}  every ${m.every} min, after chat activity  ${m.text.slice(0, 70)}`);
    console.log(`\nDonation alert rules (${alertRules.length}):`);
    for (const r of alertRules) {
        const range = r.conditions.amountMode === 'exact' ? `= ${money(r.conditions.exactAmount)}` : `${money(r.conditions.minAmount)} - ${r.conditions.maxAmount ? money(r.conditions.maxAmount) : 'any'}`;
        console.log(`  ${r.id}  ${r.name}  ${range}  ${r.conditions.source}  ${r.variants.length} variant(s)  ${r.variants.map(v => [v.image || v.video, v.sound].filter(Boolean).join(' + ').replace(/@asset:/g, '')).join(' | ')}  ${r.variants[0].duration}s`);
    }
    if (donationAnnouncements) console.log(`\nDonation chat announcement: ${donationAnnouncements.enabled ? 'on' : 'off'}, Tiltify, ${money(donationAnnouncements.minAmount)} or more, "${donationAnnouncements.template}"`);
    console.log(`\nMedia to copy (${media.size}):`);
    for (const m of media.values()) console.log(`  ${path.basename(m.file)} -> ${m.uploadName}${/\.mov$/i.test(m.file) ? ' (remuxed MOV to MP4)' : ''}${m.exists ? '' : ' MISSING'}`);
    if (skipped.length) { console.log(`\nNot migrated (${skipped.length}):`); for (const s of skipped) console.log(`  ${s}`); }
    if (repKeys.size) console.log(`\nShare these replicants in cfg/streampulse.json "replicants" so placeholders resolve: ${[...repKeys].join(', ')}`);
    if (notes.length) { console.log(`\nNotes:`); for (const n of [...new Set(notes)]) console.log(`  ${n}`); }
}

const norm = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v ?? null);
const same = (a, b) => ['response', 'access', 'cooldown', 'enabled'].every(k => norm(a[k]) === norm(b[k]))
    && Boolean(a.random) === Boolean(b.random) && (a.aliases || []).join() === (b.aliases || []).join();

async function uploadMedia() {
    const listed = await api('GET', '/api/custom-overlays/assets');
    const existing = Array.isArray(listed) ? listed : listed.assets || [];
    const urls = {};
    fs.mkdirSync(CACHE, { recursive: true });
    for (const m of media.values()) {
        if (!m.exists) continue;
        const have = existing.find(a => a.name.endsWith(`-${m.uploadName}`));
        if (have) { urls[m.uploadName] = have.url; continue; }
        let file = m.file;
        if (/\.mov$/i.test(file)) {
            file = path.join(CACHE, m.uploadName);
            execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', m.file, '-c', 'copy', '-movflags', '+faststart', file]);
        }
        const ext = path.extname(file).toLowerCase();
        const type = { '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }[ext];
        if (!type) { console.log(`  skipped unsupported media ${m.file}`); continue; }
        const out = await api('POST', '/api/custom-overlays/assets', fs.readFileSync(file), { 'Content-Type': type, 'X-Asset-Name': m.uploadName, 'X-Asset-Tags': 'nodecg,alerts' });
        urls[m.uploadName] = out.url;
        console.log(`  uploaded ${m.uploadName} -> ${out.url}`);
    }
    fs.rmSync(CACHE, { recursive: true, force: true });
    return urls;
}

(async () => {
    report();
    if (DRY) return;
    console.log('\nApplying...');
    const urls = await uploadMedia();
    const swap = v => (v.startsWith('@asset:') ? urls[v.slice(7)] || '' : v);
    for (const r of alertRules) for (const v of r.variants) for (const k of ['image', 'video', 'sound']) v[k] = swap(v[k]);

    const alerts = await api('GET', '/api/alerts');
    const keep = alerts.rules.filter(r => !alertRules.some(n => n.id === r.id));
    await api('PUT', '/api/alerts', { settings: alerts.settings, rules: [...keep, ...alertRules] });
    console.log(`  alert rules: ${alertRules.length} written (${keep.length} other rules kept)`);

    const bot = await api('GET', '/api/chatbot');
    const list = bot.commands.slice();
    const counts = { added: 0, updated: 0, unchanged: 0, conflict: 0 };
    for (const c of commands) {
        const i = list.findIndex(x => x.name === c.name);
        if (i < 0) { list.push(c); counts.added++; continue; }
        if (same(list[i], c)) { counts.unchanged++; continue; }
        if (!FORCE) { counts.conflict++; console.log(`  !${c.name} exists in StreamPulse with different content; skipped (use --force to overwrite)`); continue; }
        list[i] = { ...list[i], ...c };
        counts.updated++;
    }
    const msgs = [...bot.messages.filter(m => !messages.some(n => n.id === m.id)), ...messages];
    await api('PUT', '/api/chatbot', { commands: list, messages: msgs, ...(donationAnnouncements ? { settings: { donationAnnouncements: { ...(bot.settings?.donationAnnouncements || {}), ...donationAnnouncements } } } : {}) });
    console.log(`  commands: ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.conflict} conflicts; timed messages: ${messages.length} written${donationAnnouncements ? '; donation announcement settings written' : ''}`);
    console.log('Done. Changes are live; no restart needed.');
})().catch(err => { console.error(`Migration failed: ${err.message}`); process.exit(1); });
