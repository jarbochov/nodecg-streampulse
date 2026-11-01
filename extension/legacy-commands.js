'use strict';
// Ports the 4s7p-event built-in chat command replies (!schedule, !recent, !gamestats, !host, !commentators, !players)
// and publishes them as StreamPulse external data "streampulse.cmd" -> {{rep.streampulse.cmd.<name>}}.
// Formatting mirrors 4s7p-event/extension/chat-bot.js and utils.js so replies stay identical.

// chat-bot.js parseAmount (used by !recent)
function parseAmountChat(val) {
    if (!val) return 0;
    if (typeof val === 'object' && val.value) return parseFloat(val.value) || 0;
    return parseFloat(val) || 0;
}

// utils.js parseAmount (used by !gamestats)
function parseAmount(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && val.value !== undefined) return parseFloat(val.value) || 0;
    const num = parseFloat(val);
    return Number.isFinite(num) ? num : 0;
}

const formatMoney = num => '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function normalizeDisplayValue(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/(?:\s*,\s*)+$/g, '').replace(/\s+/g, ' ').trim();
}
const normalizeNameList = names => (names || []).map(normalizeDisplayValue).filter(Boolean);

function formatListLabel(names, singular, plural, separator) {
    const cleaned = normalizeNameList(names);
    if (!cleaned.length) return null;
    return (cleaned.length === 1 ? singular : plural) + ': ' + cleaned.join(separator || ', ');
}

function formatTimeUntil(isoTime, now) {
    if (!isoTime) return '';
    try {
        const diff = new Date(isoTime) - now;
        if (diff <= 0) return '(now)';
        const totalMins = Math.round(diff / 60000);
        if (totalMins < 1) return '(now)';
        if (totalMins < 60) return '(~' + totalMins + ' min)';
        const hrs = Math.floor(totalMins / 60);
        const rem = totalMins % 60;
        return rem > 0 ? '(~' + hrs + 'h ' + rem + 'm)' : '(~' + hrs + 'h)';
    } catch { return ''; }
}

function donationDate(value) {
    if (!value) return null;
    const ts = value.created_at || value.completed_at || value.time;
    if (!ts) return null;
    const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    return Number.isNaN(date.getTime()) ? null : date;
}

function mergeUniqueDonations(tiltifyDonations, webhookDonations) {
    const tiltify = Array.isArray(tiltifyDonations) ? tiltifyDonations : [];
    const webhook = Array.isArray(webhookDonations) ? webhookDonations : [];
    if (!webhook.length) return tiltify.slice();
    if (!tiltify.length) return webhook.slice();
    const ids = new Set();
    const prints = new Set();
    tiltify.forEach(d => {
        if (d && d.id) ids.add(String(d.id));
        const name = String(d?.donor_name || d?.name || '').toLowerCase().trim();
        const amount = parseAmount(d?.amount);
        const date = donationDate(d);
        if (!name || !amount || !date) return;
        const minute = Math.floor(date.getTime() / 60000);
        const base = `${name}|${amount.toFixed(2)}|`;
        prints.add(base + minute); prints.add(base + (minute - 1)); prints.add(base + (minute + 1));
    });
    const unique = webhook.filter(d => {
        if (d?.source === 'test') return true;
        if (d?.id && ids.has(String(d.id))) return false;
        const name = String(d?.donor_name || d?.name || '').toLowerCase().trim();
        const amount = parseAmount(d?.amount);
        const date = donationDate(d);
        if (!name || !amount || !date) return true;
        return !prints.has(`${name}|${amount.toFixed(2)}|${Math.floor(date.getTime() / 60000)}`);
    });
    return tiltify.concat(unique);
}

function getCurrentGameStats(sessions, tiltifyDonations, webhookDonations, now) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) return null;
    const session = list[list.length - 1];
    const start = session?.actualStart ? new Date(session.actualStart) : null;
    const end = session?.actualEnd ? new Date(session.actualEnd) : now;
    let count = 0;
    let total = 0;
    mergeUniqueDonations(tiltifyDonations, webhookDonations).forEach(d => {
        if (!d) return;
        if (session.gameId && d.gameId && d.gameId === session.gameId) { count += 1; total += parseAmount(d.amount); return; }
        const date = donationDate(d);
        if (!date || !start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
        if (date >= start && date <= end) { count += 1; total += parseAmount(d.amount); }
    });
    return { session, donationCount: count > 0 ? count : (session.donationCount || 0), donationTotal: count > 0 ? total : (session.donationTotal || 0) };
}

const roleNames = (items, prefix) => normalizeNameList((items || [])
    .filter(x => x && typeof x.id === 'string' && x.id.startsWith(prefix) && !x.id.includes('pronoun'))
    .map(x => x.value));

// src: { scheduleData, playersData, allDonations, webhookDonations, gameSessionLog, responses }. Legacy defaults: 3 items.
function formatCommands(src, now = new Date()) {
    const resp = src.responses || {};
    const out = {};

    const sched = src.scheduleData;
    if (!sched || !sched.nextGames || !sched.nextGames.length) out.schedule = resp.no_games || 'No upcoming games scheduled.';
    else {
        const list = sched.nextGames.slice(0, 3).map((g, i) => {
            const eta = formatTimeUntil(g.time, now);
            return (i + 1) + '. ' + g.title + ' (' + (g.system || '?') + ')' + (eta ? ' ' + eta : '');
        }).join(' | ');
        out.schedule = '\uD83D\uDCCB Up next: ' + list + '\nFull schedule: ' + (resp.schedule_url || 'https://4score7pongs.com/schedule');
    }

    const donations = src.allDonations;
    if (!donations || !donations.length) out.recent = 'No donations yet!';
    else out.recent = '\uD83D\uDCB5 Recent donations: ' + donations.slice(0, 3).map(d => (d.donor_name || 'Anonymous') + ' - ' + formatMoney(parseAmountChat(d.amount))).join(' | ');

    const stats = getCurrentGameStats(src.gameSessionLog, src.allDonations, src.webhookDonations, now);
    out.gamestats = stats
        ? '\uD83D\uDCCA ' + stats.session.gameTitle + ': ' + formatMoney(stats.donationTotal) + ' from ' + stats.donationCount + ' donations'
        : 'No game sessions tracked yet.';

    const p = src.playersData;
    if (!p || !p.commentatorsAndHosts) {
        out.host = 'No host info available.';
        out.commentators = 'No commentator info available.';
    } else {
        const hosts = formatListLabel(roleNames(p.commentatorsAndHosts, 'host'), 'Host', 'Hosts', ' & ');
        out.host = hosts ? '\uD83C\uDF99\uFE0F ' + hosts : 'No hosts set.';
        const comms = formatListLabel(roleNames(p.commentatorsAndHosts, 'commentator'), 'Commentator', 'Commentators', ' & ');
        out.commentators = comms ? '\uD83C\uDFA4 ' + comms : 'No commentators set.';
    }
    if (!p || !p.players) out.players = 'No player info available.';
    else {
        const players = formatListLabel(roleNames(p.players, 'player'), 'Player', 'Players');
        out.players = players ? '\uD83C\uDFAE ' + players : 'No players set.';
    }
    return out;
}

// Subscribes to the legacy replicants and keeps {{rep.streampulse.cmd.*}} current.
function attach(nodecg, sp, opts = {}) {
    const bundle = opts.bundle || '4s7p-event';
    const tiltifyBundle = opts.tiltifyBundle || 'nodecg-tiltify';
    const sources = {
        scheduleData: nodecg.Replicant('scheduleData', bundle),
        playersData: nodecg.Replicant('playersData', bundle),
        webhookDonations: nodecg.Replicant('webhookDonations', bundle),
        gameSessionLog: nodecg.Replicant('gameSessionLog', bundle),
        chatCommands: nodecg.Replicant('chatCommands', bundle),
        allDonations: nodecg.Replicant('alldonations', tiltifyBundle)
    };
    let last = '';
    let timer = null;
    const publish = () => {
        timer = null;
        try {
            const v = k => sources[k].value;
            const out = formatCommands({ scheduleData: v('scheduleData'), playersData: v('playersData'), allDonations: v('allDonations'), webhookDonations: v('webhookDonations'), gameSessionLog: v('gameSessionLog'), responses: v('chatCommands')?.responses });
            const json = JSON.stringify(out);
            if (json === last) return;
            last = json;
            sp.setExternalData('streampulse.cmd', out);
        } catch (err) { nodecg.log.warn('Legacy command replies not updated:', err.message); }
    };
    const schedule = () => { if (!timer) timer = setTimeout(publish, opts.debounceMs ?? 250); };
    for (const rep of Object.values(sources)) rep.on('change', schedule);
    // ETAs and the open game session depend on the clock.
    const tick = setInterval(schedule, opts.refreshMs ?? 30000);
    tick.unref?.();
    schedule();
    return () => { clearInterval(tick); clearTimeout(timer); };
}

module.exports = { attach, formatCommands };
