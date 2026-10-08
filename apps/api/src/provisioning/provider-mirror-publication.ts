import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// API and worker share this mirror. Never truncate files that a concurrent init may be reading.
async function publishAtomically(destination: string, write: (temporary: string) => Promise<void>) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await write(temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function copyProviderArchiveAtomically(source: string, destination: string) {
  return publishAtomically(destination, temporary => fs.copyFile(source, temporary));
}

export function writeProviderConfigAtomically(destination: string, contents: string) {
  return publishAtomically(destination, temporary => fs.writeFile(temporary, contents, 'utf8'));
}
