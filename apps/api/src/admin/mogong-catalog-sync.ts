import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { mogongCatalogPath, parseMogongImageCatalog, readMogongImageCatalog } from './mogong-image-catalog';

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 55_000;

function fetchFromConnector(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path: '/snapshot', signal: AbortSignal.timeout(TIMEOUT_MS) }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error('Mogong connector failed'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new Error('Mogong snapshot too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });
}

async function refreshCatalog() {
  const path = mogongCatalogPath();
  let payload: string;
  try {
    payload = await fetchFromConnector(join(dirname(path), 'sync.sock'));
  } catch {
    throw new ServiceUnavailableException('未能连接墨攻。请确认同步电脑在线，且 Chrome 已登录墨攻，再重试。');
  }

  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const next = parseMogongImageCatalog(payload);
    const capturedAt = Date.parse(next.capturedAt);
    const previous = await readMogongImageCatalog().catch(() => null);
    if (next.version !== 2 || !next.items.length || next.items.some((item) => !item.active) ||
        Math.abs(Date.now() - capturedAt) > TIMEOUT_MS ||
        previous && Date.parse(previous.capturedAt) >= capturedAt) throw new Error('Invalid or stale Mogong snapshot');
    const total = next.items.length;
    await writeFile(temporary, JSON.stringify({ ...next, total }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return { total, capturedAt: next.capturedAt };
  } catch {
    throw new ServiceUnavailableException('同步未完成，已保留上次的墨攻镜像目录。');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

let pending: ReturnType<typeof refreshCatalog> | undefined;

export function syncMogongImageCatalog() {
  pending ??= refreshCatalog().finally(() => { pending = undefined; });
  return pending;
}
