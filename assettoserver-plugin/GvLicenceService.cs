using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AssettoServer.Network.Tcp;
using AssettoServer.Server;
using AssettoServer.Server.Admin;
using AssettoServer.Server.Configuration;
using AssettoServer.Server.OpenSlotFilters;
using AssettoServer.Shared.Network.Packets.Incoming;
using AssettoServer.Shared.Network.Packets.Outgoing;
using AssettoServer.Shared.Network.Packets.Outgoing.Handshake;
using Microsoft.Extensions.Hosting;
using Serilog;

namespace GvLicencePlugin;

// ---------------------------------------------------------------------------
// Result of one licence lookup.
// ---------------------------------------------------------------------------

public enum GvCheckKind
{
    /// <summary>The API said { ok: true }.</summary>
    Allowed,
    /// <summary>The API said { ok: false, reason: no_licence | refunded | disabled }.</summary>
    Denied,
    /// <summary>No usable answer: timeout, network error, 5xx, 429, bad key, unexpected reply.</summary>
    Unavailable
}

public readonly record struct GvCheckResult(GvCheckKind Kind, string Reason, TimeSpan? RetryAfter = null)
{
    public static GvCheckResult Allowed(string reason = "ok") => new(GvCheckKind.Allowed, reason);
    public static GvCheckResult Denied(string reason) => new(GvCheckKind.Denied, reason);
    public static GvCheckResult Unavailable(string reason, TimeSpan? retryAfter = null) => new(GvCheckKind.Unavailable, reason, retryAfter);
}

// ---------------------------------------------------------------------------
// The join hook: handshake filter (preferred) or kick after connect (fallback).
// ---------------------------------------------------------------------------

/// <summary>
/// Checks every joining player against POST {ApiOrigin}/server/check and turns away
/// players without a licence for the track this server runs.
///
/// Handshake mode: AssettoServer calls <see cref="ShouldAcceptConnectionAsync"/> for
/// every connection attempt, after its own Steam ticket check and before a car slot
/// is given. Returning an AuthFailedResponse refuses the player with a message that
/// Content Manager shows. Nothing loads, no slot is used, nobody else sees it.
///
/// KickAfterConnect mode: the player is accepted, the lookup starts at once and the
/// player is kicked with a private message as soon as their first update is sent.
/// </summary>
// VERIFY: OpenSlotFilterBase / IOpenSlotFilter.ShouldAcceptConnectionAsync(ACTcpClient, HandshakeRequest)
// returning Task<AuthFailedResponse?> (AssettoServer/Server/OpenSlotFilters/, checked at commit 83a192b).
public sealed class GvLicenceService : OpenSlotFilterBase, IHostedService
{
    private static readonly ILogger Logger = Log.ForContext<GvLicenceService>();

    // AuthFailedResponse writes the text with a one byte length prefix (UTF-32 code points).
    // VERIFY: PacketWriter.WriteUTF32String in AssettoServer.Shared (255 character limit).
    private const int MaxClientMessageLength = 250;
    private const int MaxCacheEntries = 10_000;

    private readonly GvLicenceConfiguration _cfg;
    private readonly ACServerConfiguration _serverCfg;
    private readonly EntryCarManager _entryCarManager;
    private readonly IAdminService _adminService;
    private readonly GvLicenceApiClient _api;

    private readonly HashSet<ulong> _allowList;
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
    private readonly ConcurrentDictionary<string, Lazy<Task<GvCheckResult>>> _inFlight = new();

    private readonly string _trackFolder;
    private readonly string _trackLayout;
    private readonly string? _trackId;

    // While DateTime.UtcNow.Ticks is below this value the API is skipped (outage backoff).
    private long _skipApiUntilTicks;

    private sealed record CacheEntry(GvCheckResult Result, DateTime CheckedAt, DateTime ExpiresAt);

    private readonly record struct Decision(bool Allowed, string Reason, string? Message)
    {
        public static Decision Allow(string reason) => new(true, reason, null);
    }

    public GvLicenceService(
        GvLicenceConfiguration cfg,
        ACServerConfiguration serverCfg,
        EntryCarManager entryCarManager,
        IAdminService adminService,
        GvLicenceApiClient api)
    {
        _cfg = cfg;
        _serverCfg = serverCfg;
        _entryCarManager = entryCarManager;
        _adminService = adminService;
        _api = api;

        _allowList = (cfg.AllowList ?? new List<string>())
            .Select(s => ulong.TryParse(s?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : 0UL)
            .Where(id => id != 0)
            .ToHashSet();

        // CSPTrackOptions.Track is the plain folder name, without the "csp/<version>/../" prefix
        // that server_cfg.ini TRACK may carry.
        // VERIFY: ACServerConfiguration.CSPTrackOptions.Track and Server.TrackConfig (checked at commit 83a192b).
        var rawTrack = serverCfg.CSPTrackOptions.Track ?? serverCfg.Server.Track ?? "";
        _trackFolder = rawTrack.Replace('\\', '/').TrimEnd('/').Split('/').LastOrDefault() ?? "";
        _trackLayout = serverCfg.Server.TrackConfig ?? "";
        _trackId = ResolveTrackId(cfg, _trackFolder, _trackLayout);
    }

    // ---------------------------------------------------------------- startup

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Steam IDs are only trustworthy when AssettoServer validates the Steam session ticket.
        // With EnableACProSupport the "Steam ID" is derived from the driver name, so anyone could pose as anyone.
        // VERIFY: ACExtraConfiguration.UseSteamAuth and EnableACProSupport (extra_cfg.yml, checked at commit 83a192b).
        bool steamTrusted = _serverCfg.Extra.UseSteamAuth && !_serverCfg.Extra.EnableACProSupport;
        if (!steamTrusted)
        {
            const string message =
                "GvLicencePlugin: Steam IDs cannot be trusted on this server. Set UseSteamAuth: true and " +
                "EnableACProSupport: false in extra_cfg.yml. (AllowWithoutSteamAuth: true skips this check, for local tests only.)";
            if (!_cfg.AllowWithoutSteamAuth)
                throw new ConfigurationException(message);
            Logger.Warning("{Message} Continuing because AllowWithoutSteamAuth is true", message);
        }

        // If the plugin is enabled before its config file exists, AssettoServer writes a default file and
        // runs with default values without validating them. Stop here with a clear message instead.
        if (string.IsNullOrWhiteSpace(_cfg.ServerKey))
            throw new ConfigurationException("GvLicencePlugin: ServerKey is empty. Edit cfg/plugin_gv_licence_cfg.yml (see example.yml) and restart.");
        if (!_api.IsConfigured)
            throw new ConfigurationException($"GvLicencePlugin: ApiOrigin '{_cfg.ApiOrigin}' is not a valid URL.");

        if (_trackId == null)
        {
            Logger.Warning(
                "GvLicencePlugin: track '{TrackFolder}' (layout '{TrackLayout}') has no Global Visions track_id in TrackId or TrackMap. " +
                "Licence checks are OFF for this run and everyone can join",
                _trackFolder, _trackLayout);
        }
        else
        {
            Logger.Information(
                "GvLicencePlugin: track '{TrackFolder}' (layout '{TrackLayout}') -> track_id '{TrackId}'. Mode {Mode}, FailOpen {FailOpen}, " +
                "cache {CacheMinutes} min (negative {NegativeCacheMinutes} min), {AllowListCount} allow-listed Steam IDs, API {ApiOrigin}",
                _trackFolder, _trackLayout, _trackId, _cfg.RejectMode, _cfg.FailOpen,
                _cfg.CacheMinutes, _cfg.NegativeCacheMinutes, _allowList.Count, _cfg.ApiOrigin);
        }

        if (_cfg.RejectMode == GvRejectMode.KickAfterConnect)
        {
            // VERIFY: EntryCarManager.ClientConnected and ACTcpClient.FirstUpdateSent events
            // (checked at commit 83a192b; AutoModerationPlugin uses the same pair).
            _entryCarManager.ClientConnected += OnClientConnected;
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (_cfg.RejectMode == GvRejectMode.KickAfterConnect)
            _entryCarManager.ClientConnected -= OnClientConnected;
        return Task.CompletedTask;
    }

    // ------------------------------------------------------- handshake mode

    public override async Task<AuthFailedResponse?> ShouldAcceptConnectionAsync(ACTcpClient client, HandshakeRequest request)
    {
        if (_cfg.RejectMode == GvRejectMode.Handshake)
        {
            // VERIFY: HandshakeRequest.Guid (ulong SteamID64) and HandshakeRequest.Password; ServerConfiguration.CheckAdminPassword.
            bool adminByPassword = _cfg.AllowAdmins
                                   && !string.IsNullOrEmpty(request.Password)
                                   && _serverCfg.Server.CheckAdminPassword(request.Password);

            Decision decision;
            try
            {
                decision = await DecideAsync(request.Guid, request.Name, adminByPassword);
            }
            catch (Exception ex)
            {
                // A bug in this plugin must never block a whole server: follow FailOpen.
                Logger.Error(ex, "GvLicencePlugin: licence check crashed for {SteamId}", request.Guid);
                decision = _cfg.FailOpen
                    ? Decision.Allow("plugin_error")
                    : new Decision(false, "plugin_error", BuildMessage("The licence check failed, please try again in a few minutes"));
            }

            if (!decision.Allowed)
                return new AuthFailedResponse(decision.Message ?? BuildMessage("No licence"));
        }

        // Keep the chain going: AssettoServer's whitelist and GUID filters run after this one.
        return await base.ShouldAcceptConnectionAsync(client, request);
    }

    // ------------------------------------------------ kick after connect mode

    private void OnClientConnected(ACTcpClient client, EventArgs args)
    {
        // Start the lookup now so the answer is usually ready before the player finishes loading.
        // Admin by password is decided later: IsAdministrator is set after ClientConnected fires.
        var pending = DecideAsync(client.Guid, client.Name, adminByPassword: false);
        client.FirstUpdateSent += (sender, _) => _ = KickIfNeededAsync(sender, pending);
    }

    private async Task KickIfNeededAsync(ACTcpClient client, Task<Decision> pending)
    {
        try
        {
            var decision = await pending;
            if (decision.Allowed) return;
            if (_cfg.AllowAdmins && client.IsAdministrator) return;
            if (client.IsDisconnectRequested) return;

            var message = decision.Message ?? BuildMessage("No licence");

            // Chat line first for clients without CSP, then the kick. CSP clients also get the text
            // as the kick reason through CSPKickBanMessageOverride inside KickAsync.
            client.SendChatMessage(message);
            await Task.Delay(TimeSpan.FromSeconds(2));

            // broadcastReason: null keeps it private, other drivers do not see why.
            // VERIFY: EntryCarManager.KickAsync(client, KickReason, auditReason, clientReason, broadcastReason, admin).
            await _entryCarManager.KickAsync(client, KickReason.Kicked,
                auditReason: $"no Global Visions licence for {_trackId} ({decision.Reason})",
                clientReason: message,
                broadcastReason: null);
        }
        catch (Exception ex)
        {
            Logger.Error(ex, "GvLicencePlugin: could not kick {ClientName} ({SteamId})", client.Name, client.Guid);
        }
    }

    // ---------------------------------------------------------- the decision

    private async Task<Decision> DecideAsync(ulong steamId64, string? name, bool adminByPassword)
    {
        if (_trackId == null)
            return Decision.Allow("track_not_mapped");

        if (_allowList.Contains(steamId64))
        {
            Logger.Information("GvLicencePlugin: {ClientName} ({SteamId}) is on the AllowList", name, steamId64);
            return Decision.Allow("allow_list");
        }

        if (_cfg.AllowAdmins && (adminByPassword || await IsListedAdminAsync(steamId64)))
        {
            Logger.Information("GvLicencePlugin: {ClientName} ({SteamId}) is a server admin, no licence check", name, steamId64);
            return Decision.Allow("admin");
        }

        var steamId = steamId64.ToString(CultureInfo.InvariantCulture);
        var result = await CheckCachedAsync(steamId, _trackId);

        switch (result.Kind)
        {
            case GvCheckKind.Allowed:
                Logger.Information("GvLicencePlugin: {ClientName} ({SteamId}) has a licence for {TrackId} ({Source})",
                    name, steamId, _trackId, result.Reason);
                return Decision.Allow(result.Reason);

            case GvCheckKind.Denied:
                Logger.Information("GvLicencePlugin: refused {ClientName} ({SteamId}) on {TrackId}: {Reason}",
                    name, steamId, _trackId, result.Reason);
                return new Decision(false, result.Reason, BuildMessage(ReasonText(result.Reason)));

            default:
                if (_cfg.FailOpen)
                {
                    Logger.Warning("GvLicencePlugin: licence API unavailable ({Reason}). Letting {ClientName} ({SteamId}) in because FailOpen is true",
                        result.Reason, name, steamId);
                    return Decision.Allow("fail_open");
                }

                Logger.Warning("GvLicencePlugin: licence API unavailable ({Reason}). Refusing {ClientName} ({SteamId}) because FailOpen is false",
                    result.Reason, name, steamId);
                return new Decision(false, "unavailable",
                    BuildMessage("The licence service cannot be reached right now, please try again in a few minutes"));
        }
    }

    private async Task<bool> IsListedAdminAsync(ulong steamId64)
    {
        try
        {
            // VERIFY: IAdminService.IsAdminAsync(ulong) (AssettoServer/Server/Admin/IAdminService.cs).
            return await _adminService.IsAdminAsync(steamId64);
        }
        catch (Exception ex)
        {
            Logger.Warning(ex, "GvLicencePlugin: admin lookup failed for {SteamId}", steamId64);
            return false;
        }
    }

    // --------------------------------------------------------------- caching

    private async Task<GvCheckResult> CheckCachedAsync(string steamId, string trackId)
    {
        var key = trackId + ":" + steamId;
        var now = DateTime.UtcNow;

        _cache.TryGetValue(key, out var cached);
        if (cached != null && cached.ExpiresAt > now)
            return cached.Result with { Reason = cached.Result.Kind == GvCheckKind.Allowed ? "cache" : cached.Result.Reason };

        GvCheckResult result;
        if (now.Ticks < Interlocked.Read(ref _skipApiUntilTicks))
        {
            result = GvCheckResult.Unavailable("outage_backoff");
        }
        else
        {
            result = await CallDedupedAsync(key, steamId, trackId);
            if (result.Kind == GvCheckKind.Unavailable)
                StartBackoff(result.RetryAfter);
        }

        switch (result.Kind)
        {
            case GvCheckKind.Allowed:
                Store(key, result, now, TimeSpan.FromMinutes(_cfg.CacheMinutes));
                return result;

            case GvCheckKind.Denied:
                Store(key, result, now, TimeSpan.FromMinutes(_cfg.NegativeCacheMinutes));
                return result;

            default:
                // Stale if error: a recent positive answer beats FailOpen = false.
                if (cached is { Result.Kind: GvCheckKind.Allowed }
                    && now - cached.CheckedAt <= TimeSpan.FromHours(_cfg.StaleIfErrorHours))
                {
                    return GvCheckResult.Allowed("stale_cache");
                }
                return result;
        }
    }

    // Several joins for the same player at once (reconnect loops) share one HTTP call.
    private async Task<GvCheckResult> CallDedupedAsync(string key, string steamId, string trackId)
    {
        var lazy = _inFlight.GetOrAdd(key, _ => new Lazy<Task<GvCheckResult>>(() => _api.CheckAsync(steamId, trackId)));
        try
        {
            return await lazy.Value;
        }
        finally
        {
            _inFlight.TryRemove(new KeyValuePair<string, Lazy<Task<GvCheckResult>>>(key, lazy));
        }
    }

    private void StartBackoff(TimeSpan? retryAfter)
    {
        var seconds = retryAfter?.TotalSeconds ?? _cfg.OutageBackoffSeconds;
        seconds = Math.Clamp(seconds, 0, 300);
        if (seconds <= 0) return;
        Interlocked.Exchange(ref _skipApiUntilTicks, DateTime.UtcNow.AddSeconds(seconds).Ticks);
    }

    private void Store(string key, GvCheckResult result, DateTime now, TimeSpan ttl)
    {
        if (ttl <= TimeSpan.Zero && result.Kind != GvCheckKind.Allowed) return;

        // Positive entries are kept even with CacheMinutes 0 so StaleIfErrorHours still works.
        _cache[key] = new CacheEntry(result, now, now + ttl);

        if (_cache.Count > MaxCacheEntries)
        {
            var maxAge = TimeSpan.FromHours(Math.Max(1, _cfg.StaleIfErrorHours));
            foreach (var (k, entry) in _cache)
            {
                if (now - entry.CheckedAt > maxAge)
                    _cache.TryRemove(k, out _);
            }
        }
    }

    // --------------------------------------------------------------- helpers

    private static string? ResolveTrackId(GvLicenceConfiguration cfg, string folder, string layout)
    {
        var map = new Dictionary<string, string>(cfg.TrackMap ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrEmpty(layout) && map.TryGetValue($"{folder}/{layout}", out var byLayout))
            return byLayout.Trim();
        if (map.TryGetValue(folder, out var byFolder))
            return byFolder.Trim();
        return string.IsNullOrWhiteSpace(cfg.TrackId) ? null : cfg.TrackId.Trim();
    }

    private static string ReasonText(string reason) => reason switch
    {
        "no_licence" => "Your Steam account has no licence for it",
        "refunded" => "Your licence for it was refunded",
        "disabled" => "Your licence for it is disabled, please contact Global Visions",
        _ => "No valid licence was found"
    };

    private string BuildMessage(string reasonText)
    {
        var message = _cfg.KickMessage
            .Replace("{track}", _trackId ?? "", StringComparison.Ordinal)
            .Replace("{reason}", reasonText, StringComparison.Ordinal)
            .Replace("{store}", string.IsNullOrWhiteSpace(_cfg.StoreUrl) ? GvLicenceConfiguration.DefaultStoreUrl : _cfg.StoreUrl, StringComparison.Ordinal);
        return message.Length > MaxClientMessageLength ? message[..MaxClientMessageLength] : message;
    }
}

// ---------------------------------------------------------------------------
// HTTP client for POST {ApiOrigin}/server/check (CONTRACT.md section 7).
// ---------------------------------------------------------------------------

public sealed class GvLicenceApiClient : IDisposable
{
    private static readonly ILogger Logger = Log.ForContext<GvLicenceApiClient>();
    private static readonly HashSet<string> DenyReasons = new(StringComparer.Ordinal) { "no_licence", "refunded", "disabled" };

    private readonly HttpClient _http;
    private readonly Uri? _checkUri;
    private readonly string _serverKey;
    private readonly TimeSpan _timeout;

    // At most 4 calls in flight: a burst of joins never floods the Worker.
    private readonly SemaphoreSlim _concurrency = new(4, 4);
    private long _lastConfigErrorLogTicks;

    public bool IsConfigured => _checkUri != null;

    public GvLicenceApiClient(GvLicenceConfiguration cfg)
    {
        _serverKey = (cfg.ServerKey ?? "").Trim();
        _timeout = TimeSpan.FromSeconds(Math.Clamp(cfg.RequestTimeoutSeconds, 1, 15));

        var origin = (cfg.ApiOrigin ?? "").Trim().TrimEnd('/');
        _checkUri = Uri.TryCreate(origin + "/server/check", UriKind.Absolute, out var uri) ? uri : null;

        _http = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = _timeout
        })
        {
            // The per request timeout below covers the whole call, including the wait for a free slot.
            Timeout = Timeout.InfiniteTimeSpan
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("GvLicencePlugin/1.0");
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public async Task<GvCheckResult> CheckAsync(string steamId, string trackId, CancellationToken cancellationToken = default)
    {
        if (_checkUri == null || _serverKey.Length == 0)
            return GvCheckResult.Unavailable("not_configured");

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(_timeout);

        try
        {
            await _concurrency.WaitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            return GvCheckResult.Unavailable("busy");
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _checkUri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _serverKey);

            // JsonObject avoids reflection based serialization. Steam IDs travel as strings (they exceed 2^53).
            var body = new JsonObject { ["steam_id"] = steamId, ["track_id"] = trackId };
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

            using var response = await _http.SendAsync(request, cts.Token);
            var text = await response.Content.ReadAsStringAsync(cts.Token);
            return Interpret(response, text);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return GvCheckResult.Unavailable("timeout");
        }
        catch (HttpRequestException ex)
        {
            Logger.Debug(ex, "GvLicencePlugin: network error calling {Uri}", _checkUri);
            return GvCheckResult.Unavailable("network_error");
        }
        catch (Exception ex)
        {
            Logger.Warning(ex, "GvLicencePlugin: unexpected error calling {Uri}", _checkUri);
            return GvCheckResult.Unavailable("client_error");
        }
        finally
        {
            _concurrency.Release();
        }
    }

    private GvCheckResult Interpret(HttpResponseMessage response, string text)
    {
        var status = (int)response.StatusCode;

        if (status is 401 or 403)
        {
            LogConfigError("the API rejected ServerKey (HTTP {Status}). Licence checks are not working until the key is fixed", status);
            return GvCheckResult.Unavailable("server_key_rejected");
        }

        if (status == 429)
            return GvCheckResult.Unavailable("rate_limited", RetryAfter(response));

        if (status >= 500)
            return GvCheckResult.Unavailable($"http_{status}");

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(text);
        }
        catch (JsonException)
        {
            return GvCheckResult.Unavailable($"bad_json_http_{status}");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return GvCheckResult.Unavailable($"bad_json_http_{status}");

            bool ok = root.TryGetProperty("ok", out var okProp) && okProp.ValueKind == JsonValueKind.True;
            if (ok && response.IsSuccessStatusCode)
                return GvCheckResult.Allowed();

            string reason = ReadString(root, "reason") ?? ReadString(root, "error") ?? "unknown";

            if (DenyReasons.Contains(reason))
                return GvCheckResult.Denied(reason);

            if (reason == "rate_limited")
                return GvCheckResult.Unavailable("rate_limited", RetryAfter(response));

            // bad_request, unknown track_id, a reason added to the contract later... Treat as "no usable
            // answer" so a contract change never empties a race, and shout in the log.
            LogConfigError("unexpected answer from the API: HTTP {Status}, reason '{Reason}'", status, reason);
            return GvCheckResult.Unavailable($"unexpected:{reason}");
        }
    }

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String ? prop.GetString() : null;

    private static TimeSpan? RetryAfter(HttpResponseMessage response)
    {
        var header = response.Headers.RetryAfter;
        if (header?.Delta is { } delta) return delta;
        if (header?.Date is { } date) return date - DateTimeOffset.UtcNow;
        return null;
    }

    // Configuration problems are logged at Error level, at most once a minute.
    private void LogConfigError(string template, params object[] args)
    {
        var now = DateTime.UtcNow.Ticks;
        var last = Interlocked.Read(ref _lastConfigErrorLogTicks);
        if (now - last < TimeSpan.TicksPerMinute) return;
        Interlocked.Exchange(ref _lastConfigErrorLogTicks, now);
        Logger.Error("GvLicencePlugin: " + template, args);
    }

    public void Dispose()
    {
        _http.Dispose();
        _concurrency.Dispose();
    }
}
