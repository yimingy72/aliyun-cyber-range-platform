import { ForbiddenException } from '@nestjs/common';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

it('scopes both current and historical instance lists to the caller until an admin selects all users', async () => {
  const repository = createMemoryAdminRepository();
  const admin = { id: 'admin', username: 'admin', role: 'admin' as const };
  const user = { id: 'user', username: 'user', role: 'user' as const };
  const range = new RangeInstancesService(repository, {} as never, {} as never, {} as never, {} as never);
  const single = new SingleInstancesService(repository, {} as never, {} as never, {} as never, {} as never, {} as never);
  for (const instanceMode of ['single', 'range'] as const) {
    for (const status of ['running', 'destroyed'] as const) {
      for (const owner of [admin, user]) {
        await repository.createRangeInstance({ instanceMode, status, name: `${owner.id}-${instanceMode}-${status}`, ownerUserId: owner.id });
      }
    }
  }
  for (const view of ['active', 'history'] as const) {
    expect((await range.list(admin, view)).map(item => item.ownerUserId)).toEqual([admin.id]);
    expect((await single.list(admin, view)).standaloneInstances.map(item => item.ownerUserId)).toEqual([admin.id]);
    expect((await range.list(admin, view, 'all')).map(item => item.ownerUserId).sort()).toEqual([admin.id, user.id]);
    expect((await single.list(admin, view, 'all')).standaloneInstances.map(item => item.ownerUserId).sort()).toEqual([admin.id, user.id]);
    expect((await range.list(user, view)).map(item => item.ownerUserId)).toEqual([user.id]);
    expect((await single.list(user, view)).standaloneInstances.map(item => item.ownerUserId)).toEqual([user.id]);
    await expect(range.list(user, view, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(single.list(user, view, 'all')).rejects.toBeInstanceOf(ForbiddenException);
  }
});
