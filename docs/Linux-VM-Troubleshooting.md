# Linux VM Troubleshooting

Errors observed while downloading and running the shipped Linux manager (`Asher-<version>-linux-x64`)
on a desktop VM (Ubuntu, VMware), and what they mean. Unless noted, findings are from the `2.1.0`
build.

## Scope

An Ubuntu VM, running the extracted `tar.gz` as root:

```bash
sudo ./Asher --no-sandbox
```

The manager started, connected to `Asher.Host`, installed into the Steam game folder, and launched the
game — but the game's patches were not applied. The console showed three groups of errors.

## 1. Display / GPU / DBus noise (VM environment, not an Asher fault)

```text
ERROR:bus.cc(408)] Failed to connect to the bus: Could not parse server address: Unknown address type
ERROR:egl_util.cc(48)] Failed to load GLES library: .../libGLESv2.so: Permission denied
ERROR:viz_main_impl.cc(183)] Exiting GPU process due to errors during initialization
Authorization required, but no authorization protocol specified
ERROR:x11_software_bitmap_presenter.cc(150)] XGetWindowAttributes failed for window ...
```

- `Failed to connect to the bus` — no session DBus in the VM session. Cosmetic.
- `Failed to load GLES library ... Permission denied` / `Exiting GPU process` — the VM has no usable
  GPU/GLES acceleration; Chromium's GPU process exits and falls back to software rendering.
- `Authorization required, but no authorization protocol specified` — the process cannot authenticate
  to the X server. Running with `sudo` strips `XAUTHORITY` (and may change `DISPLAY`), so the root
  process is not authorized to the user's X session.

These are usually non-fatal, but under `sudo` the window may never render/keep open, and the manager
then quits (see §2).

## 2. `Asher.Host` exits with code 0 ("Host process exited unexpectedly")

```text
[asher][host] status terminated {"message":"Host process exited unexpectedly"}
[asher][host] process exited {"detail":"exit code 0","status":"terminated"}
[asher][host] status stopped
```

Not a Host crash. `exit code 0` means `JsonlHostSession.RunAsync` returned normally. The sequence is:

1. The Electron window closes (VM display issue above).
2. `window-all-closed` → `app.quit()`.
3. `before-quit` → `HostManager.stop()` closes the Host's stdin.
4. The Host's `Console.In.ReadLineAsync` returns `null` (EOF) → `RunAsync` returns → exit `0`.

The double `terminated` followed by `stopped` is the signature of `stop()` running while the child
exit event is processed. The Host dying is a **symptom** of the app closing, not the cause.

## 3. Patches not applied: `LD_PRELOAD` split on spaces (Asher bug, fixed)

```text
[game-stderr] ERROR: ld.so: object '/home/.../common/Dust' from LD_PRELOAD cannot be preloaded ... ignored.
[game-stderr] ERROR: ld.so: object 'An' from LD_PRELOAD cannot be preloaded ... ignored.
[game-stderr] ERROR: ld.so: object 'Elysian' from LD_PRELOAD cannot be preloaded ... ignored.
[game-stderr] ERROR: ld.so: object 'Tail/Asher/libasher_bootstrap.so' from LD_PRELOAD cannot be preloaded ... ignored.
```

`LinuxGameProcessLauncher` passed the **absolute** bootstrap path in `LD_PRELOAD`. glibc's dynamic
linker separates `LD_PRELOAD` entries on spaces **and** colons and offers no escaping, so a game folder
containing spaces (`.../Dust An Elysian Tail/...`) was split into several bogus entries. The bootstrap
library was never loaded, so no patches ran.

Fixed in the current code: the entry is relative to the game folder (the process working directory),
which is always space-free (`Asher/libasher_bootstrap.so`). See
[Cross-Platform-Architecture.md](Cross-Platform-Architecture.md#linux-launch-environment).

Minimal reproduction (still shows the failure on `2.1.0` and any absolute-path build):

```bash
GAME="$HOME/.local/share/Steam/steamapps/common/Dust An Elysian Tail"
LD_PRELOAD="$GAME/Asher/libasher_bootstrap.so" /bin/true
# -> "cannot be preloaded ... ignored" x4
```

Success signature on a fixed build (from the manager log / `AsherLogs/runtime_*.log`):

```text
[AsherPoC] Native bootstrap loaded
[AsherPoC] Mono symbols resolved
[AsherPoC] Root domain acquired
[AsherPoC] Thread attached
[Asher] Runtime initialized
[Asher] Bootstrap completed
[PatchModuleLoader] 4 módulos de patch aplicados.
[DebugEnabler] canDebug enabled via post-attach Game.Tick
```

If `ld.so: object ... ignored` reappears, the `LD_PRELOAD` value is absolute again.

## 4. Plain `./Asher` aborts: setuid sandbox (packaging bug, fixed)

On modern Ubuntu (24.04+/26.04) unprivileged user namespaces are restricted
(`kernel.apparmor_restrict_unprivileged_userns=1`), and the tarball does not install a
root-owned `4755` `chrome-sandbox`. Electron's native bootstrap then aborts before any
JavaScript runs:

```text
FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found, but is not
configured correctly. ... make sure that .../chrome-sandbox is owned by root and has mode 4755.
```

This affects the released `2.1.0` tarball too: plain `./Asher` fails, and users must pass
`--no-sandbox` explicitly. It cannot be handled from `main.js` (the abort is pre-JS).

Fixed at packaging time: `scripts/after-pack-linux.cjs` (registered as the electron-builder
`afterPack` hook) replaces the packaged ELF launcher with a small `Asher` shell wrapper and
renames the real binary to `Asher.bin`. The wrapper:

- restores the executable bit on `Asher.bin` and `resources/asher-host/Asher.Host` if a
  transfer stripped it;
- uses the OS sandbox when `chrome-sandbox` is root-owned and setuid, otherwise
  `exec`s with `--no-sandbox`.

Result: the documented first-run experience works with no flags — just `./Asher`.

## 5. Windows cross-build strips Linux file modes

electron-builder on Windows archives with 7-Zip, which does not store Unix modes, so the
`tar.gz` it produces has `0644` for the executables (`Asher`, `chrome-sandbox`,
`resources/asher-host/Asher.Host`). The `afterPack` wrapper above self-heals the two it can;
for a fully correct archive, repack on Linux (or WSL) with GNU `tar` after fixing modes:

```bash
find <dir> -type d -exec chmod 755 {} +
find <dir> -type f -exec chmod 644 {} +
chmod 755 Asher Asher.bin chrome-sandbox chrome_crashpad_handler resources/asher-host/Asher.Host
tar -czf Asher-<version>-linux-x64.tar.gz Asher-<version>-linux-x64
```

## 6. First-run component preflight

The manager checks required system libraries (NSS/NSPR/ALSA/X11/Xrandr/GL) before connecting the Host.
When something is missing it shows a "Missing required components" screen with the apt package names
and offers to install them (`sudo -n`, else `pkexec`).

- Over SSH without an interactive terminal, `pkexec` fails with
  `Error creating textual authentication agent ... /dev/tty`. That is an SSH-session limitation; a
  manager launched from the desktop session reaches the polkit agent normally. The failure is surfaced
  to the user, and `Skip and continue anyway` remains available.
- Force the screen for testing without uninstalling anything:

  ```bash
  ASHER_PREFLIGHT_FORCE_MISSING=nss,nspr ./Asher --no-sandbox
  ```

## 7. Addendum — launching through Steam's **Play** button

On Linux the Asher runtime is loaded by the **manager**, which starts `DustAET` with the
`LD_PRELOAD` bootstrap and the `ASHER_*` / `MONO_PATH` environment. Pressing **Play** in Steam
launches `DustAET` **directly**, without any of that environment, so:

- the game starts **unpatched** (no `libasher_bootstrap.so` in `LD_PRELOAD`, no mods loaded);
- nothing under `Asher/` is used, and no `runtime_*.log` is written;
- the game itself still runs normally (Steam's launch is the same one a non-Asher user gets).

In other words, **Asher is only active when the game is started through the manager.** This is the
current intentional behavior: external Steam/desktop launch is not implemented on Linux
(see `docs/Cross-Platform-Architecture.md` → *Deferred / known limits*). Do not treat "Steam Play
starts the game" as "Asher is working"; always validate patching through the manager's
**Launch Game**.

A Steam launch can be made to load Asher by adding the bootstrap to the game's launch options, but
this is unsupported and fragile:

```text
LD_PRELOAD=Asher/libasher_bootstrap.so ASHER_HOME=$PWD/Asher %command%
```

Caveats with this workaround: Steam must run with the game folder as the working directory for the
relative `LD_PRELOAD` entry to resolve (absolute paths break on the spaces in
`Dust An Elysian Tail` — see §3), and Steam's own runtime/container may strip or ignore
`LD_PRELOAD`. The supported path remains the manager.

## Workarounds for running the manager on a VM

- Do **not** run with `sudo`. Run as the desktop user so X11/DBus are available. If Electron reports a
  sandbox error, use `--no-sandbox`.
- Add VM-friendly Chromium flags:

  ```bash
  ./Asher --no-sandbox --disable-gpu --disable-dev-shm-usage
  ```

  `--disable-dev-shm-usage` avoids renderer crashes from a small `/dev/shm`; `--disable-gpu` avoids the
  GPU-process failures on VMs without 3D acceleration.
- If X authentication is needed for the user, `xhost +SI:localuser:$USER` from the desktop session.
- These flags only get the **manager UI** running; the patch failure in §3 is fixed in code, not by a
  flag.
