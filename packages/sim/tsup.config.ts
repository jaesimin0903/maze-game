import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/worker.ts', 'src/playstats-worker.ts', 'src/attack/worker.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
  noExternal: [/.*/],
});
