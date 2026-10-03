/**
 * Headless smoke test for the environment preflight (no GUI).
 * Run: node scripts/preflight-smoke-test.mjs
 *
 * On a machine with all requirements present this asserts the preflight is a clean no-op.
 * On a machine missing components it asserts the shape of the result and that the install
 * plan is well-formed (without actually installing anything).
 */
import {
  installMissingComponents,
  runEnvironmentPreflight,
  __testOnly
} from '../src/main/environment-preflight.js';

let failures = 0;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  failures++;
}

function pass(message) {
  console.error(`[OK] ${message}`);
}

async function main() {
  const result = await runEnvironmentPreflight();

  if (!result || typeof result !== 'object') {
    fail('preflight returned no result');
    process.exit(1);
  }

  if (result.platform !== process.platform) {
    fail(`platform mismatch: ${result.platform}`);
  } else {
    pass(`platform ${result.platform}`);
  }

  if (typeof result.requiresComponents !== 'boolean') {
    fail('requiresComponents is not boolean');
  } else {
    pass(`requiresComponents=${result.requiresComponents}`);
  }

  if (!Array.isArray(result.missing)) {
    fail('missing is not an array');
  } else {
    pass(`missing count=${result.missing.length}`);
  }

  for (const component of result.missing) {
    const okShape =
      typeof component.id === 'string' &&
      typeof component.label === 'string' &&
      typeof component.reason === 'string' &&
      Array.isArray(component.packages) &&
      component.packages.length > 0;
    if (!okShape) {
      fail(`malformed component: ${JSON.stringify(component)}`);
    }
  }
  if (result.missing.length > 0) {
    pass('all missing components have packages');
  }

  if (process.platform !== 'linux') {
    if (result.requiresComponents) {
      fail('non-linux platforms must not require components');
    } else {
      pass('non-linux no-op');
    }
  }

  // The apt install plan must be shell-safe (no quoting surprises).
  const plan = __testOnly.buildAptInstall([
    { packages: ['libnss3', 'libnspr4'] },
    { packages: ['libasound2', 'libasound2t64'] }
  ]);
  if (!plan.packages.includes('libnss3') || !plan.packages.includes('libasound2t64')) {
    fail(`apt plan missing packages: ${JSON.stringify(plan)}`);
  } else if (!plan.command.startsWith('apt-get install -y ')) {
    fail(`unexpected apt command: ${plan.command}`);
  } else {
    pass(`apt plan: ${plan.command}`);
  }

  // Installing with an empty list must succeed without touching the system.
  if (process.platform === 'linux') {
    const empty = await installMissingComponents([]);
    if (!empty.ok) {
      fail(`empty install should be a no-op: ${empty.message}`);
    } else {
      pass('empty install is a no-op');
    }
  }

  console.error(failures === 0 ? '[preflight-smoke] all checks passed' : `[preflight-smoke] ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[preflight-smoke] fatal: ${err.message}`);
  process.exit(1);
});
