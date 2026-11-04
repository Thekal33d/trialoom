import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    channel: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: 'npm run start -- --port 3100',
      url: 'http://127.0.0.1:3100/api/health',
      // The landing page reports what this deployment has configured, so the
      // sponsor wallet is pinned absent. Nothing else in this suite reads it,
      // and without pinning it a developer's own .env decides what the page is
      // asserted to say. Signup and free tests are deliberately NOT pinned:
      // signup.spec.ts skips itself on the same variable, so the server and the
      // runner have to agree about them.
      env: { TRIALOOM_SPONSOR_AGENT_KEY: '' },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'npm run start -- --port 3101',
      url: 'http://127.0.0.1:3101/api/health',
      env: { DATABASE_URL: '' },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
