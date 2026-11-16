# CSP integration: in-game licence layer

This folder documents how a Global Visions track checks its licence from inside
Assetto Corsa, through a Custom Shaders Patch (CSP) Lua track script, and gives
readable reference code for it.

| File | What it is |
|---|---|
| `README.md` | this document: flow, HTTP examples, reason codes, wiring checklist, limits |
| `gv_licence.lua` | reference module (`GvLicence.init`, `GvLicence.isLicensed`), readable, not obfuscated |
| `feature_gates_example.lua` | tiny example that turns lights, animations, grip and timing on or off from `onState` |

The track owner wires the module into the track's own script and obfuscates the
result himself. Nothing here does obfuscation.

The API is defined in `docs/store/CONTRACT.md` (section 5 for the licence file,
section 6 for `/activate` and `/validate`). This document follows it; if the two
ever disagree, the contract wins.

## Where this layer sits

| Layer | Runs on | Protects |
|---|---|---|
| AssettoServer plugin (`assettoserver-plugin/`) | race server | online races: unlicensed Steam accounts cannot join |
| CSP script (this folder) | player's PC | paid extras in single player and online, plus traceability of each download |

The server layer is the strong one. This layer is deliberately light: it makes
casual sharing inconvenient, ties each download to a licence, and keeps the
community friendly by never touching basic driving.

## The in-game flow

```
Track loads
  |
  1. Read extension/gv_licence.ini (LICENCE_ID, COPY_ID, TRACK_ID, TYPE, API)
  |     missing, broken or TRACK_ID of another track  -> state 'locked' (no_ini / bad_ini / track_mismatch)
  |
  2. Get or create the machine hash in ac.storage (random, 48 chars, created once per PC)
  |
  3. Last success for this licence less than 72 h ago?  -> state 'grace' (reason 'cached'), extras on at once
  |   otherwise                                         -> state 'checking', extras off
  |
  4. POST /activate  { track_id, machine_hash, licence_id [, licence_key] }
  |     ok      -> keep token in memory, store lastOkAt = now, state 'licensed'
  |     refused -> see "Reason codes"
  |     offline -> 72 h grace rule (step 6)
  |
  5. Every next_check_in seconds (600 by default, clamped to 60..3600):
  |     POST /validate { token }
  |     ok                                          -> lastOkAt = now, stay 'licensed'
  |     expired_token / bad_token / unknown_machine -> back to step 4 at once
  |     refused                                     -> see "Reason codes"
  |
  6. API unreachable (no network, DNS, timeout, HTTP 5xx, invalid JSON, rate_limited):
        last success for this licence within 72 h -> state 'grace', extras stay on
        otherwise                                 -> state 'locked' (offline or grace_expired)
        retry after 60 s, then 120, 240 ... up to 30 min (or Retry-After)
```

States the script reports through `onState(state, reason)`:

| State | Extras | Meaning |
|---|---|---|
| `checking` | off | first check running, no recent success on this PC |
| `licensed` | on | the API confirmed the licence in this session |
| `grace` | on | API not reachable (or not answered yet) but a success is less than 72 h old |
| `locked` | off | refused by the API, no valid licence file, or offline for more than 72 h |

`GvLicence.isLicensed()` is true for `licensed` and `grace`.

## What to gate, and what never to gate

Gate the extras that make the paid track special, as the owner listed them:

- **Lights**: night lighting, floodlights, emissive lamps.
- **Animations**: flags, crowd, cranes, moving set pieces.
- **Evolving grip**: rubbering in, grip changes over a session.
- **Timing**: custom timing towers, sector boards, the track's own timing displays.

Never gate:

- **Basic driving.** The track must load, drive and time laps through Assetto
  Corsa's own timing exactly as an unlicensed track would. Physics, surfaces,
  collisions, pit lane and AI lines stay untouched.
- Anything that would make a car crash, spin or lose grip suddenly. When a
  feature turns off mid-session it should fade out or switch at a safe moment,
  never change the car's behaviour under the driver.

The reason: a false negative (an honest buyer offline for four days, a Worker
bug, a corporate firewall) must never be catastrophic. In the worst case the
buyer loses the extras until the next successful check, not the track.

## Files on the player's PC

| File | Written by | Content |
|---|---|---|
| `content/tracks/<folder>/extension/gv_licence.ini` | the Worker, inside the download zip | licence id, copy id, track id, type, API origin, signature. No personal data. |
| `content/tracks/<folder>/extension/gv_licence_key.ini` | the venue, by hand (commercial only) | `[LICENCE]` `LICENCE_KEY=GVC-XXXX-XXXX-XXXX-XXXX` |
| `Documents/Assetto Corsa/cfg/extension/state/lua/...` | CSP, through `ac.storage` | `gvlic_machineHash`, `gvlic_lastOkAt`, `gvlic_lastOkLicence` |

`gv_licence.ini` as delivered (CONTRACT.md section 5):

```ini
[LICENCE]
LICENCE_ID=lic_k3m9x2q7w4e8r1t5y6u0p2a3
COPY_ID=cp_8f2k4m6n1p3r5t7v9x0z2b4d
TRACK_ID=example-circuit
TYPE=personal
ISSUED=2026-11-16T12:00:00Z
API=https://licence.globalvisions.it
SIGNATURE=<base64url HMAC-SHA256 of the five lines above, key FINGERPRINT_SECRET>
```

The script uses `API=` as the API origin unless `init{ api = ... }` overrides it,
so the origin is never hard coded in the script.

The token from `/activate` is kept in memory only and is never written to disk.

### Fingerprint and leak tracing

Every download gets its own `COPY_ID`, recorded by the Worker in `downloads`
together with the licence it was made for. If a build turns up on a sharing site:

1. Open its `extension/gv_licence.ini` and take `COPY_ID`.
2. In the admin, or with `GET /admin/copies/:copy_id` (admin token), see the
   licence, the Steam ID, the track and the download date.
3. Check `SIGNATURE` with the server side `FINGERPRINT_SECRET`. A valid signature
   proves the file was issued by Global Visions and not edited. A copy id that was
   changed by hand breaks the signature.
4. Act on the licence: revoke it (`/admin/licences/:id/revoke`) or reset its
   machines, as the store terms allow.

A shared copy that keeps the ini is traceable and also runs into the machine
limit, because every PC that uses it registers against the same licence. A copy
with the ini deleted loses the extras (`no_ini`) and still cannot join servers
running the plugin.

## HTTP requests and responses

All calls are `POST` with a JSON body, no cookies, CORS `*`. Steam IDs, if sent,
are strings. Answers are `{ "ok": true, ... }` or `{ "ok": false, "reason": "..." }`.
The script treats any HTTP status below 500 with a JSON body as an answer, and
anything else as "unreachable".

### Activate, personal licence

```http
POST https://licence.globalvisions.it/activate
Content-Type: application/json

{
  "track_id": "example-circuit",
  "machine_hash": "gvm_Q8f2LmX0aT4kP9sR1vB7nC3yD6eH5jW2uZ8gK0iO4q",
  "licence_id": "lic_k3m9x2q7w4e8r1t5y6u0p2a3"
}
```

```json
{ "ok": true, "token": "<opaque>", "expires_in": 3600, "licence_id": "lic_k3m9x2q7w4e8r1t5y6u0p2a3", "next_check_in": 600 }
```

Only when the licence id is unknown (no ini) the contract also allows
`"steam_id": "76561198000000000"` instead of `licence_id`. The reference module
always has a licence id and sends the Steam ID only with `includeSteamId = true`.

### Activate, commercial licence

```http
POST https://licence.globalvisions.it/activate
Content-Type: application/json

{
  "track_id": "example-circuit",
  "machine_hash": "gvm_Q8f2LmX0aT4kP9sR1vB7nC3yD6eH5jW2uZ8gK0iO4q",
  "licence_id": "lic_c0mm3rc1a1x2q7w4e8r1t5y6",
  "licence_key": "GVC-ABCD-EFGH-JKLM-NPQR"
}
```

Same answers as personal.

### Validate with the token

```http
POST https://licence.globalvisions.it/validate
Content-Type: application/json

{ "token": "<opaque token from /activate>" }
```

```json
{ "ok": true, "next_check_in": 600 }
```

```json
{ "ok": false, "reason": "expired_token" }
```

`/validate` also accepts the full `/activate` body. In that form it activates
implicitly if this machine is already registered, but it never registers a new
machine (`unknown_machine`). The reference module uses the token form and falls
back to `/activate`.

### Refusal examples

```json
{ "ok": false, "reason": "machine_limit" }
{ "ok": false, "reason": "too_many_active" }
{ "ok": false, "reason": "refunded" }
{ "ok": false, "reason": "rate_limited" }
```

## Reason codes and what the script does

| Reason | Meaning (contract) | Script action | Next try |
|---|---|---|---|
| `no_licence` | no licence matches the id (or Steam ID) for this track | `locked`, clear last success | 30 min |
| `refunded` | the order was refunded | `locked`, clear last success | 60 min |
| `disabled` | revoked by Global Visions (for example after a leak) | `locked`, clear last success | 60 min |
| `unknown_machine` | `/validate` for a machine that is not registered (or was released on the store account page) | call `/activate` at once to register it | immediate |
| `machine_limit` | the licence already has `max_machines` registered machines | `locked`, clear last success; the buyer can release a machine at https://globalvisions.it/store/ (account page) | 30 min |
| `too_many_active` | too many registered machines in use in the last 15 minutes | `locked` for now, last success kept | 5 min |
| `bad_token` | token not recognised | drop token, `/activate` at once (at most twice in a row, then treated as unreachable) | immediate |
| `expired_token` | token older than `expires_in` (3600 s) | drop token, `/activate` at once | immediate |
| `bad_request` | the request was malformed (broken ini, script bug) | treated like unreachable, so the 72 h grace applies; warning in the CSP log | 30 min |
| `rate_limited` | too many calls from this client | treated like unreachable, grace applies | `Retry-After` or backoff |
| (network error, timeout, HTTP 5xx, invalid JSON) | API unreachable | grace rule | 60 s doubling to 30 min |
| (any other reason) | contract changed after this script shipped | treated like unreachable, warning in the log | backoff |

Local reasons, never sent by the API:

| Reason | Meaning |
|---|---|
| `starting` | `checking` before the first answer |
| `cached` | `grace` at load, from a success less than 72 h old |
| `offline` | `grace` or `locked` because the API could not be reached |
| `grace_expired` | `locked`: offline and the last success is more than 72 h old |
| `no_ini`, `bad_ini`, `track_mismatch` | `locked`: licence file missing, unreadable, or from another track |
| `no_api` | `locked`: no `https://` API origin in the ini or options |
| `token_loop` | token kept failing, treated as unreachable |

## Timings

| Value | Source | Used for |
|---|---|---|
| `next_check_in` 600 s | API answer | period of `/validate` (clamped to 60..3600 s) |
| `expires_in` 3600 s | API answer | token lifetime; on `expired_token` the script re-activates |
| 15 minutes | contract rule | a machine counts as "in use" if seen in the last 15 min (`too_many_active`) |
| 72 hours | contract recommendation, `graceHours` option | offline grace since the last success |
| 60 s to 30 min | script | retry backoff while unreachable |
| 4 / 5 / 5 / 8 s | script (`web.timeouts`) | DNS / connect / send / receive timeouts |

## Module API (`gv_licence.lua`)

```lua
local GvLicence = require('gv_licence')

GvLicence.init{
  trackId        = 'example-circuit',   -- required in practice: must equal TRACK_ID in the ini
  api            = nil,                 -- optional override of API= in the ini
  onState        = function(state, reason) end,
  iniPath        = nil,                 -- optional explicit path to gv_licence.ini
  licenceKey     = nil,                 -- commercial: GVC-... (else read from gv_licence_key.ini)
  graceHours     = 72,
  includeSteamId = false,               -- send steam_id along with licence_id
  log            = true,                -- ac.log / ac.warn lines prefixed [GvLicence]
}

GvLicence.isLicensed()   -- true in 'licensed' and 'grace'
GvLicence.getState()     -- state, reason
GvLicence.copyId()       -- COPY_ID of this download, for support
GvLicence.check()        -- force a check now
GvLicence.stop()         -- stop the timer
```

Personal data handled by the module: the machine hash (random, not derived from
hardware) and, only with `includeSteamId = true`, the SteamID64. No driver name,
no hardware details. The API, like any web server, sees the PC's IP address.

## Wiring checklist

1. **Script files.** Put the track script, `gv_licence.lua` (after the owner's
   obfuscation, or inlined into the main script) and optionally the gates in
   `content/tracks/<folder>/extension/`. If `require('gv_licence')` does not
   resolve a sibling file in track scripts, inline the module and replace the
   `require` with a local table. VERIFY against CSP docs.
2. **Script section in `ext_config.ini`.** In
   `content/tracks/<folder>/extension/ext_config.ini`:
   ```ini
   [SCRIPT_GV_LICENCE]
   SCRIPT = gv_track.lua              ; VERIFY against CSP docs: key name and path base
   trackId = example-circuit          ; read with ac.configValues{ trackId = '' }
   ```
   The `[SCRIPT_...]` section type and `ac.configValues` are documented in the
   CSP Lua SDK (`ac_track_script.lua`), which also advises lowerCamelCase for
   custom keys so they never collide with CSP's own keys. The exact key that names
   the Lua file, whether paths are relative to `extension/`, and any minimum CSP
   version key: VERIFY against CSP docs.
3. **Minimum CSP version.** Track scripts, `web.post` and `ac.storage` need a
   recent CSP. Set the track's required CSP version in `ext_config.ini`
   (VERIFY against CSP docs for the key, usually under `[BASIC]`), and test with
   the oldest version you support.
4. **Start state.** Initialise every gated feature to off before calling
   `GvLicence.init`, then switch on in `onState` (see `feature_gates_example.lua`).
5. **Track id.** Pass the same `track_id` as in the store (`tracks.track_id`),
   either in code or through `trackId = ...` in the script section.
6. **Never gate driving.** Review the list above before release.
7. **Clean build.** The zip uploaded to R2 must not contain a
   `gv_licence.ini`: the Worker appends one per download.
8. **Logs.** In the CSP Lua debug app, look for `[GvLicence] state licensed ok`.
9. **Test** the cases below before release.

## Test plan (in game)

| # | Setup | Expected |
|---|---|---|
| 1 | fresh download, online | `checking` then `licensed`, extras on |
| 2 | restart AC within 72 h, network unplugged | `grace cached` at load, then `grace offline`, extras stay on |
| 3 | clock or wait past 72 h offline | `locked grace_expired`, extras off, driving normal |
| 4 | delete `gv_licence.ini` | `locked no_ini`, extras off, driving normal |
| 5 | copy the track to a third PC on a 2 machine licence | third PC: `locked machine_limit` |
| 6 | release a machine on the store account page, wait up to 30 min (or restart) | third PC activates |
| 7 | 2 machine licence, PCs A and B in use; release A on the store account page and start the track on PC C straight away | C gets `too_many_active` while A still counts as in use (seen in the last 15 min), then activates on a later retry |
| 8 | admin revokes the licence | next check (up to 10 min): `locked disabled`; offline afterwards does not bring extras back |
| 9 | commercial copy without `gv_licence_key.ini` | `/activate` refused, extras off |

## Honest limits

- **Client checks can be bypassed.** Anyone who can edit the script, patch the
  HTTP answer or block the check and set the clock back can turn the extras on.
  Obfuscation slows this down; it does not stop a determined person.
- **The clock is the player's.** The 72 h grace uses the PC clock. A timestamp
  from the future is rejected, but moving the clock back during an outage can
  stretch the grace.
- **What this layer is for:** inconvenience for casual sharing, traceability of
  every download through `COPY_ID`, and keeping unlicensed copies out of
  organised online races (together with the server plugin, which is the real
  gate online).
- **Keep the DRM light.** The sim racing community dislikes heavy DRM, and
  honest buyers pay its cost. Check rarely, fail soft, never touch driving, never
  collect more than the machine hash and Steam ID, and say plainly on the store
  page what the track checks and why.
- **Future hardening, if ever needed.** CSP ships an RSA signing helper
  (`shared/utils/signing`, with placeholders such as `{VerifiedSteamID}` and
  `{UniqueMachineKey}`) that lets a server verify that a message came from an
  unmodified CSP. It is not part of the contract today and may not be reachable
  from track scripts. VERIFY against CSP docs before relying on it.

## CSP APIs to confirm

Every uncertain call in `gv_licence.lua` and `feature_gates_example.lua` is
marked `-- VERIFY:`. Checked against the public SDK definitions
(`github.com/ac-custom-shaders-patch/acc-lua-sdk`, August 2026) and CSP's own
Lua scripts, but not run inside a track script.

| API | Used for | What is known | Still to check |
|---|---|---|---|
| `web.post(url, headers, data, cb(err, response))`, `response.status/headers/body` | `/activate`, `/validate` | defined in `common/ac_web.lua`; max 2 concurrent requests per script | available in track scripts (track scripts load a reduced library set) |
| `web.timeouts(resolve, connect, send, receive)` | fast offline detection | defined in `common/ac_web.lua` | same |
| `ac.storage(layout, keyPrefix)` | machine hash, last success | defined in `common/ac_storage.d.lua`, saves to `cfg/extension/state/lua` | available and persistent in track scripts |
| `ac.INIConfig.load(path)`, `:get(section, key, default)`, `.sections` | reading `gv_licence.ini` | defined in `common/ac_extras_ini.lua` | track scripts may read files inside their own folder (CSP wiki: not outside it) |
| `ac.getFolder(ac.FolderID.ContentTracks)`, `ac.getTrackID()` | path of the ini | used in CSP's own tools | available in track scripts |
| `__dirname` | path of the ini next to the script | used in CSP's own scripts | set for track scripts |
| `setTimeout`, `clearTimeout` | check timer | defined in `common/internal.lua` | none |
| `os.time()`, `os.preciseClock()` | grace period, random seed | used widely in CSP's own scripts | available in track scripts (built "withoutIO") |
| `JSON.stringify`, `JSON.parse` | request and response bodies | defined in `common/json` (also in the reduced library set) | none |
| `ac.getUserSteamID()` | optional `steam_id` | not found in the public SDK; CSP's own code uses `steam.user.getSteamID()` from `lua-shared` | the real name of the current user's Steam ID call in track scripts |
| `require('gv_licence')` | loading the module | standard in CSP apps | resolves sibling files for track scripts |
| `ac.configValues{ trackId = '' }` | track id from `ext_config.ini` | defined in `ac_track_script.lua` | none |
| `ac.findNodes`, `ac.findMeshes`, `:setVisible`, `:setMaterialProperty('ksEmissive', ...)` | feature gates example | used widely in CSP's own scripts | node names and material properties of your KN5 |
| `[SCRIPT_...]` section keys in `ext_config.ini` | wiring | section type documented in the SDK | the key that names the Lua file, path base, minimum CSP version key |
