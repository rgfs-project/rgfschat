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
