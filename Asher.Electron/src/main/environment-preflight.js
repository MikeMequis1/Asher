import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeDiagnosticLog } from './diagnostic-logger.js';

const execFileAsync = promisify(execFile);

/**
 * First-run environment preflight for Linux.
 *
 * Electron needs a set of shared system libraries (NSS/NSPR/ALSA) and, depending on the
 * distribution, a session DBus. When one is missing the manager either fails to start or
 * launches the game with no patches applied. This module detects the missing components and
 * exposes an explicit, user-approved install plan (via the distribution's package manager).
 *
 * Windows has no equivalent: everything the manager needs ships with Electron.
 */

/**
 * @typedef {object} MissingComponent
 * @property {string} id
 * @property {'runtime' | 'package'} kind
 * @property {string} label
 * @property {string} reason
 * @property {string[]} packages      apt package names that satisfy the requirement
 */

// Shared libraries the Electron runtime and the game expect. Names match the SONAMEs that
// ldconfig reports; one probe per requirement.
const LINUX_LIBRARY_REQUIREMENTS = [
  {
    id: 'nss',
    label: 'NSS (Network Security Services)',
    sonames: ['libnss3.so'],
    packages: ['libnss3'],
    reason: 'Required by the Electron runtime (Chromium networking).'
  },
  {
    id: 'nspr',
    label: 'NSPR (Netscape Portable Runtime)',
    sonames: ['libnspr4.so'],
    packages: ['libnspr4'],
    reason: 'Required by the Electron runtime (Chromium).'
  },
  {
    id: 'asound',
    label: 'ALSA (Advanced Linux Sound Architecture)',
    sonames: ['libasound.so.2'],
    packages: ['libasound2', 'libasound2t64'],
    reason: 'Required for audio; FNA links against ALSA.'
  },
  {
    id: 'x11',
    label: 'X11',
    sonames: ['libX11.so.6'],
    packages: ['libx11-6'],
    reason: 'Required to open the game window.'
  },
  {
    id: 'xrandr',
    label: 'X RandR',
    sonames: ['libXrandr.so.2'],
    packages: ['libxrandr2'],
    reason: 'Used to place the game window on multi-monitor desktops.'
  },
  {
    id: 'gl',
    label: 'OpenGL',
    sonames: ['libGL.so.1'],
    packages: ['libgl1'],
    reason: 'Required by FNA3D to render the game.'
  }
];

let cachedLdconfig = null;
let cachedAptPackages = null;

/**
 * @returns {Promise<string>}
 */
async function readLdconfig() {
  if (cachedLdconfig !== null) {
    return cachedLdconfig;
  }

  try {
    const { stdout } = await execFileAsync('ldconfig', ['-p'], { maxBuffer: 8 * 1024 * 1024 });
    cachedLdconfig = stdout;
  } catch (err) {
    writeDiagnosticLog('warn', 'preflight', 'ldconfig unavailable', {
      error: err instanceof Error ? err.message : String(err)
    });
    cachedLdconfig = '';
  }

  return cachedLdconfig;
}

/**
 * @param {string} soname
 * @returns {Promise<boolean>}
 */
async function hasSharedLibrary(soname) {
  const output = await readLdconfig();
  if (!output) {
    // Without ldconfig we cannot prove absence; do not block the user.
    return true;
  }
  return output.includes(`${soname} `) || output.includes(`${soname}\t`) || output.includes(soname);
}

/**
 * Read the set of packages known to the local package index (so we only offer installs that
 * actually resolve on this distribution).
 * @returns {Promise<Set<string>>}
 */
async function getKnownAptPackages() {
  if (cachedAptPackages !== null) {
    return cachedAptPackages;
  }

  cachedAptPackages = new Set();
  try {
    const { stdout } = await execFileAsync(
      'apt-cache',
      ['pkgnames'],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    for (const name of stdout.split('\n')) {
      const trimmed = name.trim();
      if (trimmed) {
        cachedAptPackages.add(trimmed);
      }
    }
  } catch (err) {
    writeDiagnosticLog('warn', 'preflight', 'apt-cache unavailable', {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return cachedAptPackages;
}

/**
 * @param {string[]} packages
 * @param {Set<string>} known
 * @returns {string[]}
 */
function resolvePackages(packages, known) {
  if (known.size === 0) {
    return packages;
  }
  const resolved = packages.filter((name) => known.has(name));
  return resolved.length > 0 ? resolved : packages;
}

/**
 * Resolve the elevation command, if the user can elevate non-interactively or via a GUI prompt.
 * @returns {Promise<{ command: string, args: string[] } | null>}
 */
export async function resolveElevationCommand() {
  try {
    await execFileAsync('sudo', ['-n', 'true']);
    return { command: 'sudo', args: ['-n'] };
  } catch {
    // No passwordless sudo. Fall back to pkexec (GUI polkit prompt) when available.
  }

  try {
    await execFileAsync('pkexec', ['true']);
    return { command: 'pkexec', args: [] };
  } catch {
    // pkexec fails without a terminal/polkit agent; still offer it if the binary exists.
  }

  if (await fileExists('/usr/bin/pkexec')) {
    return { command: 'pkexec', args: [] };
  }

  return null;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the list of missing Linux components.
 * @returns {Promise<MissingComponent[]>}
 */
async function collectMissingLinuxComponents() {
  /** @type {MissingComponent[]} */
  const missing = [];

  // Support/test hook: force specific component ids to appear missing (comma-separated).
  // Example: ASHER_PREFLIGHT_FORCE_MISSING=nss,nspr
  const forced = new Set(
    (process.env.ASHER_PREFLIGHT_FORCE_MISSING || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (forced.size > 0) {
    writeDiagnosticLog('warn', 'preflight', 'forced missing components (test hook)', {
      forced: [...forced]
    });
  }

  const known = await getKnownAptPackages();

  for (const requirement of LINUX_LIBRARY_REQUIREMENTS) {
    let present = false;
    for (const soname of requirement.sonames) {
      if (await hasSharedLibrary(soname)) {
        present = true;
        break;
      }
    }

    if (!present || forced.has(requirement.id)) {
      missing.push({
        id: requirement.id,
        kind: 'package',
        label: requirement.label,
        reason: requirement.reason,
        packages: resolvePackages(requirement.packages, known)
      });
    }
  }

  // A running session DBus is optional for the manager but is a common VM gap; do not treat it
  // as a blocking requirement. Only report it through diagnostics.
  const hasDbus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
  if (!hasDbus) {
    writeDiagnosticLog('info', 'preflight', 'no session DBus detected (non-blocking)');
  }

  return missing;
}

/**
 * Run the preflight for the current platform.
 * @returns {Promise<{ platform: string, requiresComponents: boolean, missing: MissingComponent[], canAutoInstall: boolean, packageManager: string | null }>}
 */
export async function runEnvironmentPreflight() {
  if (process.platform !== 'linux') {
    return {
      platform: process.platform,
      requiresComponents: false,
      missing: [],
      canAutoInstall: false,
      packageManager: null
    };
  }

  const missing = await collectMissingLinuxComponents();
  const elevation = missing.length > 0 ? await resolveElevationCommand() : null;

  const result = {
    platform: process.platform,
    requiresComponents: missing.length > 0,
    missing,
    canAutoInstall: missing.length > 0 && elevation !== null,
    packageManager: missing.length > 0 ? 'apt' : null
  };

  writeDiagnosticLog('info', 'preflight', 'environment preflight', {
    requiresComponents: result.requiresComponents,
    canAutoInstall: result.canAutoInstall,
    missing: missing.map((entry) => entry.id)
  });

  return result;
}

/**
 * Build a human-readable, shell-safe install command for the missing apt packages.
 * @param {MissingComponent[]} components
 * @returns {{ command: string, packages: string[] }}
 */
function buildAptInstall(components) {
  const packages = [...new Set(components.flatMap((entry) => entry.packages))].sort();
  return {
    command: `apt-get install -y ${packages.join(' ')}`,
    packages
  };
}

/**
 * Install the missing components after explicit user approval.
 * @param {MissingComponent[]} components
 * @param {(progress: { message: string, details?: string }) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, message: string, details?: string }>}
 */
export async function installMissingComponents(components, onProgress) {
  if (process.platform !== 'linux') {
    return { ok: false, message: 'Automatic installation is only available on Linux.' };
  }

  const list = Array.isArray(components) ? components : [];
  if (list.length === 0) {
    return { ok: true, message: 'No missing components.' };
  }

  const elevation = await resolveElevationCommand();
  if (!elevation) {
    return {
      ok: false,
      message: 'Could not elevate privileges to install packages.',
      details: 'No passwordless sudo and no pkexec available. Install the packages manually.'
    };
  }

  const { command, packages } = buildAptInstall(list);
  const args = [...elevation.args, 'apt-get', 'install', '-y', ...packages];

  onProgress?.({ message: 'Requesting permission to install components...' });

  try {
    // Refresh the package index first; failures are non-fatal (offline mirrors, restricted nets).
    try {
      const updateArgs = [...elevation.args, 'apt-get', 'update'];
      const { stdout: updateOut } = await execFileAsync(elevation.command, updateArgs, {
        maxBuffer: 16 * 1024 * 1024
      });
      onProgress?.({ message: 'Package list updated.', details: tail(updateOut) });
    } catch (err) {
      onProgress?.({
        message: 'Could not refresh the package list; continuing with the cached index.',
        details: err instanceof Error ? err.message : String(err)
      });
    }

    onProgress?.({ message: `Installing: ${packages.join(', ')}...`, details: command });
    const { stdout, stderr } = await execFileAsync(elevation.command, args, {
      maxBuffer: 32 * 1024 * 1024
    });

    const details = tail(`${stdout}\n${stderr}`);
    writeDiagnosticLog('info', 'preflight', 'components installed', { packages, command });
    return { ok: true, message: 'Components installed successfully.', details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = tail(err?.stdout || err?.stderr || message);
    writeDiagnosticLog('error', 'preflight', 'component installation failed', {
      packages,
      command,
      message
    });
    return { ok: false, message: 'Installation of required components failed.', details };
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function tail(text) {
  const lines = String(text ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.slice(-12).join('\n');
}

/**
 * Whether a path exists (used by tests / callers needing the helper).
 * @param {string} filePath
 * @returns {boolean}
 */
export function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export const __testOnly = {
  LINUX_LIBRARY_REQUIREMENTS,
  buildAptInstall,
  resolvePackages
};
