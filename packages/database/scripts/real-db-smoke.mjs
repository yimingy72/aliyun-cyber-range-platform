import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '../generated/client/index.js';

const prisma = new PrismaClient();
const suffix = randomUUID();
const smokeUserId = `smoke-user-${suffix}`;
const smokeUsername = `smoke-${suffix}`;
const smokeSlug = `smoke-template-${suffix}`;
const smokeImageId = `m-smoke-${suffix}`;

let createdUserId = null;
let createdTemplateId = null;
let createdAssetId = null;
let createdInstanceId = null;

try {
  await prisma.$connect();

  const seededAdmin = await prisma.platformUser.findUnique({
    where: {
      id: 'admin',
    },
  });

  assert.ok(seededAdmin, 'expected seeded admin user after migrations');
  assert.equal(seededAdmin.username, 'admin');
  assert.equal(seededAdmin.role, 'admin');
  assert.equal(seededAdmin.status, 'active');

  const createdUser = await prisma.platformUser.create({
    data: {
      id: smokeUserId,
      username: smokeUsername,
      passwordHash: `hash-${suffix}`,
      role: 'user',
      status: 'active',
    },
  });
  createdUserId = createdUser.id;

  const createdTemplate = await prisma.rangeTemplate.create({
    data: {
      name: `smoke-template-${suffix}`,
      slug: smokeSlug,
      version: '1.0.0',
      modulePathOrRef: 'smoke/module',
      variableSchema: {},
      outputSchema: {},
      ownerUserId: createdUser.id,
    },
  });
  createdTemplateId = createdTemplate.id;

  assert.equal(createdTemplate.visibility, 'private');
  assert.equal(createdTemplate.ownerUserId, createdUser.id);

  const createdAsset = await prisma.platformImageAsset.create({
    data: {
      accountScopeKey: `smoke-scope-${suffix}`,
      regionId: 'cn-hangzhou',
      sourceScope: 'custom',
      imageId: smokeImageId,
      displayName: 'smoke-image',
      ownerUserId: createdUser.id,
    },
  });
  createdAssetId = createdAsset.id;

  assert.equal(createdAsset.visibility, 'private');
  assert.equal(createdAsset.ownerUserId, createdUser.id);

  const createdInstance = await prisma.rangeInstance.create({
    data: {
      name: `smoke-instance-${suffix}`,
      ownerUserId: createdUser.id,
    },
  });
  createdInstanceId = createdInstance.id;

  assert.equal(createdInstance.ownerUserId, createdUser.id);

  process.stdout.write(
    `database smoke ok: admin=admin template=${createdTemplate.id} asset=${createdAsset.id} instance=${createdInstance.id}\n`,
  );
} finally {
  if (createdInstanceId) {
    await prisma.rangeInstance.deleteMany({
      where: {
        id: createdInstanceId,
      },
    });
  }

  if (createdTemplateId) {
    await prisma.rangeTemplate.deleteMany({
      where: {
        id: createdTemplateId,
      },
    });
  }

  if (createdAssetId) {
    await prisma.platformImageAsset.deleteMany({
      where: {
        id: createdAssetId,
      },
    });
  }

  if (createdUserId) {
    await prisma.platformUser.deleteMany({
      where: {
        id: createdUserId,
      },
    });
  }

  await prisma.$disconnect();
}
