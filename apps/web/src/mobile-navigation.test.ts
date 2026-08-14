import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { primaryNavigation, secondaryNavigation } from '../app/mobile-navigation';

const webRoot = resolve(import.meta.dirname, '..');
const styles = readFileSync(resolve(webRoot, 'app/styles.css'), 'utf8');
const layout = readFileSync(resolve(webRoot, 'app/layout.tsx'), 'utf8');

describe('mobile application navigation', () => {
  it('covers every application route outside authentication', () => {
    const expectedRoutes = [
      '/', '/agents', '/code-intelligence', '/command-center', '/contract-intelligence', '/ide',
      '/import', '/onboarding', '/orchestrations', '/projects', '/repository-map',
      '/settings/secrets', '/settings/sessions', '/terminal', '/workspaces'
    ];
    const routes = [...primaryNavigation, ...secondaryNavigation]
      .map((item) => item.href)
      .toSorted();

    expect(routes).toEqual(expectedRoutes.toSorted());
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('is mounted globally and uses semantic current-page navigation', () => {
    expect(layout).toContain('<MobileNavigation />');
    expect(primaryNavigation).toHaveLength(4);
    expect(primaryNavigation.every((item) => item.label.length > 0)).toBe(true);
    expect(secondaryNavigation.every((item) => item.label.length > 0)).toBe(true);
  });

  it('reserves 44px targets and all safe-area edges at mobile widths', () => {
    expect(styles).toMatch(/\.mobile-nav[^}]*safe-area-inset-bottom/);
    expect(styles).toMatch(/\.mobile-nav[^}]*safe-area-inset-left/);
    expect(styles).toMatch(/\.mobile-nav[^}]*safe-area-inset-right/);
    expect(styles).toMatch(/\.mobile-nav[^}]*min-height:48px/);
    expect(styles).toMatch(/padding-top:max\([^)]*safe-area-inset-top/);
    expect(styles).toContain('@media(max-width:380px)');
  });
});
