using AssettoServer.Server.OpenSlotFilters;
using AssettoServer.Server.Plugin;
using Autofac;
using Microsoft.Extensions.Hosting;

namespace GvLicencePlugin;

/// <summary>
/// Plugin entry point. AssettoServer finds every non abstract AssettoServerModule
/// in plugins/GvLicencePlugin/GvLicencePlugin.dll once "GvLicencePlugin" is listed
/// under EnablePlugins in extra_cfg.yml.
/// </summary>
// VERIFY: AssettoServerModule<TConfig> in AssettoServer/Server/Plugin/AssettoServerModule.cs
// and the loader in ACPluginLoader.cs (folder name == dll name). Checked at commit 83a192b.
public class GvLicenceModule : AssettoServerModule<GvLicenceConfiguration>
{
    // Written by AssettoServer as cfg/plugin_gv_licence_cfg.reference.yml.
    public override object ReferenceConfiguration => new GvLicenceConfiguration
    {
        ApiOrigin = "https://api.globalvisions.it",
        ServerKey = "paste-the-server-key-from-global-visions-here",
        TrackId = "example-circuit",
        TrackMap = new Dictionary<string, string>
        {
            ["gv_example_circuit"] = "example-circuit",
            ["gv_example_circuit/club"] = "example-circuit"
        },
        AllowList = ["76561198000000000"]
    };

    protected override void Load(ContainerBuilder builder)
    {
        builder.RegisterType<GvLicenceApiClient>().AsSelf().SingleInstance();

        // One instance plays three roles:
        //  - IOpenSlotFilter: AssettoServer asks it during every handshake whether to accept the player.
        //  - IHostedService: checks the environment at startup (Steam auth, track mapping).
        //  - AsSelf: so other code can reach the cache if needed.
        // VERIFY: IOpenSlotFilter is collected as IEnumerable<IOpenSlotFilter> by OpenSlotFilterChain,
        // in registration order. The official WordFilterPlugin registers itself the same way.
        builder.RegisterType<GvLicenceService>()
            .AsSelf()
            .As<IOpenSlotFilter>()
            .As<IHostedService>()
            .SingleInstance();
    }
}
