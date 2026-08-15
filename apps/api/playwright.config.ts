import { defineConfig } from '@playwright/test';

// Real-browser coverage for the Runtime Gateway's Origin/Sec-Fetch/cookie behavior — vitest's
// app.inject() and a raw `ws` client both require every header to be set explicitly, which can
// (and did) hide bugs where the *absence* of a header a real browser wouldn't send is what matters.
// Deliberately separate from vitest.config.ts: these use Chromium, not Node's http, and the two
// runners shouldn't be mixed. Lives outside apps/api/src so vitest's own include glob never picks
// these files up.
export default defineConfig({
  testDir: './e2e-browser',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure'
  }
});
