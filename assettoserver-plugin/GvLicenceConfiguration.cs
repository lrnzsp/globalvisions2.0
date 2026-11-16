using System.Text.RegularExpressions;
using AssettoServer.Server.Configuration;
using FluentValidation;
using JetBrains.Annotations;
using YamlDotNet.Serialization;

namespace GvLicencePlugin;

/// <summary>
/// How a player without a licence is turned away.
/// </summary>
public enum GvRejectMode
{
    /// <summary>
    /// Refuse the connection during the handshake, before a car slot is given.
    /// The player sees the message in Content Manager and never loads the track.
    /// </summary>
    Handshake,

    /// <summary>
    /// Accept the connection, then kick the player as soon as the session is running.
    /// Fallback for AssettoServer builds where the handshake filter is not available.
    /// </summary>
    KickAfterConnect
}

// AssettoServer derives the file name from the class name:
// "GvLicenceConfiguration" -> "GvLicenceCfg" -> cfg/plugin_gv_licence_cfg.yml
// VERIFY: ACPluginLoader.ConfigurationTypeToFilename (checked at commit 83a192b).
[UsedImplicitly(ImplicitUseKindFlags.Assign, ImplicitUseTargetFlags.WithMembers)]
public class GvLicenceConfiguration : IValidateConfiguration<GvLicenceConfigurationValidator>
{
    public const string DefaultStoreUrl = "https://globalvisions.it/store/";

    [YamlMember(Description = "Public origin of the Global Visions licence API (the Worker), no trailing slash. Example: https://licence.globalvisions.it")]
    public string ApiOrigin { get; init; } = "https://licence.globalvisions.it";

    [YamlMember(Description = "Server key issued by Global Visions for this race server. Sent as 'Authorization: Bearer <key>'. Keep it secret.")]
    public string ServerKey { get; init; } = "";

    [YamlMember(Description = "Global Visions track_id used when the server's track folder is not listed in TrackMap. Leave empty to rely on TrackMap only.")]
    public string? TrackId { get; init; }

    [YamlMember(Description = "Map from the server track folder (as in server_cfg.ini TRACK, without any csp/ prefix) to a Global Visions track_id. A key 'folder/layout' wins over 'folder'.")]
    public Dictionary<string, string> TrackMap { get; init; } = new();

    [YamlMember(Description = "How long a positive answer (player has a licence) is cached, in minutes.")]
    public int CacheMinutes { get; init; } = 10;

    [YamlMember(Description = "How long a negative answer (no licence, refunded, disabled) is cached, in minutes. Keep it short so a player who just bought can join quickly.")]
    public int NegativeCacheMinutes { get; init; } = 1;

    [YamlMember(Description = "When the API cannot be reached, a player whose last positive answer is at most this many hours old is still let in, whatever FailOpen says.")]
    public int StaleIfErrorHours { get; init; } = 24;

    [YamlMember(Description = "What to do when the API cannot be reached and there is no recent positive answer. true = let the player in and log a warning (an outage never empties a race). false = refuse.")]
    public bool FailOpen { get; init; } = true;

    [YamlMember(Description = "Timeout of one API call, in seconds. The player's handshake waits for it, so keep it short.")]
    public int RequestTimeoutSeconds { get; init; } = 5;

    [YamlMember(Description = "After a failed call, skip the API for this many seconds and apply FailOpen straight away, so joins during an outage are not slowed down.")]
    public int OutageBackoffSeconds { get; init; } = 30;

    [YamlMember(Description = "Handshake = refuse during connection (recommended). KickAfterConnect = accept, then kick once the session is running.")]
    public GvRejectMode RejectMode { get; init; } = GvRejectMode.Handshake;

    [YamlMember(Description = "Message shown to a refused player. Placeholders: {track} track_id, {reason} short explanation, {store} store URL. Keep it under 200 characters.")]
    public string KickMessage { get; init; } = "This server runs a paid Global Visions track ({track}). {reason}. Get a licence at {store}";

    [YamlMember(Description = "Store URL used for the {store} placeholder.")]
    public string StoreUrl { get; init; } = DefaultStoreUrl;

    [YamlMember(Description = "Steam IDs (SteamID64, 17 digits) always let in without calling the API: staff, or every seat of a venue with a commercial licence.")]
    public List<string> AllowList { get; init; } = [];

    [YamlMember(Description = "Let server admins in without a licence check (admin password at join, or listed as admin in AssettoServer).")]
    public bool AllowAdmins { get; init; } = true;

    [YamlMember(Description = "Testing only. Allows the plugin to run with UseSteamAuth: false or EnableACProSupport: true, where Steam IDs can be spoofed. Never enable on a public server.")]
    public bool AllowWithoutSteamAuth { get; init; } = false;
}

[UsedImplicitly]
public class GvLicenceConfigurationValidator : AbstractValidator<GvLicenceConfiguration>
{
    private static readonly Regex TrackIdRegex = new("^[a-z0-9-]{2,48}$", RegexOptions.Compiled);
    private static readonly Regex SteamIdRegex = new("^[0-9]{17}$", RegexOptions.Compiled);

    public GvLicenceConfigurationValidator()
    {
        RuleFor(cfg => cfg.ApiOrigin)
            .NotEmpty()
            .Must(BeHttpsOrLocalhost)
            .WithMessage("ApiOrigin must be an absolute https:// URL (http:// is accepted for localhost only), without a path.");

        RuleFor(cfg => cfg.ServerKey)
            .NotEmpty()
            .MinimumLength(16)
            .WithMessage("ServerKey is missing or too short. Ask Global Visions for the key of this server.");

        RuleFor(cfg => cfg.TrackId!)
            .Matches(TrackIdRegex)
            .When(cfg => !string.IsNullOrEmpty(cfg.TrackId))
            .WithMessage("TrackId must be a lowercase slug: [a-z0-9-]{2,48}.");

        RuleFor(cfg => cfg.TrackMap).NotNull();
        RuleForEach(cfg => cfg.TrackMap)
            .Must(kv => !string.IsNullOrWhiteSpace(kv.Key) && TrackIdRegex.IsMatch(kv.Value ?? ""))
            .WithMessage("Every TrackMap entry needs a track folder as key and a track_id ([a-z0-9-]{2,48}) as value.");

        RuleFor(cfg => cfg)
            .Must(cfg => !string.IsNullOrEmpty(cfg.TrackId) || cfg.TrackMap.Count > 0)
            .WithMessage("Set TrackId or at least one TrackMap entry.");

        RuleFor(cfg => cfg.CacheMinutes).InclusiveBetween(0, 1440);
        RuleFor(cfg => cfg.NegativeCacheMinutes).InclusiveBetween(0, 60);
        RuleFor(cfg => cfg.StaleIfErrorHours).InclusiveBetween(0, 168);
        RuleFor(cfg => cfg.RequestTimeoutSeconds).InclusiveBetween(1, 15);
        RuleFor(cfg => cfg.OutageBackoffSeconds).InclusiveBetween(0, 600);
        RuleFor(cfg => cfg.RejectMode).IsInEnum();

        // AssettoServer sends the message with a one byte length prefix, so the
        // final text must stay under 255 characters after placeholders are filled.
        RuleFor(cfg => cfg.KickMessage).NotEmpty().MaximumLength(200);
        RuleFor(cfg => cfg.StoreUrl).NotEmpty().MaximumLength(80);

        RuleFor(cfg => cfg.AllowList).NotNull();
        RuleForEach(cfg => cfg.AllowList)
            .Matches(SteamIdRegex)
            .WithMessage("AllowList entries must be SteamID64 values (17 digits). Quote them in YAML.");
    }

    private static bool BeHttpsOrLocalhost(string origin)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
        if (uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query)) return false;
        return uri.Scheme == Uri.UriSchemeHttps
               || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback);
    }
}
