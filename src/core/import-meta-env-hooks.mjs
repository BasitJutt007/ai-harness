/**
 * Module customization hooks (registered by import-meta-env.mjs): after the other loaders (tsx) have turned
 * a module into JavaScript, or before Node strips a TypeScript module's types itself (no tsx), a module under
 * the API root (never one under node_modules) whose source reads
 * `import.meta.env` gets that object defined first, as Vite and Vitest define it: MODE "test", DEV true,
 * PROD false, SSR false, BASE_URL "/", and every VITE_* variable of the process environment (the sandbox
 * passes none of the operator's; a repository's .env files stay unreadable, so they are not loaded).
 *
 * The definition is inserted on the module's first line, without a newline, so every line number a stack
 * trace or a test location names stays where it was (after a hashbang line, when the module has one).
 */
let root = '';

export async function initialize(data) {
  root = typeof data?.root === 'string' ? data.root : '';
}

const DEFINE = 'import.meta.env ??= { MODE: "test", DEV: true, PROD: false, SSR: false, BASE_URL: "/", '
  + '...Object.fromEntries(Object.entries(globalThis.process?.env ?? {}).filter(([k]) => k.startsWith("VITE_"))) };';

/** `source` with import.meta.env defined at the start of its first code line, line numbers unchanged. */
export function defineImportMetaEnv(source) {
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    return nl < 0 ? source : `${source.slice(0, nl + 1)}${DEFINE}${source.slice(nl + 1)}`;
  }
  return `${DEFINE}${source}`;
}

/**
 * ES module formats whose source may read import.meta: JavaScript ('module', also what tsx hands on), and
 * TypeScript Node strips itself ('module-typescript', node 22.18+/24 without tsx): the definition is plain
 * JavaScript, valid TypeScript too, so it goes in before Node strips the types.
 */
const ESM_FORMATS = new Set(['module', 'module-typescript']);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (root === '' || !ESM_FORMATS.has(result.format) || !url.startsWith(root) || url.includes('/node_modules/')) return result;
  const source = typeof result.source === 'string' ? result.source : result.source != null ? Buffer.from(result.source).toString('utf8') : null;
  if (source === null || !source.includes('import.meta.env')) return result;
  return { ...result, source: defineImportMetaEnv(source) };
}
