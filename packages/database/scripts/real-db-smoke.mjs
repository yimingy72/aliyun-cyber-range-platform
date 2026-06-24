import { PrismaClient } from '../generated/client/index.js';

const prisma = new PrismaClient();
const smokeName = `smoke-${Date.now()}`;

try {
  await prisma.$connect();

  const createdCompetition = await prisma.competition.create({
    data: {
      name: smokeName,
      description: 'real database smoke check',
      status: 'draft',
    },
  });

  const loadedCompetition = await prisma.competition.findUnique({
    where: {
      id: createdCompetition.id,
    },
  });

  if (!loadedCompetition || loadedCompetition.name !== smokeName) {
    throw new Error('failed to read back created competition');
  }

  await prisma.competition.delete({
    where: {
      id: createdCompetition.id,
    },
  });

  process.stdout.write(`database smoke ok: ${createdCompetition.id}\n`);
} finally {
  await prisma.$disconnect();
}
