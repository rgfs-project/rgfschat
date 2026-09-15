import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';
import { safeUrl } from './safeUrl.ts';

/**
 * INV-22: model output is rendered inert.
 *
 * Everything here is a payload a model can plausibly emit — either steered
 * into it, or while faithfully quoting a document that contains one. The
 * assertions are deliberately about the *DOM that resulted*, not about escaped
 * strings: the only question that matters is whether a live node exists.
 */

/** The element the markdown was rendered into. */
function renderMarkdown(source: string): HTMLElement {
  const { container } = render(<Markdown>{source}</Markdown>);
  return container;
}

describe('Markdown (INV-22)', () => {
  describe('raw HTML is never parsed', () => {
    it('does not build a script element', () => {
      const container = renderMarkdown('Before <script>alert(1)</script> after');
      expect(container.querySelector('script')).toBeNull();
    });

    it('does not build an img with an event handler', () => {
      const container = renderMarkdown('<img src=x onerror="alert(1)">');
      expect(container.querySelector('img')).toBeNull();
    });

    it('does not build an iframe', () => {
      const container = renderMarkdown('<iframe src="https://evil.test"></iframe>');
      expect(container.querySelector('iframe')).toBeNull();
    });

    it('does not carry inline event handlers onto any element', () => {
      const container = renderMarkdown('<div onclick="alert(1)">text</div>');
      for (const element of container.querySelectorAll('*')) {
        expect(element.getAttributeNames().some((name) => name.startsWith('on'))).toBe(false);
      }
    });
  });

  describe('link schemes', () => {
    it('renders an http link as a real link', () => {
      renderMarkdown('[ok](https://example.test/page)');
      const link = screen.getByRole('link', { name: 'ok' });
      expect(link.getAttribute('href')).toBe('https://example.test/page');
    });

    it('opens external links without handing over the opener', () => {
      renderMarkdown('[ok](https://example.test/)');
      const link = screen.getByRole('link', { name: 'ok' });
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('target')).toBe('_blank');
    });

    it('strips a javascript: link but keeps its text', () => {
      const container = renderMarkdown('[click me](javascript:alert(1))');
      expect(container.querySelector('a')).toBeNull();
      expect(screen.getByText('click me')).toBeTruthy();
    });

    it('strips a data: link', () => {
      const container = renderMarkdown(
        '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'
      );
      expect(container.querySelector('a')).toBeNull();
    });

    it('strips a javascript: image source', () => {
      const container = renderMarkdown('![alt](javascript:alert(1))');
      expect(container.querySelector('img')).toBeNull();
    });
  });

  describe('code fences', () => {
    it('shows HTML inside a fence as text, not markup', () => {
      const container = renderMarkdown('```html\n<script>alert(1)</script>\n```');

      expect(container.querySelector('script')).toBeNull();
      const code = container.querySelector('code');
      expect(code?.textContent).toBe('<script>alert(1)</script>');
    });

    it('labels the fence with its language and offers a copy button', () => {
      renderMarkdown('```ts\nconst x = 1;\n```');
      expect(screen.getByText('ts')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    });
  });

  it('renders GFM tables inside their own scroll container', () => {
    const container = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    const wrapper = container.querySelector('.table-scroll');

    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('table')).not.toBeNull();
  });

  /**
   * A comparison table is the shape that goes wrong: several columns, headings
   * of real words, and cells of a sentence each. Squeezed into the message's
   * width it chopped headings mid-word — "Architect / ures" — so the table now
   * sizes to its contents and the wrapper around it scrolls.
   *
   * What can be asserted here is the structure: jsdom lays nothing out, so the
   * widths themselves belong to the browser tests. Structure is worth pinning
   * anyway — it is what makes a table a table to a screen reader, and the
   * temptation when fixing layout is to reach for divs.
   */
  describe('a wide comparison table', () => {
    const TABLE = [
      '| Element | Nvidia | AMD |',
      '| --- | --- | --- |',
      '| Architectures | Ada Lovelace plus Turing | RDNA 3 and RDNA 4 |',
      '| Ray-tracing cores | Dedicated, faster in Ada | Slower per core |',
    ].join('\n');

    it('stays a real table, not a grid of divs', () => {
      const container = renderMarkdown(TABLE);

      expect(container.querySelectorAll('table')).toHaveLength(1);
      expect(container.querySelectorAll('thead th')).toHaveLength(3);
      expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(container.querySelectorAll('tbody tr:first-child td')).toHaveLength(3);
    });

    it('keeps its headings as headings, aligned with their columns', () => {
      renderMarkdown(TABLE);

      const headings = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
      expect(headings).toEqual(['Element', 'Nvidia', 'AMD']);
    });

    it('keeps long labels whole in the markup', () => {
      const container = renderMarkdown(TABLE);

      // Whatever the browser does about wrapping, the text itself is one word:
      // the chopping seen on screen was layout, not content.
      const first = [...container.querySelectorAll('tbody tr td:first-child')].map(
        (cell) => cell.textContent
      );
      expect(first).toEqual(['Architectures', 'Ray-tracing cores']);
    });

    it('puts the scrolling on the wrapper and nothing else', () => {
      const container = renderMarkdown(TABLE);

      const wrapper = container.querySelector('.table-scroll');
      expect(wrapper?.firstElementChild?.tagName).toBe('TABLE');
      // Nothing inside the table scrolls on its own, which would scroll a
      // column away from its heading.
      expect(container.querySelector('table .table-scroll')).toBeNull();
    });

    /* A scrollable region that can only be dragged is unreachable without a
       mouse, and an unlabelled tab stop is a mystery when you land on it. */
    it('is reachable from a keyboard, and says what it is', () => {
      const container = renderMarkdown(TABLE);
      const wrapper = container.querySelector('.table-scroll');

      expect(wrapper?.getAttribute('tabindex')).toBe('0');
      expect(screen.getByRole('region', { name: 'Table' })).toBe(wrapper);
    });

    it('gives every table its own region rather than one for the message', () => {
      const container = renderMarkdown(`${TABLE}\n\nAnd another:\n\n${TABLE}`);

      expect(container.querySelectorAll('.table-scroll')).toHaveLength(2);
      expect(screen.getAllByRole('region', { name: 'Table' })).toHaveLength(2);
    });
  });

  describe('a table of long unbroken values', () => {
    const TABLE = [
      '| Key | Value |',
      '| --- | --- |',
      '| checksum | 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0 |',
      '| endpoint | https://example.test/a/very/long/path/that/keeps/going/and/going |',
    ].join('\n');

    it('keeps the value in one cell rather than spilling out of the table', () => {
      const container = renderMarkdown(TABLE);

      const cells = [...container.querySelectorAll('tbody td')].map((cell) => cell.textContent);
      expect(cells).toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0');
      expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    });

    it('still renders a link in a cell as a link', () => {
      const container = renderMarkdown(
        '| Key | Value |\n| --- | --- |\n| docs | [the docs](https://example.test/docs) |'
      );

      expect(container.querySelector('td a')?.getAttribute('href')).toBe(
        'https://example.test/docs'
      );
    });
  });

  /*
   * A table arrives a row at a time while the reply streams, and each new row
   * re-renders the whole block. What must not change under it is the shape:
   * one wrapper, one table, headings still headings.
   */
  describe('a table growing as it streams', () => {
    const rows = (count: number): string =>
      [
        '| Element | Nvidia | AMD |',
        '| --- | --- | --- |',
        ...Array.from({ length: count }, (_, i) => `| Row ${i + 1} | left | right |`),
      ].join('\n');

    it('keeps one wrapper and one table as rows arrive', () => {
      const { rerender, container } = render(<Markdown>{rows(1)}</Markdown>);

      for (const count of [2, 3, 8]) {
        rerender(<Markdown>{rows(count)}</Markdown>);
        expect(container.querySelectorAll('.table-scroll')).toHaveLength(1);
        expect(container.querySelectorAll('table')).toHaveLength(1);
        expect(container.querySelectorAll('tbody tr')).toHaveLength(count);
      }
    });

    /* Half a table — the header written, the separator not yet — is not a
       table at all, and must not be rendered as a broken one. */
    it('renders an unfinished table as text until it is one', () => {
      const container = renderMarkdown('| Element | Nvidia |');

      expect(container.querySelector('table')).toBeNull();
    });
  });
});

/**
 * The scheme filter, unit tested directly — browsers strip control characters
 * before resolving a URL, so `java\nscript:` is a live `javascript:` URL and a
 * naive `startsWith` check waves it straight through.
 */
describe('safeUrl', () => {
  it.each([
    'https://example.test/',
    'http://example.test/',
    'mailto:someone@example.test',
    'tel:+15555550123',
    '/relative/path',
    '#fragment',
  ])('allows %s', (url) => {
    expect(safeUrl(url)).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('refuses %j', (url) => {
    expect(safeUrl(url)).toBeUndefined();
  });

  it('refuses empty and missing urls', () => {
    expect(safeUrl('')).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});
