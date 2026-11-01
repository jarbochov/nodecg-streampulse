'use strict';
const fs = require('fs');
const path = require('path');

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

    const stop = () => sp.stopServer().catch(err => nodecg.log.error('StreamPulse shutdown failed:', err.message));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
};
