import { runInCloudWorkspace, type CloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { BillingService } from '../src/admin/billing.service';
import type { BillingLedgerResourceRecord } from '../src/admin/admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';

const uid = '1234567890';
const workspace: CloudWorkspaceScope = { cloudWorkspaceId: 'billing-csv-fixture', provider: 'alibaba_cloud', accountUid: uid, isPlatformManager: true };
const window = { startAt: '2026-10-01', endAt: '2026-10-01' };
const metadata = { cloudAccountUid: uid, regionId: 'cn-hangzhou', billingStartAt: new Date('2026-09-01'), tagsSnapshot: {} };
function bill(ledger: BillingLedgerResourceRecord, item: string, amount: number, fingerprint: string) {
  return { cloudAccountUid: uid, syncBatchId: 'fixture-sync', sourceFingerprint: fingerprint, billCycle: '2026-10',
    billingDate: window.startAt, productCode: ledger.cloudResourceType, billItem: item,
    cloudResourceId: ledger.cloudResourceId, cloudResourceType: ledger.cloudResourceType, pretaxAmount: amount,
    currency: 'CNY', billingScope: ledger.billingScope, ownerUserId: ledger.ownerUserId, matchedLedgerId: ledger.id,
    rawPayload: { OwnerID: uid, Region: 'cn-hangzhou' } };
}

describe('billing CSV spreadsheet safety', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-01')));
  afterEach(() => jest.useRealTimers());

  it('exports formula-leading usernames as text, including prefixes hidden by whitespace and controls', () => runInCloudWorkspace(workspace, async () => {
    const repository = createMemoryAdminRepository();
    const names = ['=1+1', '+SUM(1)', '-SUM(1)', '@SUM(1)', ' \t=1+1', '\r=1+1'];
    for (const [index, username] of names.entries()) await repository.createPlatformUser({ id: `user-${index}`, username, passwordHash: 'fixture-unused', role: 'user' });
    const csv = await new BillingService(repository).exportUsersCsv(window);
    expect(csv).toContain("user-0,'=1+1,CNY,0,0");
    expect(csv).toContain("user-1,'+SUM(1),CNY,0,0");
    expect(csv).toContain("user-2,'-SUM(1),CNY,0,0");
    expect(csv).toContain("user-3,'@SUM(1),CNY,0,0");
    expect(csv).toContain("user-4,' \t=1+1,CNY,0,0");
    expect(csv).toContain('user-5,"\'\r=1+1",CNY,0,0');
  }));

  it('quotes delimiters and newlines in official item text and blocks formulas while retaining numeric refunds', () => runInCloudWorkspace(workspace, async () => {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({ id: 'user', username: 'user', passwordHash: 'fixture-unused', role: 'user' });
    const { ledger } = await createProvenBillingLedger(repository, { ...metadata, cloudResourceId: 'i-proven', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'user' });
    await repository.upsertBillingLineItems([
      bill(ledger, '=SUM(1,2)', 1.25, 'charge'),
      bill(ledger, '\t@SUM(1)', -0.25, 'refund'),
      bill(ledger, 'Quoted "label",\ncontinued', 0, 'multiline'),
    ]);
    const service = new BillingService(repository);
    const csv = await service.exportUserItemsCsv('user', window);
    expect(csv).toContain('ecs,"\'=SUM(1,2)",ecs,i-proven,1.25,CNY');
    expect(csv).toContain("ecs,'\t@SUM(1),ecs,i-proven,-0.25,CNY");
    expect(csv).toContain('ecs,"Quoted ""label"",\ncontinued",ecs,i-proven,0,CNY');
    expect(csv).not.toContain("i-proven,'-0.25");
    expect(await service.exportUsersCsv(window)).toContain('user,user,CNY,1,3');
  }));

  it('keeps negative public and total costs numeric across actual platform and user exports', () => runInCloudWorkspace(workspace, async () => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, { ...metadata, cloudResourceId: 'eip-proven', cloudResourceType: 'eip', billingScope: 'platform' });
    await repository.upsertBillingLineItems([bill(ledger, 'Adjustment', -0.75, 'platform-refund')]);
    const csv = await new BillingService(repository).exportPlatformCsv(window);
    expect(csv).toContain('totalPretaxAmount,-0.75\n');
    expect(csv).toContain('platformPretaxAmount,-0.75\n');
    expect(csv).toContain('CNY,-0.75,-0.75\n');
    expect(csv).toContain('eip,CNY,-0.75\n');
    expect(csv).not.toContain("'-0.75");
  }));
});
