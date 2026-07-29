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
