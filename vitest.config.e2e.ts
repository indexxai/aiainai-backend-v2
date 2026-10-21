import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Points at a port nothing listens on, so database checks fail fast and safely.
    env: { MONGODB_URI: 'mongodb://127.0.0.1:1/aiainai-test?serverSelectionTimeoutMS=500' },
  },
});
