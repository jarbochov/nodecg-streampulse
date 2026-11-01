# nodecg-streampulse

Runs [StreamPulse](https://github.com/jarbochov/StreamPulse) inside NodeCG (one server) and publishes its live state as replicants.

## Install
1. Clone into `bundles/streampulse` and run `npm install` (requires Node 22.12+).
2. Optional `cfg/streampulse.json`: `port` (default 3000), `configPath`, `dataDir`. Keep both paths on a Docker volume so updates never touch them.
3. Expose the StreamPulse port from the container and set `publicPort` to the host port (e.g. `3300`).
4. HTTPS: NodeCG's `ssl/key.pem` and `ssl/cert.pem` are used automatically (`tlsKey`/`tlsCert`; set both to `""` for plain HTTP).

Behind a reverse proxy (e.g. Synology DSM with its Let's Encrypt certificate): set `tlsKey`/`tlsCert` to `""`, proxy `https://*:<port>` to `http://localhost:<publicPort>` with the WebSocket headers enabled, and set `publicUrl`.

## Dashboard
A full-bleed "StreamPulse" tab embeds the full StreamPulse UI, and a status panel on the main workspace shows whether it is running with an open link.

## Replicants (`streampulse` bundle)
`status`, `timers`, `goals`, `viewers`, `music`, `poll`, `matchup`, `tournament`, `pollTournament`.
Every StreamPulse broadcast is also sent as the `event` message (`{ type, data }`).

## Replicants in StreamPulse overlays
List replicants from any bundle in `cfg/streampulse.json`:
```json
{ "replicants": [{ "bundle": "nodecg-tiltify", "name": "total" }] }
```
They appear in the Custom Overlay Editor variable picker under "NodeCG: <bundle>.<name>" and resolve as `{{rep.nodecg-tiltify.total.amount}}` (arrays by index, e.g. `.0.name`). Updates push live.

## Tiltify donation alerts
New donations in the `nodecg-tiltify` `donations` replicant are sent to StreamPulse (`ingestEvent`) so they trigger donation alert rules, goals and stats. The backlog present at startup is skipped and donations are deduped by id. Configure in `cfg/streampulse.json`:
```json
{ "tiltifyDonations": { "enabled": true, "bundle": "nodecg-tiltify" } }
```
Requires a StreamPulse version that exports `ingestEvent`; older versions skip the bridge.

## Migrating legacy chat commands and alerts
`scripts/migrate-legacy.cjs` copies the `4s7p-event` `chatCommands` and `alertRules` replicants (read-only from `db/nodecg.sqlite3`) into StreamPulse through its HTTP API, uploading alert media (MOV files are remuxed to MP4 with `ffmpeg`). Changes are live; no restart is needed.
```sh
node scripts/migrate-legacy.cjs --dry-run                         # print the mapping only
node scripts/migrate-legacy.cjs --api http://127.0.0.1:3000       # apply (inside the container)
```
Options: `--api` (or `STREAMPULSE_API`), `--db`, `--assets`, `--force` (overwrite StreamPulse commands with the same name but different content). Re-runs update in place: alert rules use ids `nodecg-<legacy id>`, the autofire message `nodecg-<name>`, media `nodecg-<file>`. Add the replicants it lists (`4s7p-event.scheduleData`, `nodecg-tiltify.total`, `nodecg-tiltify.campaignGoal`) to `replicants` so command placeholders resolve.

## Upgrade
Change the `streampulse` version in `package.json`, run `npm install` (or delete `node_modules/streampulse` so the container reinstalls it), restart NodeCG. Config and data are untouched.

## Test
`STREAMPULSE_SERVER=/path/to/StreamPulse/server.js node test/smoke.cjs`
