import { buildRangeRecoverySummary } from '../src/admin/range-instance-recovery';
import type { RangeInstanceRecord } from '../src/admin/admin.repository';

function createRangeInstanceRecord(
  overrides: Partial<RangeInstanceRecord> = {},
): RangeInstanceRecord {
  return {
    id: 'range-1',
    name: '恢复实例',
    createdBy: 'admin',
    ownerUserId: null,
    instanceMode: 'range',
    singleInstanceConfig: null,
    templateId: 'template-1',
    sourceTemplateVersionId: null,
    templateNameSnapshot: null,
    templateSlugSnapshot: null,
    templateVersionSnapshot: null,
    templateModulePathSnapshot: null,
    runtimeTopologyGraph: null,
    runtimeScenarioTemplateSpec: null,
    runtimeCompiledProvisionSpec: null,
    runtimeCredentials: null,
    draftTopologyGraph: null,
    draftScenarioTemplateSpec: null,
    draftCompiledProvisionSpec: null,
    draftUpdatedBy: null,
    draftUpdatedAt: null,
    status: 'create_failed',
    allocatedCidr: null,
    cloudProvider: 'alibaba_cloud',
    accessEntry: null,
    resourceSummary: null,
    errorSummary: null,
    expiresAt: null,
    lastJobId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('buildRangeRecoverySummary', () => {
  it('classifies capacity failures as retryable warnings', () => {
    const summary = buildRangeRecoverySummary({
      instance: createRangeInstanceRecord({
        id: 'range-1',
        name: '恢复实例 1',
        errorSummary: 'No saleable ECS instance type found',
        lastJobId: 'job-1',
      }),
      job: {
        id: 'job-1',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'failed',
        triggeredBy: 'admin',
        startedAt: null,
        finishedAt: null,
        retryCount: 0,
        errorSummary: 'No saleable ECS instance type found',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      steps: [],
    });

    expect(summary).toEqual(
      expect.objectContaining({
        category: 'capacity',
        severity: 'warning',
        canRetry: true,
      }),
    );
  });

  it('classifies credential failures as non-retryable critical issues', () => {
    const summary = buildRangeRecoverySummary({
      instance: createRangeInstanceRecord({
        id: 'range-2',
        name: '恢复实例 2',
        errorSummary: 'Missing required OpenTofu setting: ALICLOUD_ACCESS_KEY',
        lastJobId: 'job-2',
      }),
      job: null,
      steps: [],
    });

    expect(summary).toEqual(
      expect.objectContaining({
        category: 'credentials',
        severity: 'critical',
        canRetry: false,
      }),
    );
  });
});
