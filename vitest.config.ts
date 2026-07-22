import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      thresholds: {
        statements: 80,
        branches: 69,
        functions: 89,
        lines: 82,
      },
    },
    pool: '@cloudflare/vitest-pool-workers',
    poolOptions: {
      workers: {
        isolatedStorage: false,
        main: './src/index.ts',
        wrangler: {
          // wrangler.test.toml mirrors wrangler.toml but with WEBHOOK_SIGNING_SECRET
          // as a plain var (miniflare can't resolve a Secrets Store binding locally).
          configPath: './wrangler.test.toml',
        },
      },
    },
  },
});
