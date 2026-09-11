import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './ui',
  outputDir: '../../build/desktop-ui-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'line',
  use: { trace: 'retain-on-failure' },
});
