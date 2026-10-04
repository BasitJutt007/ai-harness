/**
 * The only module plugins import from the core.
 *
 * A plugin is a file under a configured plugin directory (see harness.config.json)
 * whose default export is the value returned by one of these define* helpers (or
 * an array of them). Dropping such a file in is the whole registration step: the
 * registry discovers it on the next run. No core file changes.
 */
import type {
  CheckPlugin,
  DriverPlugin,
  GatePlugin,
  HookPlugin,
  ToolPlugin,
} from './types.ts';

export type * from './types.ts';

/** The harness's single definition of a runnable test file and of test support code (see testmap.ts). */
export { isTestFile, isTestSupport } from './testmap.ts';
/** The governed API's layout (source roots, test dirs, runner globs; see target.ts). */
export { activeLayout, isSourcePath, linkDependencies, matchesTestPattern, sourceRootsLabel, suggestTestPath, targetLayout, underAny } from './target.ts';
export type { TargetLayout, TargetProfile } from './target.ts';

/** A scaffold template's manifest (templates/<name>/harness.template.json), or null. */
export { templateManifest } from './template.ts';
/** The API's strict type check behind ctx.program() (forced flags, every TS file, references; see typecheck.ts). */
export { fileCheckOptions, FORCED_FLAGS, typecheckOf } from './typecheck.ts';
export type { TypeDiagnostic, Typecheck, TypecheckResult } from './typecheck.ts';
/** The read fence of every TypeScript program built in-process over the API (see ts-fence.ts). */
export { createTsFence } from './ts-fence.ts';
export type { TsFence } from './ts-fence.ts';

/** The import graph over the API's .ts files (see testmap.ts), for plugins that reason about what imports what. */
export { graphFiles, importGraph, importSpecifiers, resolveImport } from './testmap.ts';

/** Every placeholder the context views render for content left out of the model's view (see context.ts). */
export { ELISION_PLACEHOLDER } from './context.ts';

export function defineDriver(p: Omit<DriverPlugin, 'kind'>): DriverPlugin {
  return { kind: 'driver', ...p };
}

export function defineTool<I>(p: Omit<ToolPlugin<I>, 'kind'>): ToolPlugin<I> {
  return { kind: 'tool', ...p };
}

export function defineHook(p: Omit<HookPlugin, 'kind'>): HookPlugin {
  return { kind: 'hook', ...p };
}

export function defineGate(p: Omit<GatePlugin, 'kind'>): GatePlugin {
  return { kind: 'gate', ...p };
}

export function defineCheck(p: Omit<CheckPlugin, 'kind'>): CheckPlugin {
  return { kind: 'check', ...p };
}
