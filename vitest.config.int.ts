import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration tests against a real MongoDB replica set (transactions).
 * Needs MONGODB_TEST_URI, e.g. mongodb://localhost:27017/?replicaSet=rs0&directConnection=true
 * CI starts one; locally use `docker compose up -d mongo`.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
