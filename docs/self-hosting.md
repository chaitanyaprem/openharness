# Self-hosting Harness

This fork runs the desktop app, the daemons, and the relay without an Autonomous account and without calling `*.autonomous.ai`. Upstream behavior is unchanged when the self-host config is absent.

## What depends on Autonomous today

The relay in `backend/` is a Fastify process. It stores users and machines in MongoDB and moves socket traffic through Redis. A remote machine is a row with `authMode: remote` and an empty `managerId`. Creating one does not call a hosted manager (`backend/src/services/MachineService.ts`, `resolveOrCreateForComputer`). The piece that does call out is authentication.

| What | Where | Configurable before this fork |
| --- | --- | --- |
| Relay WebSocket | `cli/src/config/env.ts` `BACKEND_WS_URL`, default `wss://harness-api.autonomous.ai` | Env var, daemon only |
| SSO issuer | `backend/src/config/env.ts` `SSO_ISSUER`, default `https://auth.autonomous.ai` | Env var |
| Profile check that proves a token | `SSO_PROFILE_URL` / `SSO_IDENTITY_URL`, default `https://apiv2.autonomous.ai/...` | Env var, but the response shape is theirs |
| Adapter and browser sockets | `backend/src/lib/adapterWs.ts` and `webWs.ts` call `authenticateAccessToken` | No |
| Grid installer | `cli/src/lib/gridInstall.ts` `https://grid.autonomous.ai/install.sh` | `DISABLE_GRID_INSTALL=true` |
| CLI self-update | `ADAPTER_UPDATE_URL` on `storage.googleapis.com` | `ADAPTER_UPDATE_DISABLE=true` |
| Desktop self-update | `desktop/lib/update/desktop_updater.dart` same bucket | No, except a build-time URL |
| Store catalog | `cli/src/dsh/catalog.ts` `raw.githubusercontent.com/autonomous-ai/openharness` | `HARNESS_STORE_CATALOG_URL` |
| Desktop analytics | `desktop/lib/analytics/analytics_config.dart` `autonomous-analytics-...run.app` | `HARNESS_ANALYTICS_DISABLED` |
| STUN | `TERMINAL_P2P_STUN_URLS` in the backend env: Cloudflare, Google, Twilio, and others | Env var |
| TURN | `TERMINAL_P2P_TURN_KEY_ID` | Off unless you set a Cloudflare key |
| Campaign billing | `backend/src/lib/db/seed.ts` via `AUTONOMOUS_BFF_URL` | Only the billing worker calls it |

The desktop app does not open its own socket to the relay for machine traffic. `ApiClient` uses the local daemon when it has no separate auth object (`desktop/lib/api/api_client.dart`). Remote panes ride the daemon's relay connection, then a WebRTC data channel when ICE connects. That part already worked. What did not work without an account was getting both daemons onto the relay.

## Trust

Each computer generates an Ed25519 identity under `~/.harness/cli/data/e2e/identity.json` (`cli/src/lib/e2ee/store.ts`). Nothing in Autonomous signs that key. Two machines trust each other by a password: `harness remote-password set` on one, `harness link connect` on the other. The handshake is a CPace-style PAKE (`cli/src/lib/e2ee/passwordPake.ts`, `machinePeers.ts`). The relay forwards the messages and does not learn the password or the session keys.

The SSO token was only the WebSocket credential (`cli/src/lib/e2ee/relayClient.ts` passes it as the subprotocol). Replacing that credential does not require a new cipher or a change under `cli/src/lib/e2ee/`.

Self-hosted mode issues one user token from `POST /api/self-host/enroll` and the daemon sends that token where it used to send the SSO token. It is not the machine api key. A 64-hex api key pins a web socket to one machine, and `link connect` has to select the other machine. `authenticateAccessToken` returns the single local user and does not call the profile API.

Enrollment accepts either:

- `HARNESS_ENROLLMENT_TOKEN`, a shared secret. Treat it like a root password.
- A signature by an Ed25519 key whose public key is listed in `HARNESS_PUBKEY_ALLOWLIST`, one base64 or hex key per line.

The client always signs a one-time nonce, so a captured enroll request cannot be replayed. The nonce lives in the server process. Run one backend process, not the pm2 cluster.

## WireGuard

With `HARNESS_SELF_HOSTED=true` and `TERMINAL_P2P_STUN_URLS` left unset, the relay hands out no STUN and no TURN. The CLI then gathers host candidates only (`cli/src/lib/terminalP2p.ts`). A WireGuard address on the host is one of those candidates, so the terminal data channel can connect across the mesh without a public STUN server. Signaling still goes through the relay. If ICE does not connect, the bytes fall back to the relay, still encrypted.

The relay is required for enrollment, for the machine list, and for signaling. It is not required for the terminal bytes once the direct channel is up.

## License

`LICENSE` at the repo root is MIT, and it covers `backend/`. This fork does not add a new service. Store packages under `store/` keep their own upstream licenses (several are Apache-2.0) and are optional. Self-hosted mode does not download the managed Node, tmux, or grid binaries. Install Node 20+ and tmux from your distro.

## Layout

```
~/.harness/self-host.json     # one file, read by the CLI and the desktop app
cli daemon  --WebSocket-->  your relay :8085  --Redis-->  the other daemon
desktop app --loopback-->   cli daemon
```

`HARNESS_CONFIG` overrides the path. Environment variables override the file.

```json
{
  "selfHosted": true,
  "backendUrl": "http://10.0.0.5:8085",
  "enrollmentToken": "a long random string"
}
```

`backendUrl` alone, without `selfHosted`, only retargets `BACKEND_WS_URL`. Login is still SSO. `selfHosted: true` also turns off grid install, CLI and desktop update checks, desktop analytics, the store catalog fetch, and dial firmware downloads. A variable you export yourself wins, so you can turn one of those back on.

The same keys exist as env: `HARNESS_SELF_HOSTED`, `HARNESS_BACKEND_URL`, `HARNESS_ENROLLMENT_TOKEN`.

## Relay on a homelab machine

Docker, from a checkout of this branch:

```bash
cd backend/deploy/selfhost
cp backend.env.example backend.env
# put a real HARNESS_ENROLLMENT_TOKEN in backend.env
docker compose --env-file backend.env up -d --build
```

That compose file starts MongoDB 7 as a one-node replica set, Redis 7, and `node dist/server.js`. It does not start `worker.ts`. The worker is what pulls the campaign catalog.

systemd, if you would rather not use Docker: install MongoDB and Redis yourself, build the backend (`npm ci && npm run build` in `backend/`), and install `backend/deploy/selfhost/harness-backend.service`. The unit reads `/etc/harness/backend.env`. Use the same keys as `backend.env.example`, plus:

```
DATABASE_URL=mongodb://127.0.0.1:27017/harness?replicaSet=rs0
REDIS_URL=redis://127.0.0.1:6379
```

Mongo has to actually be a replica set. A standalone `mongod` will not serve the URL above.

```bash
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

Confirm the process is up with `curl -s http://127.0.0.1:8085/api/health`.

Pubkey allowlist instead of a token: write one key per line to a file on the server, set `HARNESS_PUBKEY_ALLOWLIST` to that path, and leave the token empty. No `harness` command prints a machine's public key. It is the `pub` field (base64) of `~/.harness/cli/data/e2e/identity.json`:

```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.harness/cli/data/e2e/identity.json", "utf8")).pub)'
```

`harness login` creates that file before it asks the relay for anything, so running it once without a token (it fails with 403) is enough to get a key you can add to the allowlist. After every machine is listed, remove the token from the server env and from the clients.

## Daemon on Linux or macOS

Install Node 20+ and tmux from the OS. From this checkout:

```bash
cd cli && npm ci && npm run build
# or, for a checkout you are hacking on:
node cli/node_modules/tsx/dist/cli.mjs cli/src/cli.ts login
node cli/node_modules/tsx/dist/cli.mjs cli/src/cli.ts start
```

`harness login` with the config file above enrolls this computer and writes `~/.harness/auth/session.json`. The session holds the user token, mode 0600, and records the relay that issued it. It does not open a browser. `harness start` enrolls on its own if that file is missing, which is what you want on a headless box.

The CLI only uses a session issued by the relay it currently points at. If you switch a signed-in computer to self-hosted, or point it at another relay, the next `login` or `start` enrolls again and overwrites the old session. Turn self-hosted mode off and the enrolled session reads as signed out, so `harness login` goes back to SSO.

On the machine you will connect to:

```bash
harness remote-password set
```

On the machine you are sitting at:

```bash
harness link connect <machineId>
```

`machineId` is in the remote machine's session file, and in `harness status` after start. The password never goes to the relay in the clear. The link pins the other machine's public key in `machinePeers.json`.

DSH installs from a local path:

```bash
harness dsh install --link /path/to/package
```

`harness dsh` catalog refresh does not fetch GitHub while `HARNESS_STORE_OFFLINE` is set. The bundled registry still lists packages whose files are in this checkout.

## Desktop app on the Mac

Build the Flutter app from `desktop/` the way upstream documents. The app reads `~/.harness/self-host.json` at startup. It passes `HARNESS_SELF_HOSTED` and the backend URL into every CLI command, skips the GCS update check, and does not send analytics. If the CLI or tmux is missing it stops and tells you to install them. It does not curl `cdn.autonomous.ai`.

"Use this computer without an account" is the earlier local-only mode (`HARNESS_LOCAL_ONLY`). That mode never dials a relay, so it cannot see other machines. Self-hosted mode is the one that enrolls and links. You can use local-only on a laptop that should stay off the relay, even with `self-host.json` in place, because local mode skips enrollment.

## Security model

- One user, `self-hosted@localhost`. No tenants, no billing, no SSO.
- The enrollment token enrolls any computer that can reach the relay. Anyone who reads it can add a machine. Prefer the allowlist once the machines exist, and take the token out.
- After enroll, the socket credential is the user token in `session.json`. Anyone who reads it can connect as this relay's user until you replace the token (delete `passwordHash` on the user row and enroll again).
- E2EE keys stay on the computers. The relay stores the machine api key and the ciphertext it forwards.
- Challenges are remembered in one process for five minutes. A second backend process will reject a challenge the first one issued.
- Public STUN and TURN are off. Host candidates include every address on the box, so a machine with a public interface will offer that address too. Bind the relay to the WireGuard address if the host has interfaces you do not want in ICE.

## Limits

- The web client at harness.autonomous.ai is not in this repo. Use the desktop app or the CLI.
- The mobile app is unchanged and still talks to Autonomous analytics.
- `worker.ts` is not part of the self-host service. Starting it with billing left on will call `apiv2.autonomous.ai`.
- Voice transcription and campaign checkout still point at external services if you turn them on. Self-hosted mode does not call them during enroll, start, or link.
- Linking needs both daemons connected to your relay. Direct WireGuard replaces the terminal bytes, not the handshake.
- Tests: `cli` vitest and `backend` vitest cover config, enrollment, and a two-daemon link. `flutter test` was not run here because the Flutter SDK is not installed on this machine.
