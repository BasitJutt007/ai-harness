/**
 * node:test reporter used by the harness's runner adapter (src/core/testing.ts):
 *   node --test --test-reporter=<this file> --test-reporter-destination=/dev/fd/3 …
 *
 * Turns the runner's event stream into the same JSON shape vitest and jest write
 * ({ testResults: [{ name, status, message, assertionResults: [{ ancestorTitles, title,
 * status, failureMessages, location }] }] }), so one parser serves every runner.
 * It runs in the `node --test` process itself (test files run in child processes that
 * never hold fd 3), so test code cannot forge what it writes.
 */
import { relative, resolve } from 'node:path';

const MAX_MESSAGE = 4000;

function message(error) {
  if (error === undefined || error === null) return 'failed';
  const inner = error.cause ?? error;
  const name = typeof inner.name === 'string' ? inner.name : 'Error';
  const text = typeof inner.message === 'string' ? inner.message : String(inner);
  return `${name}: ${text}`.slice(0, MAX_MESSAGE);
}

export default async function* harnessReporter(source) {
  const cwd = process.cwd();
  const files = new Map();
  const entry = (file) => {
    const abs = resolve(cwd, file);
    let f = files.get(abs);
    if (f === undefined) {
      f = { stack: [], cases: [], wrapperFailed: false, output: [] };
      files.set(abs, f);
    }
    return f;
  };
  for await (const event of source) {
    const d = event.data ?? {};
    if (typeof d.file !== 'string') continue;
    const f = entry(d.file);
    const rel = relative(cwd, resolve(cwd, d.file));
    // The per-file wrapper test node:test reports when a file fails to load (named after the file).
    const wrapper = d.nesting === 0 && (d.name === rel || d.name === d.file || d.name === resolve(cwd, d.file));
    if (event.type === 'test:start') {
      if (wrapper) continue;
      f.stack.length = d.nesting;
      f.stack[d.nesting] = String(d.name);
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (wrapper) {
        if (event.type === 'test:fail') f.wrapperFailed = true;
        continue;
      }
      const details = d.details ?? {};
      if (details.type === 'suite') {
        // A suite that failed for its own reason (a hook, a throw at collection) is a file-level error.
        const failure = details.error?.failureType;
        if (event.type === 'test:fail' && failure !== 'subtestsFailed') f.output.push(message(details.error));
        continue;
      }
      const cancelled = details.error?.failureType === 'cancelledByParent';
      const status = d.skip !== undefined && d.skip !== false ? 'skipped'
        : d.todo !== undefined && d.todo !== false ? 'todo'
          : event.type === 'test:pass' ? 'passed' : cancelled ? 'skipped' : 'failed';
      f.cases.push({
        ancestorTitles: f.stack.slice(0, d.nesting),
        title: String(d.name),
        status,
        failureMessages: status === 'failed' ? [message(details.error)] : [],
        location: typeof d.line === 'number' ? { line: d.line, column: typeof d.column === 'number' ? d.column : 0 } : null,
      });
    } else if (event.type === 'test:stderr' || event.type === 'test:stdout') {
      if (typeof d.message === 'string' && f.output.join('').length < MAX_MESSAGE) f.output.push(d.message);
    }
  }
  const testResults = [];
  for (const [name, f] of files) {
    const failed = f.wrapperFailed || f.cases.some((c) => c.status === 'failed');
    const loadError = f.cases.length === 0 || (f.wrapperFailed && !f.cases.some((c) => c.status === 'failed'));
    // Start a load error at the error line itself (node prints the internal frame that threw first).
    const raw = f.output.join('').trim();
    const at = raw.search(/^[A-Za-z]*Error\b/m);
    const output = (at > 0 ? raw.slice(at) : raw).slice(0, MAX_MESSAGE);
    testResults.push({
      name,
      status: failed || f.cases.length === 0 ? 'failed' : 'passed',
      message: loadError ? output || (f.cases.length === 0 ? 'No test found in file' : 'test file failed') : '',
      assertionResults: f.cases,
    });
  }
  yield `${JSON.stringify({ testResults })}\n`;
}
