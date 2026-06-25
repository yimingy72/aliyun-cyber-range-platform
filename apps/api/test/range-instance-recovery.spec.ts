import { buildRangeRecoverySummary } from '../src/admin/range-instance-recovery';

describe('buildRangeRecoverySummary', () => {
  it('classifies capacity failures as retryable warnings', () => {
    const summary = buildRangeRecoverySummary({
      instance: {
        id: 'range-1',
        competitionId: 'competition-1',
        teamId: 'team-1',
        templateId: 'template-1',
        status: 'create_failed',
        allocatedCidr: null,
        cloudProvider: 'alibaba_cloud',
        accessEntry: null,
        resourceSummary: null,
        errorSummary: 'No saleable ECS instance type found',
        expiresAt: null,
        lastJobId: 'job-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
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
      instance: {
        id: 'range-2',
        competitionId: 'competition-1',
        teamId: 'team-1',
        templateId: 'template-1',
        status: 'create_failed',
        allocatedCidr: null,
        cloudProvider: 'alibaba_cloud',
        accessEntry: null,
        resourceSummary: null,
        errorSummary: 'Missing required OpenTofu setting: ALICLOUD_ACCESS_KEY',
        expiresAt: null,
        lastJobId: 'job-2',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
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
