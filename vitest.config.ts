import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Without an explicit value Vite searches parent directories and picks up an
  // unrelated postcss config from outside the repo.
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share one Postgres replica; parallel files would race.
    fileParallelism: false,
  },
});
