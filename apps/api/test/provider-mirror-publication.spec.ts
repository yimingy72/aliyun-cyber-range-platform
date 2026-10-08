import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { copyProviderArchiveAtomically, writeProviderConfigAtomically } from '../src/provisioning/provider-mirror-publication';

const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');
describe('provider mirror publication across concurrent jobs', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-publication-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('readers see complete old or new archives while multiple jobs publish replacements', async () => {
    const first = Buffer.alloc(8 * 1024 * 1024, 0x61), second = Buffer.alloc(first.length, 0x62);
    const sourceA = path.join(root, 'a.zip'), sourceB = path.join(root, 'b.zip'), destination = path.join(root, 'mirror/provider.zip');
    await fs.writeFile(sourceA, first); await fs.writeFile(sourceB, second);
    await copyProviderArchiveAtomically(sourceA, destination);
    const allowed = new Set([checksum(first), checksum(second)]);
    let running = true, reads = 0;
    const reader = (async () => {
      while (running) { expect(allowed.has(checksum(await fs.readFile(destination)))).toBe(true); reads++; }
    })();
    try {
      await Promise.all([sourceA, sourceB].map(async source => {
        for (let i = 0; i < 12; i++) await copyProviderArchiveAtomically(source, destination);
      }));
    } finally { running = false; await reader; }
    expect(reads).toBeGreaterThan(0);
    expect(await fs.readdir(path.dirname(destination))).toEqual(['provider.zip']);
  });

  it('publishes complete CLI config and keeps an existing archive if a copy fails', async () => {
    const destination = path.join(root, 'provider.zip'), config = path.join(root, 'tofu.tfrc');
    await fs.writeFile(destination, 'previous verified archive');
    await expect(copyProviderArchiveAtomically(path.join(root, 'missing.zip'), destination)).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous verified archive');
    await Promise.all(Array.from({ length: 12 }, () => writeProviderConfigAtomically(config, 'provider_installation {\n}\n')));
    expect(await fs.readFile(config, 'utf8')).toBe('provider_installation {\n}\n');
    expect((await fs.readdir(root)).sort()).toEqual(['provider.zip', 'tofu.tfrc']);
  });
});
