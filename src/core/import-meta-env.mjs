/**
 * `--import` entry the harness adds to node:test runs of a Vite app (target.ts runnerInfo): it registers
 * import-meta-env-hooks.mjs, which gives every module under the API root that reads `import.meta.env` the
 * object Vite and Vitest provide (MODE, DEV, PROD, SSR, BASE_URL and VITE_* from the environment). Without
 * it a Vite app's modules crash at import under node:test ("Cannot read properties of undefined (reading
 * 'MODE')"), so no test of them could ever run, red or green.
 *
 * The API root is the runner's working directory (the harness starts every test run there). Imports only
 * node: builtins: it runs inside the sandbox, which can read it as a harness runtime file (sandbox.ts).
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./import-meta-env-hooks.mjs', import.meta.url, { data: { root: pathToFileURL(`${process.cwd()}/`).href } });
