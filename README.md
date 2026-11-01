# nodecg-streampulse

Runs [StreamPulse](https://github.com/jarbochov/StreamPulse) inside NodeCG (one server) and publishes its live state as replicants.

## Install
1. Clone into `bundles/streampulse` and run `npm install` (requires Node 22.12+).
2. Optional `cfg/streampulse.json`: `port` (default 3000), `configPath`, `dataDir`. Keep both paths on a Docker volume so updates never touch them.
3. Expose the StreamPulse port from the container.

## Replicants (`streampulse` bundle)
`status`, `timers`, `goals`, `viewers`, `music`, `poll`, `matchup`, `tournament`, `pollTournament`.
Every StreamPulse broadcast is also sent as the `event` message (`{ type, data }`).

## Replicants in StreamPulse overlays
List replicants from any bundle in `cfg/streampulse.json`:
```json
{ "replicants": [{ "bundle": "nodecg-tiltify", "name": "total" }] }
```
They appear in the Custom Overlay Editor variable picker under "NodeCG: <bundle>.<name>" and resolve as `{{rep.nodecg-tiltify.total.amount}}` (arrays by index, e.g. `.0.name`). Updates push live.

## Upgrade
Change the `streampulse` version in `package.json`, run `npm install`, restart NodeCG. Config and data are untouched.

## Test
`STREAMPULSE_SERVER=/path/to/StreamPulse/server.js node test/smoke.cjs`
