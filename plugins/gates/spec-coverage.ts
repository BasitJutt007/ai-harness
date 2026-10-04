/**
 * spec-coverage (greenfield): the API implements what the task asked for, judged by the harness.
 *
 * - Routes: every endpoint resources × operations imply (list GET <base>/<plural>, create POST
 *   <base>/<plural>, get / update (PATCH or PUT) / delete on <base>/<plural>/:param; the task's
 *   declared `Endpoint:` paths count too) must be registered: found in the static route table, or
 *   answered by the running app (a status the harness itself received). Each missing one fails.
 * - Behaviour: probes generated from the field specs run against the app in the OS sandbox
 *   (plugins/lib/probe.ts serveApp); the harness sends every request and judges every response
 *   (plugins/lib/spec-probes.ts): create 201 echoing the sent fields, get 200, list contains it
 *   (pagination followed), missing required / enum outside values / above max / below min -> 422
 *   problem, duplicate unique -> 409 problem, partial update 200 keeping the other fields, delete 204
 *   then 404, same Idempotency-Key + body twice -> same status and id.
 * - pass only if every unit passes; any fail -> fail; else any undecidable unit (no app, 401/403,
 *   no valid body from the spec, a failed request) -> unproven.
 * - Greenfield with only a free-text brief: n/a, and a human must verify behaviour coverage
 *   (listed under "human must verify"). Brownfield: n/a (contract-lock covers contracts).
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { GateResult, GreenfieldTask, RunContext } from '../../src/core/plugin-api.ts';
import type ts from 'typescript';
import { extractRouteTable, location } from '../lib/api-ast.ts';
import { apiSourceFiles, createApiProgram } from '../lib/contract.ts';
import { serveApp } from '../lib/probe.ts';
import { coverRoutes, endpointLabel, expectedEndpoints, httpClient, runScenario, staticMatches } from '../lib/spec-probes.ts';
import type { Evidence, ExpectedEndpoint, Method, SpecUnit, StaticRoute } from '../lib/spec-probes.ts';

/** How long the app may be served for the behavioural probes. */
const BUDGET_MS = 120_000;
const MAX_DETAILS = 30;

export const FREE_TEXT_NOTE =
  'behaviour coverage of the free-text brief: the task lists no structured resources, so no gate compared the endpoints and behaviours the API implements with what the brief asks for';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Table = { routes: StaticRoute[]; unresolved: number } | { error: string };

async function staticTable(root: string): Promise<{ table: Table; program: () => ts.Program }> {
  let program: ts.Program | undefined;
  const get = (): ts.Program => {
    if (program === undefined) throw new Error('no program');
    return program;
  };
  try {
    const files = await apiSourceFiles(root);
    program = createApiProgram(root, files);
    const t = extractRouteTable(program, root, files);
    return {
      table: { routes: t.routes.map((r) => ({ method: r.method, path: r.path, at: location(root, r.registration) })), unresolved: t.unresolved.length + t.dynamic.length },
      program: get,
    };
  } catch (e) {
    return { table: { error: `static route extraction failed: ${errMsg(e)}` }, program: get };
  }
}

/** Per resource: the collection path the probes use (a registered path the task allows, else the task's own) and the update methods registered. */
function probePaths(expected: ExpectedEndpoint[], table: Table): Map<string, { collection: string; updateMethods: Method[] }> {
  const out = new Map<string, { collection: string; updateMethods: Method[] }>();
  const routes = 'routes' in table ? table.routes : [];
  for (const e of expected) {
    const cur = out.get(e.resource) ?? { collection: '', updateMethods: [] };
    const hit = staticMatches(e, routes)[0];
    const path = (hit?.path ?? e.paths[0] ?? '').split('/');
    const collection = (e.op === 'list' || e.op === 'create' ? path : path.slice(0, -1)).join('/');
    if (cur.collection === '' || ((e.op === 'list' || e.op === 'create') && hit !== undefined)) cur.collection = collection;
    if (e.op === 'update') {
      for (const r of staticMatches(e, routes)) {
        const m = r.method.toUpperCase();
        if ((m === 'PATCH' || m === 'PUT') && !cur.updateMethods.includes(m)) cur.updateMethods.push(m);
      }
      cur.updateMethods.sort((a, b) => (a === 'PATCH' ? -1 : b === 'PATCH' ? 1 : 0));
    }
    out.set(e.resource, cur);
  }
  return out;
}

function line(u: SpecUnit): string {
  const tag = u.status === 'pass' ? 'pass' : u.status === 'fail' ? 'FAIL' : 'UNPROVEN';
  return `${tag.padEnd(8)} ${u.resource} ${u.name}: ${u.detail}`;
}

export async function specCoverage(ctx: RunContext, task: GreenfieldTask): Promise<GateResult> {
  const root = ctx.workspace.root;
  const expected = expectedEndpoints(task);
  const { table, program } = await staticTable(root);
  const paths = probePaths(expected, table);
  const log: string[] = [];
  let behaviour: SpecUnit[] = [];
  let evidence: Evidence = new Map();
  let runtime: string | undefined;
  let entry = '';
  try {
    const served = await serveApp(
      { root, exec: ctx.exec, harnessRoot: ctx.run.harnessRoot, logs: ctx.logs, program },
      { logName: 'spec-coverage-probe.txt', budgetMs: BUDGET_MS },
      async (app, transcript) => {
        transcript.push('--- spec probes (sent and judged by the harness)');
        return runScenario(httpClient(app.base, transcript), task, { deadline: app.deadline, paths });
      },
    );
    if (served.ok) {
      behaviour = served.value.units;
      evidence = served.value.evidence;
      entry = served.entry !== undefined ? ` [app: ${served.entry}]` : '';
      if (served.logPath !== undefined) log.push(`probe log: ${served.logPath}`);
    } else {
      runtime = served.reason;
      if (served.logPath !== undefined) log.push(`probe log: ${served.logPath}`);
    }
  } catch (e) {
    runtime = `the probes crashed: ${errMsg(e)}`;
  }
  if (runtime !== undefined) {
    // No app to probe: every behaviour unit is undecided.
    behaviour = task.resources.map((r) => ({ resource: r.name, name: 'behaviour', status: 'unproven', detail: `no behaviour could be probed: ${runtime ?? ''}` }));
  }
  const routes = coverRoutes(expected, table, evidence, runtime);
  const units = [...routes, ...behaviour];
  const failed = units.filter((u) => u.status === 'fail');
  const undecided = units.filter((u) => u.status === 'unproven');
  const missing = routes.filter((u) => u.status === 'fail');
  const logPath = await ctx.logs.write('spec-coverage.txt', [
    `spec coverage of task ${task.id}: ${task.resources.length} resource(s), ${expected.length} expected endpoint(s)`,
    ...expected.map((e) => `expected  ${endpointLabel(e)}  (${e.op} ${e.resource})`),
    ...('error' in table ? [table.error] : [`static route table: ${table.routes.length} route(s), ${table.unresolved} unresolved`]),
    ...units.map(line),
    ...log,
  ].join('\n'));
  const counts = `${units.length - failed.length - undecided.length}/${units.length} units passed (${task.resources.length} resource(s), ${expected.length} endpoint(s)${missing.length > 0 ? `, ${missing.length} missing` : ''})`;
  const details = [...missing, ...failed.filter((u) => !missing.includes(u)), ...undecided].map(line).slice(0, MAX_DETAILS);
  const extras = [task.brief !== undefined ? 'the brief' : '', task.behaviours.length > 0 ? `${task.behaviours.length} behaviour(s)` : '', task.resources.some((r) => (r.notes ?? []).length > 0) ? 'resource notes' : '']
    .filter((x) => x !== '');
  const human = extras.length > 0 ? { humanMustVerify: [`what the task states beyond fields and operations (${extras.join(', ')}): the generated probes cover routes and field constraints only`] } : {};
  if (failed.length > 0) {
    const which = missing.length > 0 ? `; missing: ${missing.slice(0, 3).map((u) => u.name.replace(/^route /, '')).join(', ')}${missing.length > 3 ? ', …' : ''}` : '';
    return { status: 'fail', summary: `${failed.length} failed: ${counts}${which}${entry}`, details, logPath, ...human };
  }
  if (undecided.length > 0) return { status: 'unproven', summary: `${undecided.length} unproven: ${counts}${entry}`, details, logPath, ...human };
  if (units.length === 0) return { status: 'unproven', summary: 'no unit to check: the resources list no operations', logPath };
  return { status: 'pass', summary: `${counts}${entry}`, logPath, ...human };
}

export default defineGate({
  name: 'spec-coverage',
  description:
    'Greenfield: every endpoint the task\'s resources × operations imply exists, and probes generated from the field specs (required, enum, min/max, unique, '
    + 'create/get/list/update/delete, idempotency) pass against the running app. Free-text-only tasks: n/a, a human verifies coverage.',
  phases: ['finish', 'ship'],
  appliesTo: ['greenfield'],
  async run(ctx): Promise<GateResult> {
    const task = ctx.task;
    if (task.kind !== 'greenfield') return { status: 'n/a', summary: 'not applicable to brownfield tasks (contract-lock covers the contract)' };
    if (task.resources.length === 0) {
      return {
        status: 'n/a',
        summary: 'the task lists no structured resources (free-text brief only): behaviour coverage must be verified by a human',
        humanMustVerify: [FREE_TEXT_NOTE],
      };
    }
    return specCoverage(ctx, task);
  },
});
