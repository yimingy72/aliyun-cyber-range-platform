import { ForbiddenException } from '@nestjs/common';
import { RangesController } from '../src/admin/ranges.controller';
import { SingleInstancesController } from '../src/admin/single-instances.controller';
import type { AuthenticatedPlatformRequest } from '../src/auth/request-auth-context';

const actor = { id: 'user-1', username: 'user', role: 'user' as const };
const request = { headers: { 'x-request-id': 'audit-request' }, adminUser: actor,
  authContext: { user: actor, source: 'mcp', oauthClientId: 'fixture-mcp' } } as AuthenticatedPlatformRequest;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setup(kind: 'single' | 'range') {
  const getAccessById = jest.fn();
  const runAction = jest.fn();
  const audit = jest.fn().mockResolvedValue(undefined);
  const service = { getAccessById, runAction };
  const controller = kind === 'single'
    ? new SingleInstancesController(service as never, { audit } as never, {} as never)
    : new RangesController(service as never, { run: runAction } as never, { audit } as never);
  return { audit, getAccessById, runAction,
    access: () => controller.getAccess(request, 'owned-instance'),
    vnc: () => controller instanceof SingleInstancesController
      ? controller.runAction(request, 'owned-instance', 'open-vnc', {})
      : controller.runNodeAction(request, 'owned-instance', 'node-1', 'open-vnc', {}),
  };
}

describe.each(['single', 'range'] as const)('%s credential access auditing', kind => {
  it('records success only after the ownership check and credential read succeed', async () => {
    const fixture = setup(kind);
    const access = deferred<Record<string, unknown>>();
    fixture.getAccessById.mockReturnValue(access.promise);
    const result = fixture.access();
    expect(fixture.audit).not.toHaveBeenCalled();
    access.resolve({ id: 'owned-instance', password: 'fixture-private-value' });
    await expect(result).resolves.toEqual({ id: 'owned-instance', password: 'fixture-private-value' });
    expect(fixture.audit).toHaveBeenCalledTimes(1);
    expect(fixture.audit.mock.calls[0][0]).toMatchObject({ actorUserId: 'user-1', phase: 'succeeded', targetId: 'owned-instance' });
    expect(JSON.stringify(fixture.audit.mock.calls)).not.toContain('fixture-private-value');
  });

  it('does not record successful disclosure for a rejected resource', async () => {
    const fixture = setup(kind);
    fixture.getAccessById.mockRejectedValue(new ForbiddenException('Not owned'));
    await expect(fixture.access()).rejects.toThrow('Not owned');
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it.each(['access', 'vnc'] as const)('awaits the %s audit before returning sensitive output', async action => {
    const fixture = setup(kind);
    const audit = deferred<void>();
    fixture.audit.mockReturnValue(audit.promise);
    fixture.getAccessById.mockResolvedValue({ id: 'owned-instance' });
    fixture.runAction.mockResolvedValue({ nodeId: 'node-1' });
    let settled = false;
    const result = fixture[action]().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.audit).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    audit.resolve();
    await result;
    expect(settled).toBe(true);
  });
});
