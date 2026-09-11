import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The pre-paint theme script in `index.html`.
 *
 * The theme has to be on the document before the first frame — React can only
 * set it once it has mounted, which is at least one paint too late, and a
 * dark-mode reader got a full white frame on every reload. That means the
 * storage key exists twice: once in the inline script and once in `App.tsx`.
 *
 * Two copies of a string drift. These tests are what makes the drift fail
 * loudly instead of quietly reintroducing the flash, which nobody would notice
 * until they next reloaded in the dark.
 */

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

describe('theme boot script', () => {
  it('uses the same storage key as the application', () => {
    const fromApp = /const THEME_KEY = '([^']+)'/.exec(app)?.[1];
    expect(fromApp).toBeDefined();
    expect(html).toContain(`localStorage.getItem('${fromApp ?? ''}')`);
  });

  it('runs before the module that mounts React', () => {
    const boot = html.indexOf('localStorage.getItem');
    const mount = html.indexOf('client/main.tsx');

    expect(boot).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(-1);
    // A module script is deferred, but ordering it first would still be wrong
    // to read: the theme must be settled before anything can paint.
    expect(boot).toBeLessThan(mount);
  });

  it('sets colour-scheme as well as the attribute', () => {
    // The attribute needs the stylesheet; `color-scheme` is what tells the
    // browser how to paint the canvas before any CSS has arrived, which is the
    // part that was flashing.
    expect(html).toContain('dataset.theme');
    expect(html).toContain('style.colorScheme');
  });

  it('tolerates storage being unavailable', () => {
    // Private mode and blocked cookies both throw on `localStorage`; a theme
    // preference is not worth a blank page.
    expect(html).toMatch(/try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/);
  });
});
