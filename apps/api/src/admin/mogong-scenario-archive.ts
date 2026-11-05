import { readFile } from 'node:fs/promises';
import { NotFoundException } from '@nestjs/common';

export type MogongScenarioArchiveItem = {
  id: number;
  name: string;
  creator: string;
  active: boolean;
  nodeCount: number;
  templateId: string | null;
  reasons: string[];
};

type Archive = {
  workspaceId: string;
  ownerUserId: string;
  capturedAt: string;
  items: Array<{ summary: MogongScenarioArchiveItem; source: unknown }>;
};

// The deployment supplies a private snapshot; it is never included in an image or a public workspace.
export async function readMogongScenarioArchive(user: { id: string; role: string }, workspaceId?: string | null) {
  if (user.role !== 'admin' || !workspaceId) throw new NotFoundException('当前工作空间没有墨攻场景档案。');
  const path = process.env.MOGONG_SCENARIO_ARCHIVE_PATH?.trim() || '/var/lib/cyber-range/mogong/scenario-archive.json';
  let archive: Archive;
  try {
    archive = JSON.parse(await readFile(path, 'utf8')) as Archive;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new NotFoundException('当前工作空间没有墨攻场景档案。');
  }
  if (archive.workspaceId !== workspaceId || archive.ownerUserId !== user.id) {
    throw new NotFoundException('当前工作空间没有墨攻场景档案。');
  }
  return archive;
}
