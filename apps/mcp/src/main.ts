import { createHttpApp } from './http-app';
import { readConfig } from './config';

async function main() {
  const config = readConfig();
  const app = createHttpApp(config);

  await new Promise<void>((resolve) => {
    app.listen(config.port, config.host, resolve);
  });

  process.stdout.write(`mcp listening on http://${config.host}:${config.port}/mcp\n`);
}

void main();
