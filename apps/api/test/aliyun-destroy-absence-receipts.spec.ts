import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

const account = { provider: 'alibaba_cloud', accountUid: '100000000001', accountUidResolved: true,
  cloudAccountContextId: 'context-a', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'fake', accessKeySecret: 'fake' };
const summary = { mode: 'opentofu', vpcId: 'vpc-owned', subnetIds: { primary: 'vsw-owned' }, executionContext: {
  provider: account.provider, cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId,
  regionId: account.defaultRegion, zoneId: account.defaultZoneId } };
const receipt = (Code: string, RequestId = 'request-owned') => ({ Code, RequestId, Message: 'private token must not appear' });
function fixture(handler: (action: string, request: URL) => { status: number; body: unknown }) {
  const repository = { updateBillingLedgerResource: jest.fn() };
  const worker = new ProvisioningWorkerService(repository as never, {} as never, {} as never, {} as never, {} as never, {} as never) as any;
  const query = jest.spyOn(global, 'fetch').mockImplementation(async url => {
    const request = new URL(String(url));
    const { status, body } = handler(request.searchParams.get('Action')!, request);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return { worker, repository, query };
}
afterEach(() => jest.restoreAllMocks());

it.each([[400, 'Forbidden.VpcNotFound'], [404, 'InvalidVpcId.NotFound']])('accepts only documented exact VPC missing receipt %s/%s in the original inventory context', async (status, code) => {
  const { worker, query, repository } = fixture((action, request) => {
    expect(request.searchParams.get('RegionId')).toBe(account.defaultRegion);
    if (action === 'DescribeVpcAttribute') { expect(request.searchParams.get('VpcId')).toBe(summary.vpcId); return { status: Number(status), body: receipt(String(code)) }; }
    expect(action).toBe('DescribeVSwitches'); expect(request.searchParams.get('VSwitchId')).toBe('vsw-owned');
    expect(request.searchParams.get('PageSize')).toBe('50');
    expect(request.searchParams.has('VpcId')).toBe(false);
    return { status: 404, body: receipt('InvalidVSwitchId.NotFound') };
  });
  await expect(worker.findResidualCloudResources(summary, account)).resolves.toEqual([]);
  expect(query).toHaveBeenCalledTimes(2);
  expect(repository.updateBillingLedgerResource).not.toHaveBeenCalled();
});

it.each(['provider', 'accountUid', 'cloudAccountContextId', 'defaultRegion', 'defaultZoneId', 'accountUidResolved'])('does not accept missing-ID receipts after frozen %s changes', async field => {
  const { worker } = fixture(() => ({ status: 400, body: receipt('Forbidden.VpcNotFound') }));
  const other = { ...account, [field]: field === 'accountUidResolved' ? false : 'other' };
  await expect(worker.findResidualCloudResources(summary, other)).rejects.toThrow();
});

it.each([
  [400, 'InvalidVpcId.NotFound', 'request-owned'], [403, 'Forbidden.VpcNotFound', 'request-owned'],
  [400, 'Forbidden.RAM', 'request-owned'], [400, 'InvalidAccount.NotFound', 'request-owned'],
  [404, 'InvalidRegionId.NotFound', 'request-owned'], [400, 'Forbidden.VpcNotFound', ''],
  [400, 'Forbidden.VpcNotFound', 'request\nprivate'], [200, 'Forbidden.VpcNotFound', 'request-owned'],
  [400, 'raw\nprivate token', 'request-owned'],
])('keeps failed verification for unapproved status/code/receipt %j %j %j', async (status, code, requestId) => {
  const { worker } = fixture(() => ({ status: Number(status), body: receipt(String(code), String(requestId)) }));
  let failure: Error | null = null;
  try { await worker.findResidualCloudResources(summary, account); } catch (error) { failure = error as Error; }
  expect(failure).toBeInstanceOf(Error); expect(failure!.message).not.toMatch(/private|token/);
});

it('requires recorded exact inventory and rejects missing-context or malformed IDs', async () => {
  const { worker } = fixture(() => ({ status: 400, body: receipt('Forbidden.VpcNotFound') }));
  await expect(worker.findResidualCloudResources({ ...summary, executionContext: undefined }, account)).rejects.toThrow();
  await expect(worker.findResidualCloudResources({ ...summary, vpcId: 'invalid' }, account)).rejects.toThrow();
});

it.each([{ VpcId: 'vpc-other' }, { RegionId: 'cn-shanghai' }, { RegionId: null }, { RequestId: '' }, { RequestId: 'raw\nprivate' }])('rejects conflicting success receipt %j', async extra => {
  const { worker } = fixture(() => ({ status: 200, body: { RequestId: 'request-owned', VpcId: summary.vpcId, RegionId: account.defaultRegion, ...extra } }));
  await expect(worker.findResidualCloudResources(summary, account)).rejects.toThrow('unexpected resource identity');
});

function vpcPage(total: number, rows: unknown[], pageNumber = 1) {
  return { RequestId: 'request-vpcs', PageNumber: pageNumber, PageSize: 50, TotalCount: total, Vpcs: { Vpc: rows } };
}
const emptyAttribute = { RequestId: 'request-empty-vpc', VpcId: '', RegionId: '' };

it.each(['', undefined])('proves absence after an empty Attribute only with two complete stable region inventories: %j', async VpcId => {
  const { worker, query } = fixture((action, request) => {
    if (action === 'DescribeVpcAttribute') return { status: 200, body: { ...emptyAttribute, VpcId } };
    expect(action).toBe('DescribeVpcs'); expect(request.searchParams.get('RegionId')).toBe(account.defaultRegion);
    expect(request.searchParams.get('PageSize')).toBe('50'); expect(request.searchParams.get('PageNumber')).toBe('1');
    expect(request.searchParams.has('VpcId')).toBe(false); expect(request.searchParams.has('VpcName')).toBe(false);
    expect([...request.searchParams.keys()].some(key => key.startsWith('Tag.'))).toBe(false);
    expect(['true', 'false']).toContain(request.searchParams.get('IsDefault'));
    return { status: 200, body: vpcPage(0, []) };
  });
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).resolves.toEqual([]);
  expect(query).toHaveBeenCalledTimes(5);
});

it.each(['context', 'uid', 'region', 'provider', 'resolved', 'invalid-id'])('does not enumerate an unfrozen %s source after an empty Attribute', async mismatch => {
  const { worker, query } = fixture(() => ({ status: 200, body: emptyAttribute }));
  const original = { ...account };
  if (mismatch === 'context') original.cloudAccountContextId = 'other';
  if (mismatch === 'uid') original.accountUid = 'other';
  if (mismatch === 'region') original.defaultRegion = 'cn-shanghai';
  if (mismatch === 'provider') original.provider = 'other';
  if (mismatch === 'resolved') original.accountUidResolved = false;
  await expect(worker.findResidualCloudResources({ ...summary, vpcId: mismatch === 'invalid-id' ? 'invalid' : summary.vpcId, subnetIds: {} }, original)).rejects.toThrow('unexpected resource identity');
  expect(query).toHaveBeenCalledTimes(1);
});

it('finds a recorded VPC on a later non-default page instead of falsely releasing its ledger', async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ VpcId: `vpc-other${index}`, RegionId: account.defaultRegion }));
  const { worker, query, repository } = fixture((action, request) => {
    if (action === 'DescribeVpcAttribute') return { status: 200, body: emptyAttribute };
    if (request.searchParams.get('IsDefault') === 'true') return { status: 200, body: vpcPage(0, []) };
    const page = Number(request.searchParams.get('PageNumber'));
    return { status: 200, body: vpcPage(51, page === 1 ? rows : [{ VpcId: summary.vpcId }], page) };
  });
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).resolves.toEqual(['vpc:vpc-owned']);
  expect(query).toHaveBeenCalledTimes(7); expect(repository.updateBillingLedgerResource).not.toHaveBeenCalled();
});

it.each([
  {}, { RequestId: '' }, { RequestId: 'raw\nprivate' }, { PageNumber: 2 }, { PageSize: 100 }, { TotalCount: -1 },
  { TotalCount: 2501 }, { TotalCount: 1 }, { Vpcs: null }, { Vpcs: { Vpc: {} } }, { NextToken: 'more' },
  { TotalCount: 1, Vpcs: { Vpc: [{ VpcId: 'invalid' }] } },
  { TotalCount: 1, Vpcs: { Vpc: [{ VpcId: 'vpc-other', RegionId: 'cn-shanghai' }] } },
  { TotalCount: 2, Vpcs: { Vpc: [{ VpcId: 'vpc-other' }, { VpcId: 'vpc-other' }] } },
])('rejects incomplete regional absence evidence %j', async extra => {
  const { worker } = fixture(action => action === 'DescribeVpcAttribute' ? { status: 200, body: emptyAttribute }
    : { status: 200, body: Object.keys(extra).length ? { ...vpcPage(0, []), ...extra } : {} });
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).rejects.toThrow('Cloud VPC inventory');
});

it('rejects a permission failure on the regional list and retains its safe error code', async () => {
  const { worker } = fixture(action => action === 'DescribeVpcAttribute' ? { status: 200, body: emptyAttribute }
    : { status: 403, body: receipt('Forbidden.RAM') });
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).rejects.toThrow('403 (Forbidden.RAM)');
});

it.each(['count', 'duplicate', 'changed-snapshot'])('rejects pagination drift: %s', async kind => {
  let listReads = 0;
  const rows = Array.from({ length: 50 }, (_, index) => ({ VpcId: `vpc-other${index}` }));
  const { worker } = fixture((action, request) => {
    if (action === 'DescribeVpcAttribute') return { status: 200, body: emptyAttribute };
    listReads++;
    if (kind === 'changed-snapshot') return { status: 200, body: vpcPage(1, [{ VpcId: listReads <= 2 ? 'vpc-first' : 'vpc-second' }]) };
    if (request.searchParams.get('IsDefault') === 'true') return { status: 200, body: vpcPage(0, []) };
    const page = Number(request.searchParams.get('PageNumber'));
    return { status: 200, body: vpcPage(page === 2 && kind === 'count' ? 50 : 51, page === 1 ? rows : [{ VpcId: 'vpc-other0' }], page) };
  });
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).rejects.toThrow('Cloud VPC inventory');
});

it('caps regional enumeration even when the cloud claims many valid pages', async () => {
  const { worker, query } = fixture((action, request) => {
    if (action === 'DescribeVpcAttribute') return { status: 200, body: emptyAttribute };
    const page = Number(request.searchParams.get('PageNumber'));
    const rows = Array.from({ length: 50 }, (_, index) => ({ VpcId: `vpc-${page}other${index}` }));
    return { status: 200, body: vpcPage(2500, rows, page) };
  });
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).rejects.toThrow('page limit');
  expect(query).toHaveBeenCalledTimes(51);
});

it('accepts a documented exact VPC success receipt without optional RegionId and keeps the VPC residual', async () => {
  const { worker } = fixture(() => ({ status: 200, body: { RequestId: 'request-owned', VpcId: summary.vpcId } }));
  await expect(worker.findResidualCloudResources({ ...summary, subnetIds: {} }, account)).resolves.toEqual(['vpc:vpc-owned']);
});

it('limits malformed success diagnostics to safe identity fields without copying cloud content', async () => {
  const { worker } = fixture(() => ({ status: 200, body: { RequestId: 'raw\nprivate token', VpcId: '', Message: 'private token', RegionId: 'raw\nprivate' } }));
  await expect(worker.findResidualCloudResources(summary, account)).rejects.toThrow('VpcId=empty, RegionId=invalid, RequestId=invalid');
  await expect(worker.findResidualCloudResources(summary, account)).rejects.not.toThrow('private');
});

it('still reports an existing exact VPC and refuses malformed empty-list evidence for switches', async () => {
  const { worker } = fixture(action => action === 'DescribeVpcAttribute'
    ? { status: 200, body: { RequestId: 'request-owned', VpcId: summary.vpcId, RegionId: account.defaultRegion } }
    : { status: 200, body: { RequestId: 'request-owned', TotalCount: 0, PageSize: 50, PageNumber: 1, VSwitches: { VSwitch: [] } } });
  await expect(worker.findResidualCloudResources(summary, account)).resolves.toEqual(['vpc:vpc-owned']);
});

it('does not treat missing-VPC errors as proof that a specific switch disappeared', async () => {
  const { worker } = fixture(() => ({ status: 400, body: receipt('Forbidden.VpcNotFound') }));
  await expect(worker.findResidualCloudResources({ ...summary, vpcId: undefined }, account)).rejects.toThrow('DescribeVSwitches');
});

it.each(['DescribeNatGateways', 'DescribeEipAddresses'])('does not generalize unapproved missing-resource codes to %s', async action => {
  const { worker } = fixture(() => ({ status: 404, body: receipt(action === 'DescribeNatGateways' ? 'InvalidNatGatewayId.NotFound' : 'InvalidAllocationId.NotFound') }));
  const input = { ...summary, vpcId: undefined, subnetIds: {}, ...(action === 'DescribeNatGateways' ? { natGatewayIds: { nat: 'ngw-owned' } } : { eipAllocationId: 'eip-owned' }) };
  await expect(worker.findResidualCloudResources(input, account)).rejects.toThrow(action);
});
