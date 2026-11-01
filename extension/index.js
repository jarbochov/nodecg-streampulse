'use strict';
const fs = require('fs');
const path = require('path');
const legacyCommands = require('./legacy-commands');

// Broadcast type -> replicant fed from StreamPulse's authoritative snapshot.
const REPLICANT_FOR = {
    'timers-snapshot': 'timers', 'timer-update': 'timers', 'timer-delete': 'timers', 'timer-settings': 'timers',
    'goals-update': 'goals',
    'viewer-update': 'viewers',
    music: 'music',
    'poll-update': 'poll',
    'matchup-update': 'matchup',
    'tournament-update': 'tournament',
    'poll-tournament-update': 'pollTournament'
};
const SNAPSHOT_KEYS = [...new Set(Object.values(REPLICANT_FOR))];

module.exports = async nodecg => {
    const cfg = nodecg.bundleConfig || {};
    const configPath = cfg.configPath || '/opt/nodecg/streampulse/config.json';
    const dataDir = cfg.dataDir || '/opt/nodecg/streampulse/data';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ port: cfg.port || 3000 }, null, 2));

    process.env.STREAMPULSE_EMBEDDED = 'true';
    process.env.STREAMPULSE_CONFIG_PATH = configPath;
    process.env.STREAMPULSE_DATA_DIR = dataDir;
    process.env.PORT = String(cfg.port || 3000);
    // Serve HTTPS with NodeCG's certificates so StreamPulse embeds in the HTTPS dashboard.
    const tlsKey = cfg.tlsKey ?? '/opt/nodecg/ssl/key.pem';
    const tlsCert = cfg.tlsCert ?? '/opt/nodecg/ssl/cert.pem';
    if (tlsKey && tlsCert && fs.existsSync(tlsKey) && fs.existsSync(tlsCert)) {
        process.env.STREAMPULSE_TLS_KEY = tlsKey;
        process.env.STREAMPULSE_TLS_CERT = tlsCert;
    }

    const status = nodecg.Replicant('status', { persistent: false, defaultValue: { running: false, port: null, publicPort: null, protocol: null, error: null } });
    const reps = Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, nodecg.Replicant(key, { persistent: false, defaultValue: null })]));

    let sp;
    try {
        sp = require(cfg.serverPath || 'streampulse/server.js');
        await sp.startServer();
    } catch (err) {
        status.value = { running: false, port: null, publicPort: null, protocol: null, error: err.message };
        nodecg.log.error('StreamPulse failed to start:', err.message);
        return;
    }

    const refresh = keys => {
        const snap = sp.getSnapshots();
        for (const key of keys) reps[key].value = JSON.parse(JSON.stringify(snap[key] ?? null));
    };
    refresh(SNAPSHOT_KEYS);
    status.value = { running: true, port: sp.port, publicPort: cfg.publicPort || sp.port, protocol: process.env.STREAMPULSE_TLS_KEY ? 'https' : 'http', publicUrl: cfg.publicUrl || null, error: null };
    nodecg.log.info(`StreamPulse running on port ${sp.port}`);

    // Runtime health: poll /api/status, record state; reconnect hook restarts the server.
    const base = () => `${process.env.STREAMPULSE_TLS_KEY ? 'https' : 'http'}://127.0.0.1:${sp.port}`;
    const probe = () => new Promise(resolve => {
        const lib = process.env.STREAMPULSE_TLS_KEY ? require('https') : require('http');
        const req = lib.get(`${base()}/api/status`, { rejectUnauthorized: false, timeout: 4000 }, res => {
            let body = '';
            res.on('data', c => { if (body.length < 2e6) body += c; });
            res.on('end', () => {
                if (res.statusCode >= 400) return resolve({ err: `HTTP ${res.statusCode}` });
                let ssn = null;
                try { const j = JSON.parse(body).ssn || {}; ssn = !j.session ? 'not-configured' : j.connected ? 'connected' : 'disconnected'; } catch (_) {}
                resolve({ err: null, ssn });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.on('error', e => resolve({ err: e.message || 'Unreachable' }));
    });
    let fails = 0;
    const check = async () => {
        const { err, ssn } = await probe();
        const cur = status.value || {};
        if (!err) { fails = 0; status.value = { ...cur, running: true, state: 'ok', error: null, lastOk: Date.now(), ssn }; }
        else { fails++; status.value = { ...cur, state: 'error', error: err, lastError: err, lastErrorAt: Date.now() }; }
    };
    setInterval(check, 15000).unref();
    check();
    nodecg.listenFor('restart', async (v, ack) => {
        try {
            await sp.stopServer();
            await sp.startServer();
            await check();
            if (ack && !ack.handled) ack(null, true);
        } catch (e) { status.value = { ...(status.value || {}), state: 'error', error: e.message }; if (ack && !ack.handled) ack(e.message); }
    });

    sp.onBroadcast((type, data) => {
        const key = REPLICANT_FOR[type];
        if (key) {
            try { refresh([key]); } catch (err) { nodecg.log.warn(`Replicant ${key} refresh failed:`, err.message); }
        }
        nodecg.sendMessage('event', { type, data });
    });

    // Share selected replicants (any bundle) with StreamPulse overlays.
    for (const { bundle, name } of cfg.replicants || []) {
        const rep = nodecg.Replicant(name, bundle);
        rep.on('change', value => {
            try { sp.setExternalData(`${bundle}.${name}`, value); } catch (err) { nodecg.log.warn(`Replicant ${bundle}.${name} not shared:`, err.message); }
        });
    }

    // Legacy 4s7p-event built-in command replies -> {{rep.streampulse.cmd.<name>}}.
    const legacy = { enabled: true, bundle: '4s7p-event', tiltifyBundle: 'nodecg-tiltify', ...(cfg.legacyCommands || {}) };
    if (legacy.enabled) legacyCommands.attach(nodecg, sp, legacy);

    // Tiltify donations -> StreamPulse donation alerts, goals and stats. The startup backlog is only marked as seen.
    const tiltify = { enabled: true, bundle: 'nodecg-tiltify', ...(cfg.tiltifyDonations || {}) };
    if (tiltify.enabled && typeof sp.ingestEvent === 'function') {
        if (typeof sp.registerHostSource === 'function') sp.registerHostSource({ id: 'tiltify', label: 'Tiltify (NodeCG)' });
        const seen = new Set();
        let primed = false;
        const donations = nodecg.Replicant('donations', tiltify.bundle);
        donations.on('change', list => {
            if (!Array.isArray(list)) return;
            for (const d of list) {
                const id = d && d.id !== undefined && d.id !== null ? String(d.id) : '';
                if (!id || seen.has(id)) continue;
                seen.add(id);
                if (!primed) continue;
                try {
                    sp.ingestEvent({
                        type: 'donation',
                        id: `tiltify-${id}`,
                        user: d.donor_name || 'Anonymous',
                        amount: Number(d.amount?.value ?? d.amount) || 0,
                        currency: d.amount?.currency || 'USD',
                        message: d.donor_comment || '',
                        source: 'tiltify'
                    });
                } catch (err) { nodecg.log.warn(`Tiltify donation ${id} not forwarded:`, err.message); }
            }
            primed = true;
        });
    }

    const stop = () => sp.stopServer().catch(err => nodecg.log.error('StreamPulse shutdown failed:', err.message));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
};
