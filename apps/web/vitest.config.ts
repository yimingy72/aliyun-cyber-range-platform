import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      '@': resolve(rootDir),
    },
  },
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '../.worktrees/**', '**/.worktrees/**']
  }
});
