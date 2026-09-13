/* The Python half of this project, run from the same command as the rest of it.
 *
 * `npm run check` used to cover the client and nothing else, while 68 tests sat in
 * `server/canvas/` and `agents/` with no command that ran them. A check that quietly omits
 * most of a suite is worse than having no check script, because it is believed.
 *
 * `unittest` rather than `pytest`: it is in the standard library, so this works on the
 * deployment box as well as here. The server has no pytest installed and never needed one.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* `unittest discover` does not recurse into a package without an __init__.py, and adding
 * one to agents/tclk would make it importable as a package it is not. Naming the
 * directory is cheaper than restructuring it, and a suite that is not listed here is a
 * suite nobody runs — which is the failure this script exists to prevent. */
const SUITES = ["server/canvas", "agents", "agents/tclk"];

/* Probe for what the tests actually need, not for "a Python 3".
 *
 * A Windows machine can easily have three: a real install, the `py` launcher, and the
 * Microsoft Store stub that answers `python3` and has no site-packages. Asking only for the
 * major version picks the stub and fails on the first `import cryptography`, several layers
 * away from the cause. Ed25519 is the real requirement, so that is what is asked. */
const PROBE = "import sys\ntry:\n import cryptography\nexcept ImportError:\n import nacl\nsys.exit(0 if sys.version_info[0] == 3 else 1)";

/** A Python that can run these suites, or null. */
function findPython() {
  for (const candidate of ["python", "py", "python3"]) {
    if (spawnSync(candidate, ["-c", PROBE], { encoding: "utf8" }).status === 0) {
      return candidate;
    }
  }
  return null;
}

const python = findPython();
if (python === null) {
  // Loud, not skipped. Half of this project is Python; a run that cannot execute it has not
  // checked the archive, the verifier or the agent path, and should not report success.
  console.error(
    "no Python 3 with an Ed25519 library on PATH — cannot run the archive, verifier or\n" +
      "agent tests. Install one (`pip install cryptography`, or pynacl), or run the client\n" +
      "tests alone with `npm test` and say so when reporting the result.",
  );
  process.exit(1);
}

let failed = 0;
for (const suite of SUITES) {
  const cwd = join(ROOT, suite);
  if (!existsSync(cwd)) {
    console.error(`missing suite directory: ${suite}`);
    failed += 1;
    continue;
  }
  process.stdout.write(`\n── ${suite} ──\n`);
  const run = spawnSync(python, ["-m", "unittest", "discover", "-p", "test_*.py"], {
    cwd,
    stdio: "inherit",
  });
  if (run.status !== 0) failed += 1;
}

process.stdout.write(
  failed === 0 ? `\nPython suites OK (${SUITES.length})\n` : `\n${failed} Python suite(s) failed\n`,
);
process.exit(failed === 0 ? 0 : 1);
