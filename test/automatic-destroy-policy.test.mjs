import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// Exercise the actual dependency-free policy without Nest, a database, Docker or cloud access.
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../apps/api/src/provisioning/automatic-destroy-policy.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const exports = {};
new Function('exports', compiled.outputText)(exports);
const decide = exports.expiredSingleDestroyDecision;
const now = new Date('2026-10-12T00:05:00Z');
const instance = (patch = {}) => ({ id: 'fixture-instance', instanceMode: 'single', status: 'running',
  cloudWorkspaceId: 'fixture-space', expiresAt: new Date('2026-10-12T00:00:00Z'), lastJobId: null,
  singleInstanceConfig: { cloudAccountContextId: 'fixture-context', cloudAccountUid: 'fixture-account', regionId: 'cn-hangzhou' }, ...patch });
const job = (patch = {}) => ({ id: 'fixture-job', rangeInstanceId: 'fixture-instance', cloudWorkspaceId: 'fixture-space',
  jobType: 'refresh_status', status: 'running', triggeredBy: 'system:auto-expire', retryCount: 0,
  finishedAt: new Date('2026-10-12T00:01:00Z'), errorSummary: 'Cloud request timed out', ...patch });

test('expired legacy instance without a job can enter verified destruction', () => {
  assert.deepEqual(decide(instance(), null, now), { retryCount: 0, supersedeJobId: null });
});
test('expiry boundary is inclusive', () => {
  assert.ok(decide(instance({ expiresAt: now }), null, now));
});
for (const patch of [{ expiresAt: new Date('2026-10-12T00:06:00Z') }, { expiresAt: null }, { expiresAt: new Date('invalid') },
  ...['pending_create', 'pending_destroy', 'destroying', 'destroyed', 'create_failed'].map(status => ({ status })), { instanceMode: 'range' }]) {
  test(`rejects ineligible current instance ${JSON.stringify(patch)}`, () => assert.equal(decide(instance(patch), null, now), null));
}
test('rejects an invalid scan clock', () => assert.equal(decide(instance(), null, new Date('invalid')), null));
test('supersedes only a pending or running refresh at expiry', () => {
  for (const status of ['pending', 'running']) assert.deepEqual(decide(instance({ lastJobId: 'fixture-job' }), job({ status }), now),
    { retryCount: 0, supersedeJobId: 'fixture-job' });
});
for (const jobType of ['create', 'update', 'destroy', 'retry']) {
  test(`does not interrupt running ${jobType}`, () => assert.equal(decide(instance({ lastJobId: 'fixture-job' }), job({ jobType }), now), null));
}
test('does not replace an accepted pending destroy', () => assert.equal(decide(instance({ lastJobId: 'fixture-job' }), job({ jobType: 'destroy', status: 'pending' }), now), null));
for (const previous of [null, job({ id: 'other-job' }), job({ rangeInstanceId: 'other-instance' }), job({ cloudWorkspaceId: 'other-space' })]) {
  test(`rejects missing or mismatched last job ${JSON.stringify(previous)}`, () => assert.equal(decide(instance({ lastJobId: 'fixture-job' }), previous, now), null));
}
const retryInstance = () => instance({ status: 'destroy_failed', lastJobId: 'fixture-job' });
const failedDestroy = (patch = {}) => job({ jobType: 'destroy', status: 'failed', ...patch });
test('bounded transient retries use their original finish time and exponential backoff', () => {
  for (const retryCount of [0, 1, 2]) {
    const previous = failedDestroy({ retryCount });
    const due = previous.finishedAt.getTime() + 60_000 * 2 ** retryCount;
    assert.equal(decide(retryInstance(), previous, new Date(due - 1)), null);
    assert.deepEqual(decide(retryInstance(), previous, new Date(due)), { retryCount: retryCount + 1, supersedeJobId: null });
  }
});
for (const patch of [{ retryCount: -1 }, { retryCount: 0.5 }, { retryCount: 3 }, { retryCount: Infinity }, { finishedAt: null },
  { finishedAt: new Date('invalid') }, { triggeredBy: 'manual-user' }, { status: 'pending' }, { jobType: 'create' },
  ...['unknown ownership after timeout', 'credential timeout', 'unverified disk', 'permanent failure'].map(errorSummary => ({ errorSummary }))]) {
  test(`blocks unsafe retry ${JSON.stringify(patch)}`, () => assert.equal(decide(retryInstance(), failedDestroy(patch), now), null));
}
for (const binding of [null, {}, [], { cloudAccountContextId: 'context', cloudAccountUid: 'account', regionId: ' ' }]) {
  test(`requires frozen cleanup identity ${JSON.stringify(binding)}`, () => assert.equal(decide({ ...retryInstance(), singleInstanceConfig: binding }, failedDestroy(), now), null));
}
test('decision leaves lifecycle and source data unchanged', () => {
  const current = retryInstance(), previous = failedDestroy();
  const snapshot = structuredClone({ current, previous });
  decide(current, previous, now);
  assert.deepEqual({ current, previous }, snapshot);
});
