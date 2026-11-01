'use strict';
// Loads the extension with a minimal NodeCG stand-in. Usage: STREAMPULSE_SERVER=/path/to/server.js node test/smoke.cjs
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncg-sp-'));
const reps = {}; const messages = [];
const nodecg = {
    bundleConfig: { port: 3917, configPath: path.join(dir, 'config.json'), dataDir: path.join(dir, 'data'), serverPath: process.env.STREAMPULSE_SERVER || '' },
    Replicant: (name, opts) => (reps[name] ??= { value: opts?.defaultValue }),
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
    await require(nodecg.bundleConfig.serverPath || 'streampulse/server.js').stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('streampulse bundle smoke test passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
