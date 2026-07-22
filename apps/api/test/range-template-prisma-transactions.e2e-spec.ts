import { randomUUID } from 'node:crypto';

import { TemplateRevisionConflictError } from '../src/admin/admin.repository';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase('Prisma range template state transactions', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  let templateId: string | null = null;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new PrismaAdminRepository(prisma);
  });

  afterEach(async () => {
    if (templateId) {
      await prisma.rangeTemplate.deleteMany({
        where: { id: templateId },
      });
      templateId = null;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('serializes publish, save, and return-to-private by revision without partial state', async () => {
    const suffix = randomUUID();
    const topologySpec = {
      vpcCidr: '10.210.0.0/16',
      networkZones: [
        {
          key: 'dmz',
          name: 'DMZ',
          purpose: 'public-entry',
          cidr: '10.210.10.0/24',
          isPublicEntry: true,
        },
      ],
      hosts: [
        {
          key: 'entry',
          name: 'Entry',
          zoneKey: 'dmz',
          role: 'entry',
          privateIp: '10.210.10.10',
          exposePublic: true,
        },
      ],
      publicEntry: {
        hostKey: 'entry',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
    const initialTopology = {
      topologySpec,
      topologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [{ id: 'entry', kind: 'ecs', label: 'Entry' }],
        edges: [],
      },
      scenarioTemplateSpec: {
        topology: { vpcCidr: topologySpec.vpcCidr, entryHostKey: 'entry' },
      },
      compiledProvisionSpec: {
        topology: { vpcCidr: topologySpec.vpcCidr, entryHostKey: 'entry' },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        resources: [],
        topology: {
          vpcCidr: topologySpec.vpcCidr,
          publicEntryHostKey: 'entry',
          networkZoneKeys: ['dmz'],
          hostKeys: ['entry'],
        },
      },
    };
    const created = await repository.createRangeTemplate({
      name: `transaction-template-${suffix}`,
      slug: `transaction-template-${suffix}`,
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      ...initialTopology,
      variableSchema: {},
      outputSchema: {},
      visibility: 'private',
    });
    templateId = created.id;

    const concurrentPublish = await Promise.allSettled([
      repository.publishRangeTemplateToPlatform(created.id, created.revision),
      repository.publishRangeTemplateToPlatform(created.id, created.revision),
    ]);
    const publishedResults = concurrentPublish.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.publishRangeTemplateToPlatform>>> =>
        result.status === 'fulfilled',
    );
    const rejectedPublish = concurrentPublish.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(publishedResults).toHaveLength(1);
    expect(rejectedPublish).toHaveLength(1);
    expect(rejectedPublish[0].reason).toBeInstanceOf(TemplateRevisionConflictError);

    const published = publishedResults[0].value;
    const publishedSnapshotId = published.currentPublishedVersionId;

    expect(published).toEqual(
      expect.objectContaining({
        visibility: 'platform',
        revision: 2,
      }),
    );
    expect(publishedSnapshotId).toEqual(expect.any(String));

    const idempotentPublish = await repository.publishRangeTemplateToPlatform(
      created.id,
      published.revision,
    );

    expect(idempotentPublish.revision).toBe(published.revision);
    expect(idempotentPublish.currentPublishedVersionId).toBe(publishedSnapshotId);

    const saved = await repository.saveRangeTemplateTopology(created.id, {
      ...initialTopology,
      topologyGraph: {
        ...initialTopology.topologyGraph,
        nodes: [{ id: 'entry', kind: 'ecs', label: 'Changed Entry' }],
      },
      expectedRevision: published.revision,
    });

    expect(saved).toEqual(
      expect.objectContaining({
        visibility: 'private',
        revision: 3,
        currentPublishedVersionId: null,
      }),
    );
    expect((await repository.getRangeTemplateVersionById(publishedSnapshotId!))?.status).toBe('archived');

    await expect(
      repository.publishRangeTemplateToPlatform(created.id, published.revision),
    ).rejects.toBeInstanceOf(TemplateRevisionConflictError);

    const republished = await repository.publishRangeTemplateToPlatform(
      created.id,
      saved.revision,
    );

    expect(republished).toEqual(
      expect.objectContaining({
        visibility: 'platform',
        revision: 4,
      }),
    );
    expect(republished.currentPublishedVersionId).not.toBe(publishedSnapshotId);

    const concurrentReturn = await Promise.allSettled([
      repository.unshareRangeTemplate(created.id, republished.revision),
      repository.unshareRangeTemplate(created.id, republished.revision),
    ]);
    const privateResults = concurrentReturn.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.unshareRangeTemplate>>> =>
        result.status === 'fulfilled',
    );
    const rejectedReturn = concurrentReturn.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(privateResults).toHaveLength(1);
    expect(rejectedReturn).toHaveLength(1);
    expect(rejectedReturn[0].reason).toBeInstanceOf(TemplateRevisionConflictError);
    expect(privateResults[0].value).toEqual(
      expect.objectContaining({
        visibility: 'private',
        revision: 5,
      }),
    );

    const idempotentPrivate = await repository.unshareRangeTemplate(
      created.id,
      privateResults[0].value.revision,
    );

    expect(idempotentPrivate.revision).toBe(privateResults[0].value.revision);

    const versions = await prisma.rangeTemplateVersion.findMany({
      where: { templateId: created.id },
    });

    expect(versions.filter((version) => version.status === 'published')).toHaveLength(1);
    expect(versions.filter((version) => version.status === 'draft')).toHaveLength(1);
  });
});
