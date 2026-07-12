import type { AdminRepository } from './admin.repository';

type OwnedRecord = {
  createdBy: string | null;
  ownerUserId: string | null;
};

export async function attachCreatedByUsernames<T extends OwnedRecord>(
  repository: Pick<AdminRepository, 'getPlatformUserById'>,
  records: T[],
): Promise<T[]> {
  const ownerUserIds = [...new Set(records.map((record) => record.ownerUserId).filter((value): value is string => Boolean(value)))];
  const usernames = new Map<string, string>();

  await Promise.all(
    ownerUserIds.map(async (ownerUserId) => {
      const user = await repository.getPlatformUserById(ownerUserId);

      if (user?.username) {
        usernames.set(ownerUserId, user.username);
      }
    }),
  );

  return records.map((record) => {
    const username = record.ownerUserId ? usernames.get(record.ownerUserId) : null;

    return username ? { ...record, createdBy: username } : record;
  });
}
