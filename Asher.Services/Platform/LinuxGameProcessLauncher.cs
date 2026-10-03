using Asher.Core;
using Asher.Core.Platform;
using Asher.Services.Interfaces;
using System.Diagnostics;

namespace Asher.Services.Platform
{
    /// <summary>
    /// Linux launches the native DustAET with the bootstrap environment the embedded-Mono
    /// entry point expects (see Asher.Linux/README.md):
    ///   LD_PRELOAD      = Asher/libasher_bootstrap.so, relative to the game folder (prepended to any existing value)
    ///   ASHER_HOME      = &lt;game&gt;/Asher
    ///   ASHER_MODS_PATH = &lt;game&gt;/Asher/Mods
    ///   ASHER_LOG_PATH  = &lt;game&gt;/Asher/AsherLogs
    ///   ASHER_PROFILE   = inherited value, else "default"
    ///   MONO_PATH       = &lt;game&gt;/Asher (prepended to any existing value)
    /// LD_PRELOAD is relative on purpose: glibc's dynamic linker separates entries on spaces and
    /// colons and offers no escaping, so an absolute path into a game folder with spaces (e.g.
    /// ".../Dust An Elysian Tail/...") would be split into several bogus entries and never loaded.
    /// The working directory is set to the game folder, so the relative entry resolves correctly.
    /// The parent environment is preserved. The game's stdout/stderr are redirected off the Host's
    /// JSONL stdout channel and pumped to the Host's stderr by <see cref="SystemProcessStarter"/>.
    /// </summary>
    public sealed class LinuxGameProcessLauncher : IGameProcessLauncher
    {
        public const string PreloadVariable = "LD_PRELOAD";
        public const string AsherHomeVariable = "ASHER_HOME";
        public const string AsherModsPathVariable = "ASHER_MODS_PATH";
        public const string AsherLogPathVariable = "ASHER_LOG_PATH";
        public const string AsherProfileVariable = "ASHER_PROFILE";
        public const string MonoPathVariable = "MONO_PATH";
        public const string DefaultProfile = "default";

        private readonly IPlatformInfo _platform;
        private readonly IRuntimeDeployment _deployment;
        private readonly IProcessStarter _starter;
        private readonly IEnvironmentProvider _environmentProvider;

        public LinuxGameProcessLauncher(
            IPlatformInfo platform,
            IRuntimeDeployment deployment,
            IProcessStarter starter,
            IEnvironmentProvider environmentProvider)
        {
            _platform = platform;
            _deployment = deployment;
            _starter = starter;
            _environmentProvider = environmentProvider;
        }

        public bool TryStart(string executablePath, string workingDirectory, out string? errorMessage)
        {
            var asherHome = AsherPaths.GetRuntimeFolderPath(workingDirectory);
            var bootstrapPath = AsherPaths.GetBootstrapLibraryPath(workingDirectory, _platform);

            if (!File.Exists(bootstrapPath))
            {
                errorMessage =
                    $"Bootstrap do Asher não encontrado: {bootstrapPath}. Reinstale o Asher para este jogo.";
                return false;
            }

            if (!_deployment.IsRuntimeInstalled(workingDirectory))
            {
                errorMessage =
                    $"Instalação do Asher incompleta em {workingDirectory}. Reinstale o Asher antes de iniciar o jogo.";
                return false;
            }

            try
            {
                _starter.Start(BuildStartInfo(executablePath, workingDirectory, asherHome));
                errorMessage = null;
                return true;
            }
            catch (Exception ex)
            {
                errorMessage = $"Falha ao iniciar o jogo: {ex.Message}";
                return false;
            }
        }

        private ProcessStartInfo BuildStartInfo(
            string executablePath,
            string workingDirectory,
            string asherHome)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = executablePath,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            foreach (var (key, value) in _environmentProvider.GetEnvironmentVariables())
                startInfo.Environment[key] = value;

            startInfo.Environment[PreloadVariable] = PrependPath(
                GetEnvironmentValue(startInfo, PreloadVariable),
                GetPreloadPath());

            startInfo.Environment[AsherHomeVariable] = asherHome;
            startInfo.Environment[AsherModsPathVariable] = AsherPaths.GetModsFolderPath(workingDirectory);
            startInfo.Environment[AsherLogPathVariable] = AsherPaths.GetLogsFolderPath(workingDirectory);

            var profile = GetEnvironmentValue(startInfo, AsherProfileVariable);
            if (string.IsNullOrWhiteSpace(profile))
                startInfo.Environment[AsherProfileVariable] = DefaultProfile;

            startInfo.Environment[MonoPathVariable] = PrependPath(
                GetEnvironmentValue(startInfo, MonoPathVariable),
                asherHome);

            return startInfo;
        }

        /// <summary>
        /// Bootstrap library location passed to LD_PRELOAD, relative to the game folder (the process
        /// working directory). Kept space-free because glibc splits LD_PRELOAD on spaces and colons.
        /// </summary>
        internal string GetPreloadPath() =>
            AsherPaths.RuntimeFolderName + "/" + _platform.BootstrapLibraryName;

        private static string? GetEnvironmentValue(ProcessStartInfo startInfo, string name) =>
            startInfo.Environment.TryGetValue(name, out var value) ? value : null;

        private static string PrependPath(string? existing, string path)
        {
            if (string.IsNullOrWhiteSpace(existing))
                return path;

            if (string.Equals(existing, path, StringComparison.Ordinal))
                return existing;

            var parts = existing.Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Any(part => string.Equals(part, path, StringComparison.Ordinal)))
                return existing;

            return path + ":" + existing;
        }
    }
}
