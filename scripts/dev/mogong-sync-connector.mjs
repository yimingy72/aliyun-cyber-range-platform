import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [target, remoteSocket, identity] = process.argv.slice(2);
if (!process.env.OPENCLI_PROFILE || !target || !remoteSocket?.startsWith('/') || remoteSocket.includes(':')) {
  throw new Error('Usage: OPENCLI_PROFILE=... node scripts/dev/mogong-sync-connector.mjs user@host /path/to/sync.sock [identity-file]');
}

const dir = mkdtempSync(join(tmpdir(), 'mogong-sync-'));
const socket = join(dir, 'bridge.sock');
const snapshot = join(dir, 'catalog.json');
const script = fileURLToPath(new URL('./snapshot-mogong-images.sh', import.meta.url));
const exec = promisify(execFile);
let busy = false;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/snapshot') {
    res.writeHead(404).end();
    return;
  }
  if (busy) {
    res.writeHead(429).end();
    return;
  }
  busy = true;
  try {
    await exec('bash', [script], { timeout: 45_000, env: {
      ...process.env, MOGONG_IMAGE_CATALOG_OUTPUT: snapshot, OPENCLI_BROWSER_COMMAND_TIMEOUT: '40',
    } });
    const catalog = readFileSync(snapshot);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': catalog.length }).end(catalog);
  } catch {
    console.error('墨攻目录读取失败，请检查指定的 OpenCLI profile 和 Chrome 登录状态。');
    res.writeHead(503).end();
  } finally {
    busy = false;
  }
});

let tunnel;
server.on('error', () => { process.exitCode = 1; stop(); });
server.listen(socket, () => {
  chmodSync(socket, 0o600);
  tunnel = spawn('ssh', [
    '-NT', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(identity ? ['-i', identity] : []), '-R', `${remoteSocket}:${socket}`, '--', target,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  tunnel.on('error', () => { process.exitCode = 1; stop(); });
  tunnel.on('exit', (code) => { process.exitCode = code ?? 1; stop(); });
});
function stop() {
  tunnel?.kill();
  server.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
