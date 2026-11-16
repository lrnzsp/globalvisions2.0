# GvLicencePlugin for AssettoServer

Server side licence check for paid Global Visions tracks. When a player joins a
race server running [AssettoServer](https://github.com/compujuckel/AssettoServer),
the plugin takes their Steam ID, asks the Global Visions licence API whether
that Steam account owns a licence for the track the server runs, and turns the
player away with a clear message (including https://globalvisions.it/store/) if
it does not.

The API it talks to is defined in `docs/store/CONTRACT.md`, section 7
(`POST /server/check`).

## Why the server layer matters

The in-game CSP script (see `csp-integration/`) runs on the player's PC. Anything
that runs on the player's PC can be patched, so that layer is about convenience
and traceability, not hard protection.

This plugin runs on the race server, which the player does not control:

- The player cannot edit it, skip it or fake its answer.
- The Steam ID it checks is the one AssettoServer verified with Steam (see the
  next section), not a value the client typed in.
- Leagues and public servers are where a pirated copy is worth the most. A
  leaked build that cannot join organised online races loses most of its value.

So this is the most important protection layer. The client script is a second,
lighter layer on top.

## Hard requirement: Steam authentication must be on

A Steam ID is only trustworthy if AssettoServer validated the player's Steam
session ticket. Without that, any client can send any Steam ID in the handshake
and pose as a buyer.

In `cfg/extra_cfg.yml`:

```yaml
UseSteamAuth: true          # AssettoServer validates the Steam session ticket (needs CSP 0.1.75+ and a recent Content Manager)
EnableACProSupport: false   # with ACPro support the "Steam ID" is derived from the driver name
```

`UseSteamAuth` is the current name (default `true`) at AssettoServer commit
`83a192b` (14 Nov 2026). VERIFY the name on the version you run
(`AssettoServer/Server/Configuration/Extra/ACExtraConfiguration.cs`).

The plugin refuses to start if `UseSteamAuth` is false or `EnableACProSupport`
is true. The `AllowWithoutSteamAuth: true` option skips this check for local
tests only. Never use it on a public server.

AssettoServer runs its own Steam filter before plugin filters (it is registered
first in `Startup.cs`), so a player with a forged ID is refused by AssettoServer
before this plugin ever calls the API.

## How it works

```
Player joins
  -> AssettoServer: protocol, blacklist, password, CSP features
  -> AssettoServer SteamSlotFilter: Steam ticket valid?            (no: "Steam authentication failed.")
  -> GvLicenceService.ShouldAcceptConnectionAsync                   (this plugin)
       track not mapped to a track_id?  -> accept (warning at startup)
       Steam ID on AllowList?           -> accept
       server admin (AllowAdmins)?      -> accept
       cache fresh?                     -> use cached answer
       POST {ApiOrigin}/server/check  { "steam_id": "7656...", "track_id": "example-circuit" }
         { ok: true }                   -> accept, cache CacheMinutes
         { ok: false, reason }          -> refuse with KickMessage, cache NegativeCacheMinutes
         no usable answer               -> recent positive in cache? accept
                                           else FailOpen ? accept + warning : refuse
  -> AssettoServer whitelist and entry list GUID filters
  -> car slot given, player loads
```

### Rejection modes

**`RejectMode: Handshake` (default, recommended).** AssettoServer has a chain of
"open slot filters" (`IOpenSlotFilter`). Each one can refuse a connection during
the handshake by returning an `AuthFailedResponse` with a message. The official
WordFilterPlugin uses the same hook to refuse forbidden driver names. The player
sees the message in Content Manager, never loads the track, never takes a slot,
and other drivers see nothing.

**`RejectMode: KickAfterConnect` (fallback).** For AssettoServer builds where
the filter hook does not exist or behaves differently. The player is accepted,
the lookup starts at once (on `EntryCarManager.ClientConnected`), and when the
player's first position update is sent (`ACTcpClient.FirstUpdateSent`) an
unlicensed player gets a private chat line and is kicked two seconds later with
the same text as kick reason (`broadcastReason: null`, so it is not announced).
The player briefly loads the track, which is why this is only the fallback.

In both modes the check happens at join. A licence refunded during a session
takes effect the next time that player joins (after the cache expires).

## Build

The plugin is a .NET class library that references AssettoServer. Build it
against the same AssettoServer version you run on the server.

**In tree (recommended).**

```sh
git clone https://github.com/compujuckel/AssettoServer.git
cd AssettoServer
git checkout <the tag or commit your server runs>
cp -r /path/to/globalvisions2.0/assettoserver-plugin Plugins/GvLicencePlugin
dotnet publish Plugins/GvLicencePlugin -c Release -r linux-x64     # or win-x64
# output: out-linux-x64/plugins/GvLicencePlugin/GvLicencePlugin.dll
```

AssettoServer's `Plugins/Directory.Build.props` supplies the target framework,
the references and the output folder, which is why the official plugins have an
empty `.csproj`.

**Out of tree.**

```sh
dotnet publish assettoserver-plugin -c Release -r linux-x64 -p:AssettoServerRepo=/path/to/AssettoServer
# output: assettoserver-plugin/out/GvLicencePlugin/
```

At commit `83a192b` AssettoServer targets `net11.0`. VERIFY the target framework
on your version and update `GvLicencePlugin.csproj` if it differs.

## Install

1. Copy the folder `GvLicencePlugin/` (containing `GvLicencePlugin.dll`) to
   `<server>/plugins/GvLicencePlugin/`. The folder name must equal the dll name.
2. In `cfg/extra_cfg.yml`:
   ```yaml
   UseSteamAuth: true
   EnableACProSupport: false
   EnablePlugins:
     - GvLicencePlugin
   ```
3. Copy `example.yml` to `cfg/plugin_gv_licence_cfg.yml` and fill in `ServerKey`
   and `TrackId` (or `TrackMap`). The file name comes from the configuration
   class name (`GvLicenceConfiguration` becomes `plugin_gv_licence_cfg.yml`).
4. Make sure the server can reach the API origin over HTTPS (outbound port 443).
5. Start the server. Look for the startup line:
   `GvLicencePlugin: track 'gv_example_circuit' (layout '') -> track_id 'example-circuit'. Mode Handshake, FailOpen True, ...`

If you enable the plugin before creating its config file, AssettoServer writes a
default `plugin_gv_licence_cfg.yml` and the plugin stops the server with
"ServerKey is empty", so you never run unprotected by accident.

## Configuration

All keys live in `cfg/plugin_gv_licence_cfg.yml`. AssettoServer also writes
`cfg/plugin_gv_licence_cfg.reference.yml` with every key and its description.

| Key | Default | Meaning |
|---|---|---|
| `ApiOrigin` | `https://licence.globalvisions.it` | Worker origin, no path. `http://` only for localhost. |
| `ServerKey` | empty (required) | Secret from Global Visions, sent as `Authorization: Bearer <key>`. |
| `TrackId` | empty | `track_id` used when `TrackMap` has no match. |
| `TrackMap` | empty | Server track folder (or `folder/layout`) to `track_id`. `folder/layout` beats `folder`, both beat `TrackId`. |
| `CacheMinutes` | 10 | How long "has a licence" is reused. |
| `NegativeCacheMinutes` | 1 | How long "no licence" is reused. Short, so a new buyer can join quickly. |
| `StaleIfErrorHours` | 24 | During an outage, a positive answer up to this old still lets the player in, even with `FailOpen: false`. |
| `FailOpen` | `true` | No usable answer and no recent positive: `true` lets the player in with a warning, `false` refuses. |
| `RequestTimeoutSeconds` | 5 | Timeout per API call. The handshake waits for it. |
| `OutageBackoffSeconds` | 30 | After a failed call, the API is skipped for this long and `FailOpen` applies at once. |
| `RejectMode` | `Handshake` | `Handshake` or `KickAfterConnect`. |
| `KickMessage` | see `example.yml` | Text for refused players. `{track}`, `{reason}`, `{store}` are filled in. Max 200 characters. |
| `StoreUrl` | `https://globalvisions.it/store/` | Value of `{store}`. |
| `AllowList` | empty | SteamID64 strings that skip the check (staff, venue seats). |
| `AllowAdmins` | `true` | Admins (admin password at join, or in AssettoServer's admin group, `admins.txt` by default) skip the check. |
| `AllowWithoutSteamAuth` | `false` | Local tests only. |

A track that matches neither `TrackMap` nor `TrackId` is not checked: the
plugin logs a warning at startup and lets everyone in. This is on purpose for
servers that rotate presets that include tracks not sold by Global Visions.
`track_id` values must equal `tracks.track_id` in the Worker (for example
`example-circuit`).

Messages a refused player sees (defaults):

| API reason | Message |
|---|---|
| `no_licence` | This server runs a paid Global Visions track (example-circuit). Your Steam account has no licence for it. Get a licence at https://globalvisions.it/store/ |
| `refunded` | ... Your licence for it was refunded. Get a licence at ... |
| `disabled` | ... Your licence for it is disabled, please contact Global Visions. Get a licence at ... |
| API down, `FailOpen: false` | ... The licence service cannot be reached right now, please try again in a few minutes. Get a licence at ... |

## Commercial venues

A venue with a commercial licence runs rigs that may log in with many Steam
accounts, or with accounts that hold no personal licence. Per the contract, a
venue's own server can whitelist its machines locally instead of asking the API:

- **Plugin AllowList.** Put the Steam ID of every rig account in `AllowList`.
  Listed accounts get in without any API call. Walk-in players with their own
  accounts are still checked against the API. The venue still needs a
  `ServerKey` for those API calls.
- **AssettoServer's own whitelist, no plugin.** For a closed LAN server where only
  the venue's rigs ever connect, do not enable the plugin at all and list the rig
  Steam IDs in AssettoServer's whitelist (`whitelist.txt`, the
  `default_whitelist` user group). An empty whitelist file lets everyone in, so
  make sure it is filled.

The commercial licence key itself (`GVC-...`) is never used by the plugin. It
belongs to the in-game script on the venue's PCs.

## Rate limiting and caching

The plugin is designed so a busy server stays far below any sensible Worker rate
limit and so an outage never slows joins down:

- **Cache per Steam ID and track.** Positive answers for `CacheMinutes`,
  negative answers for `NegativeCacheMinutes`. A driver who reconnects five times
  in a minute costs one call.
- **Request coalescing.** Simultaneous joins for the same Steam ID share one
  HTTP call.
- **At most 4 calls in flight.** A grid of 30 joining at once queues briefly
  instead of bursting.
- **Outage backoff.** After a timeout, network error, HTTP 5xx, 429 or a
  rejected key, the API is skipped for `OutageBackoffSeconds` (or the
  `Retry-After` value on a 429, capped at 5 minutes). During that time joins are
  decided immediately from the cache or `FailOpen`, without waiting for a timeout.
- **Stale if error.** A player with a positive answer in the last
  `StaleIfErrorHours` keeps getting in while the API is down.
- The cache lives in memory. A server restart starts empty. It is trimmed when
  it grows past 10,000 entries.

How API answers are handled:

| Answer | Treated as |
|---|---|
| `{ ok: true }` with 2xx | licensed |
| `{ ok: false, reason: no_licence / refunded / disabled }` (any status below 500 except 401, 403, 429) | refused |
| HTTP 401 or 403 | unavailable, logged at Error: the server key is wrong |
| HTTP 429 or `reason: rate_limited` | unavailable, backoff honours `Retry-After` |
| HTTP 5xx, timeout, DNS or TLS error, invalid JSON | unavailable |
| any other `reason` (for example `bad_request` for an unknown `track_id`) | unavailable, logged at Error |

"Unavailable" always means: recent positive in cache, otherwise `FailOpen`.

## Logging

All lines start with `GvLicencePlugin:`. The server key is never logged.

| Level | When |
|---|---|
| Information | startup summary (track folder, track_id, mode, FailOpen, cache, API origin) |
| Information | each decision: licensed (`ok`, `cache` or `stale_cache`), on AllowList, admin, refused with reason |
| Warning | track not mapped (checks off), API unavailable with the reason and whether the player was let in |
| Warning | running with `AllowWithoutSteamAuth: true` |
| Error | key rejected (401/403) or unexpected API reason, at most once a minute |
| Error | the check itself crashed (the player is then treated like an outage) |
| Debug | network error details |

Steam IDs and driver names appear in the log, as they already do in
AssettoServer's own join lines.

## Manual test plan

Use a test server with `UseSteamAuth: true`, a mapped track, and two Steam
accounts: A owns a personal licence for the track, B does not.

| # | Setup | Action | Expected |
|---|---|---|---|
| 1 | config file missing | start server | server stops: "ServerKey is empty" |
| 2 | `UseSteamAuth: false` | start server | server stops with the Steam auth message |
| 3 | track folder not in `TrackMap`, no `TrackId` | start, join with B | warning at startup, B joins |
| 4 | normal config | join with A | log "has a licence ... (ok)", A drives |
| 5 | same | A leaves and rejoins within 10 min | log "(cache)", no API call in the Worker logs |
| 6 | same | join with B | Content Manager shows the `no_licence` message with the store URL, B never loads |
| 7 | same | B buys a licence, waits 1 min, joins | B joins |
| 8 | admin revokes A's licence (`/admin/licences/:id/revoke`), wait `CacheMinutes` | A joins | refused with the "disabled" message |
| 9 | add B's Steam ID to `AllowList`, restart | B joins | log "is on the AllowList", no API call |
| 10 | B joins with the admin password, `AllowAdmins: true` | | log "is a server admin" |
| 11 | wrong `ServerKey` | join with A | Error "rejected ServerKey"; with `FailOpen: true` A joins, with `false` A is refused with the "cannot be reached" message |
| 12 | `ApiOrigin` pointing at a blackhole (for example `https://10.255.255.1`), `FailOpen: true` | join with B | join waits about 5 s, warning, B joins. Next join within 30 s is instant |
| 13 | same, `FailOpen: false` | A joined earlier (cached positive), then B joins | A gets in (`stale_cache`), B is refused |
| 14 | `RejectMode: KickAfterConnect` | join with B | B loads, sees the chat line, is kicked 2 s later with the message; other drivers see no broadcast |
| 15 | 10 clients join at once (or a scripted loop of reconnects) | | at most 4 concurrent calls, one call per Steam ID |

## Hooks to confirm

Every AssettoServer type and member the plugin relies on was read in the
AssettoServer source at commit `83a192b` (14 Nov 2026) but the plugin has not
been compiled or run. Each is marked `// VERIFY:` in the code. Re-check them
against the exact version you build with.

| # | Hook | Used in | Where to check in AssettoServer | Status at 83a192b |
|---|---|---|---|---|
| 1 | `AssettoServerModule<TConfig>`, `ReferenceConfiguration`, `Load(ContainerBuilder)` | `GvLicenceModule.cs` | `AssettoServer/Server/Plugin/AssettoServerModule.cs` | confirmed |
| 2 | Plugin discovery: `plugins/<Name>/<Name>.dll`, enabled via `EnablePlugins` | README, install | `Server/Plugin/ACPluginLoader.cs`, `ACExtraConfiguration.EnablePlugins` | confirmed |
| 3 | Config file name `plugin_gv_licence_cfg.yml` derived from the class name | README, `example.yml` | `ACPluginLoader.ConfigurationTypeToFilename` | confirmed |
| 4 | `IValidateConfiguration<TValidator>` with FluentValidation `AbstractValidator<T>` | `GvLicenceConfiguration.cs` | `Server/Configuration/IValidateConfiguration.cs`, `ACServerConfiguration.LoadPluginConfiguration` | confirmed |
| 5 | Missing config file: default object registered without validation | `StartAsync` guard | `Startup.cs` (`RegisterType(plugin.ConfigurationType)`) and `LoadPluginConfiguration` | confirmed |
| 6 | `IOpenSlotFilter` / `OpenSlotFilterBase.ShouldAcceptConnectionAsync(ACTcpClient, HandshakeRequest)` returning `Task<AuthFailedResponse?>`, registered with `.As<IOpenSlotFilter>()` | `GvLicenceService`, module | `Server/OpenSlotFilters/*.cs`, `Plugins/WordFilterPlugin` | confirmed |
| 7 | Filter order: `SteamSlotFilter` runs before plugin filters | security argument in README | `Startup.cs`: `RegisterSteam()` is called before the plugin module loop | confirmed |
| 8 | `AuthFailedResponse(string)` message shown to the player, length limit 255 (one byte length prefix) | `BuildMessage` | `AssettoServer.Shared/Network/Packets/Outgoing/Handshake/AuthFailedResponse.cs`, `PacketWriter.WriteString` | confirmed in code; confirm Content Manager shows the full text |
| 9 | `HandshakeRequest.Guid` (ulong), `.Name`, `.Password` | handshake filter | `AssettoServer.Shared/Network/Packets/Incoming/HandshakeRequest.cs` | confirmed |
| 10 | `ACServerConfiguration.Extra.UseSteamAuth`, `.Extra.EnableACProSupport` | `StartAsync` | `Server/Configuration/Extra/ACExtraConfiguration.cs` | confirmed |
| 11 | `ACServerConfiguration.CSPTrackOptions.Track` (folder without `csp/` prefix), `Server.TrackConfig` | track resolution | `Server/Configuration/ACServerConfiguration.cs`, `CSPTrackOptions.cs` | confirmed |
| 12 | `ServerConfiguration.CheckAdminPassword(string)`, `IAdminService.IsAdminAsync(ulong)` | `AllowAdmins` | `Server/Configuration/Kunos/ServerConfiguration.cs`, `Server/Admin/IAdminService.cs` | confirmed |
| 13 | `ConfigurationException` stops startup with a readable message when thrown from `IHostedService.StartAsync` | `StartAsync` | `Server/Configuration/ConfigurationException.cs`, `Program.cs` error handling | type confirmed; how it is reported not checked |
| 14 | `EntryCarManager.ClientConnected` fires inside the handshake, before `IsAdministrator` is set | KickAfterConnect | `EntryCarManager.TrySecureSlotAsync`, `ACTcpClient` handshake code | confirmed |
| 15 | `ACTcpClient.FirstUpdateSent`, `.IsAdministrator`, `.IsDisconnectRequested`, `.SendChatMessage(string)` | KickAfterConnect | `Network/Tcp/ACTcpClient.cs` | confirmed |
| 16 | `EntryCarManager.KickAsync(client, KickReason, auditReason, clientReason, broadcastReason, admin)` and `KickReason.Kicked` | KickAfterConnect | `Server/EntryCarManager.cs`, `AssettoServer.Shared/Network/Packets/Outgoing/KickCar.cs` | confirmed; confirm the client sees the reason (`CSPKickBanMessageOverride` needs CSP) |
| 17 | Plugin hosted services may start after `ACTcpServer` is listening | constructor resolves the track id early | `Startup.cs` registration order | confirmed; harmless |
| 18 | Target framework `net11.0` and `Plugins/Directory.Build.props` settings | `GvLicencePlugin.csproj` | `Plugins/Directory.Build.props`, `global.json` | confirmed |
| 19 | How long the AC client waits for a handshake answer (our call adds up to `RequestTimeoutSeconds`) | `RequestTimeoutSeconds` default 5 | Kunos client behaviour, test #12 | not checked |

If AssettoServer ever drops the open slot filter chain, switch to
`RejectMode: KickAfterConnect`, which only needs hooks 14 to 16.

## Files

| File | Purpose |
|---|---|
| `GvLicencePlugin.csproj` | project, in tree or out of tree build |
| `GvLicenceModule.cs` | Autofac module, plugin entry point |
| `GvLicenceConfiguration.cs` | YAML configuration and FluentValidation rules |
| `GvLicenceService.cs` | handshake filter, kick fallback, cache, API client |
| `example.yml` | sample `cfg/plugin_gv_licence_cfg.yml` |
