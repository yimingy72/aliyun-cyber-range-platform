import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import {
  RangeInstanceDraftRevisionConflictError,
  type ApplyRangeInstanceDraftInput,
} from '../src/admin/admin.repository';

describe('PrismaAdminRepository', () => {
  it('maps PostgreSQL serializable transaction failures to a draft revision conflict', async () => {
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(
        Object.assign(new Error('could not serialize access due to concurrent update'), {
          name: 'PrismaClientUnknownRequestError',
        }),
      ),
    };
    const repository = new PrismaAdminRepository(prisma as never);
    const input: ApplyRangeInstanceDraftInput = {
      rangeInstanceId: 'range-1',
      expectedDraftRevision: 1,
      triggeredBy: 'admin',
      previewToken: 'preview', expectedSourceDigest: 'digest',
      topologySnapshot: {
        draftRevision: 1,
        topologyGraph: { nodes: [], edges: [] },
        topologySpec: {},
        scenarioTemplateSpec: {},
        compiledProvisionSpec: {},
        compiledSpec: {},
        templateModulePath: 'infra/opentofu/modules/range-1',
      },
    };

    await expect(repository.applyRangeInstanceDraft(input)).rejects.toBeInstanceOf(
      RangeInstanceDraftRevisionConflictError,
    );
  });
});

describe('PrismaAdminRepository billing scope', () => {
  it('pushes the exact instance predicate into the indexed database query', async () => {
    const prisma = { billingLedgerResource: { findMany: jest.fn().mockResolvedValue([]) } };
    const repository = new PrismaAdminRepository(prisma as never);
    await repository.listBillingLedgerResources({ rangeInstanceId: 'only-this-instance' });
    expect(prisma.billingLedgerResource.findMany).toHaveBeenCalledWith({ where: { rangeInstanceId: 'only-this-instance' }, orderBy: { createdAt: 'desc' } });
    await repository.listBillingLedgerResources();
    expect(prisma.billingLedgerResource.findMany).toHaveBeenLastCalledWith({ orderBy: { createdAt: 'desc' } });
  });
});
