'use strict';
// Loads the extension with a minimal NodeCG stand-in. Usage: STREAMPULSE_SERVER=/path/to/server.js node test/smoke.cjs
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncg-sp-'));
const reps = {}; const messages = [];
const nodecg = {
    bundleConfig: { port: 3917, configPath: path.join(dir, 'config.json'), dataDir: path.join(dir, 'data'), serverPath: process.env.STREAMPULSE_SERVER || '', replicants: [{ bundle: 'nodecg-tiltify', name: 'total' }] },
    Replicant: (name, opts) => typeof opts === 'string'
        ? (reps[`${opts}.${name}`] ??= { on(ev, fn) { this.fn = fn; } })
        : (reps[name] ??= { value: opts?.defaultValue }),
    sendMessage: (name, data) => messages.push({ name, data }),
    log: { info() {}, warn: console.warn, error: console.error }
};
(async () => {
    await require('../extension/index.js')(nodecg);
    assert.equal(reps.status.value.running, true, reps.status.value.error || 'not running');
    for (const key of ['timers', 'goals', 'viewers', 'poll', 'matchup']) assert.ok(key in reps, `missing replicant ${key}`);
    await fetch('http://127.0.0.1:3917/api/timers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'smoke', name: 'Smoke', type: 'countdown', durationMs: 60000 }) });
    await new Promise(r => setTimeout(r, 150));
    assert.ok(JSON.stringify(reps.timers.value).includes('smoke'), 'timers replicant not updated');
    assert.ok(messages.some(m => m.name === 'event'), 'no event messages');
    reps['nodecg-tiltify.total'].fn({ amount: 42 });
    // Tiltify bridge: the startup backlog is skipped, new donations alert once.
    await fetch('http://127.0.0.1:3917/api/alerts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [{ id: 'smoke-donation', trigger: 'donation', variants: [{ title: '{{alert.user}}' }] }] }) });
    const tiltify = reps['nodecg-tiltify.donations'].fn;
    const old = { id: 'old', donor_name: 'Backlog', amount: { value: '5.00', currency: 'USD' } };
    tiltify([old]);
    const fresh = { id: 'new', donor_name: 'FictionalDonor', amount: { value: '25.00', currency: 'USD' }, donor_comment: 'Hi' };
    tiltify([old, fresh]);
    tiltify([old, fresh]);
    await new Promise(r => setTimeout(r, 100));
    const queue = (await (await fetch('http://127.0.0.1:3917/api/alerts')).json()).queue;
    const shown = queue.events.filter(e => e.event.source === 'tiltify');
    assert.deepEqual(shown.map(e => e.event.user), ['FictionalDonor'], 'tiltify donation not forwarded exactly once');
    assert.equal(shown[0].event.amount, 25);
    const st = await (await fetch('http://127.0.0.1:3917/api/status')).json();
    assert.equal(st.external['nodecg-tiltify.total'].amount, 42, 'replicant not shared');
    assert.deepEqual(st.hostSources, [{ id: 'tiltify', label: 'Tiltify (NodeCG)' }], 'tiltify host source not registered');
    await require(nodecg.bundleConfig.serverPath || 'streampulse/server.js').stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('streampulse bundle smoke test passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
