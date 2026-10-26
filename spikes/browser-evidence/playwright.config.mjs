import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  outputDir: process.env.TRIALOOM_RAW_DIR,
  timeout: 20000,
  expect: { timeout: 3000 },
  workers: 1,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: process.env.TRIALOOM_REPORT_PATH }]],
  use: {
    browserName: 'chromium', channel: 'chromium', headless: true,
    viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC',
    serviceWorkers: 'block', acceptDownloads: false,
    trace: { mode: 'on', screenshots: false, snapshots: true, sources: false },
    video: 'off', screenshot: 'off',
  },
});
