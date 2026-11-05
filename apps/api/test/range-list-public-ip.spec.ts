import { RangeInstancesService } from '../src/admin/range-instances.service';

it('projects only the DNAT IP into range lists, without exposing credentials or access commands', async () => {
  const instance = { id: 'range', name: 'range', instanceMode: 'range', ownerUserId: 'owner', createdBy: 'owner', status: 'running', templateId: 'template', createdAt: new Date(), lastJobId: 'job', accessEntry: { publicIp: ' 39.1.2.3 ', privateIp: '10.0.0.10', ssh: 'private-command' }, runtimeCredentials: { host: { password: 'private-password' } } };
  const repository: any = { listRangeInstances: jest.fn().mockResolvedValue([instance]), listRangeTemplates: jest.fn().mockResolvedValue([]), getPlatformUserById: jest.fn().mockResolvedValue({ username: 'owner' }) };
  const service: any = new RangeInstancesService(repository, {} as any, {} as any, {} as any, {} as any);
  jest.spyOn(service, 'attachRecoverySummary').mockImplementation(async value => value);
  const result = await service.list({ id: 'owner', role: 'user' });
  expect(result[0].dnatPublicIp).toBe('39.1.2.3');
  expect(JSON.stringify(result)).not.toMatch(/private-password|private-command|10\.0\.0\.10|runtimeCredentials|accessEntry/);
  instance.accessEntry.publicIp = '';
  expect((await service.list({ id: 'owner', role: 'user' }))[0].dnatPublicIp).toBeNull();
  expect(await service.list({ id: 'another-owner', role: 'user' })).toEqual([]);
});
