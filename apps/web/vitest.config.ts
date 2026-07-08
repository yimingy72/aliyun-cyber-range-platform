import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '../.worktrees/**', '**/.worktrees/**']
  }
});
