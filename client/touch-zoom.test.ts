import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rule that stops iOS Safari zooming the page.
 *
 * Safari scales the whole document up when a field smaller than 16px takes
 * focus, and it does not scale back: the reader is left with the sidebar off
 * one edge and a panel that no longer fits, which reads as the application
 * being the wrong size rather than as a zoom. Every text control in this
 * application sets its own size somewhere between 13px and 15px, so without the
 * coarse-pointer override every one of them does it.
 *
 * Asserted against the stylesheet because there is nowhere else to assert it.
 * jsdom has no layout and no media queries, and the failure only appears on a
 * real phone — which is the worst place to discover a regression. What can be
 * checked here is that the rule is still present, still device-scoped, and
 * still strong enough to beat the class selectors it has to override.
 */

const css = readFileSync(fileURLToPath(new URL('./components.css', import.meta.url)), 'utf8');
const theme = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

/** The `@media (pointer: coarse)` block that carries the rule. */
function coarseBlocks(source: string): string[] {
  const blocks: string[] = [];
  const marker = '@media (pointer: coarse) {';

  let from = source.indexOf(marker);
  while (from !== -1) {
    let depth = 0;
    let i = from + marker.length - 1;
    do {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      i += 1;
    } while (depth > 0 && i < source.length);

    blocks.push(source.slice(from, i));
    from = source.indexOf(marker, i);
  }
  return blocks;
}

describe('iOS focus zoom', () => {
  const coarse = coarseBlocks(css).join('\n');

  it('sizes every text control at 16px on a touch device', () => {
    const rule = /input[^{]*,\s*\n?\s*textarea,\s*\n?\s*select\s*\{[^}]*\}/.exec(coarse)?.[0];

    expect(rule, 'the coarse-pointer font-size rule is missing').toBeDefined();
    expect(rule).toMatch(/font-size:\s*1rem/);
  });

  /*
   * Without `!important` the rule loses. Each control sets its own size through
   * a class — `.composer__input`, `.palette__field input`, `.field input` — and
   * a class outranks the bare element selector this rule has to use to stay
   * exhaustive.
   */
  it('overrides the per-component sizes rather than losing to them', () => {
    const rule = /input[^{]*,\s*\n?\s*textarea,\s*\n?\s*select\s*\{[^}]*\}/.exec(coarse)?.[0];
    expect(rule).toMatch(/!important/);
  });

  it('applies only to touch, so the desktop type scale is untouched', () => {
    // The rule lives inside `@media (pointer: coarse)` and nowhere else.
    const everywhere = /input:not\(\[type='range'\]\)[^{]*\{[^}]*font-size[^}]*\}/g;
    const inCoarse = coarse.match(everywhere)?.length ?? 0;
    const inFile = css.match(everywhere)?.length ?? 0;

    expect(inCoarse).toBe(1);
    expect(inFile).toBe(inCoarse);
  });

  /*
   * The other half of the contract: `user-scalable=no` and `maximum-scale` are
   * not how this is solved. Safari has ignored them since iOS 10, and they take
   * pinch-zoom away from readers who need it — so a regression that reaches for
   * them would be both ineffective and harmful.
   */
  it('does not try to forbid zooming in the viewport meta', () => {
    const viewport = /<meta\s+name="viewport"[\s\S]*?>/.exec(html)?.[0] ?? '';

    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no/);
    expect(viewport).not.toMatch(/maximum-scale/);
  });

  it('leaves the controls inheriting their font, so only size is overridden', () => {
    // `font: inherit` on the base controls is what keeps the family and weight
    // consistent; the coarse override deliberately touches size alone.
    expect(theme).toMatch(
      /button,\s*\n\s*input,\s*\n\s*textarea,\s*\n\s*select\s*\{\s*\n\s*font: inherit/
    );
  });
});
