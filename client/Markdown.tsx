import { memo } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeUrl } from './safeUrl.ts';
import { useCopy } from './useCopy.ts';

/**
 * Renders assistant and user text as Markdown (INV-22).
 *
 * Model output is untrusted input. It may contain `<script>`, an `<img
 * onerror=…>`, or a `javascript:` link — either because the model was steered
 * into emitting one, or because it is faithfully quoting a document that
 * contains one. None of it may execute.
 *
 * Two independent defences:
 *
 *  1. **Raw HTML is never parsed.** `rehype-raw` is deliberately *not*
 *     installed, so react-markdown treats `<script>alert(1)</script>` as text
 *     to display, not markup to build. Angle brackets become entities.
 *  2. **URL schemes are filtered.** Even with HTML off, Markdown link syntax
 *     can carry `javascript:` or `data:`, so every href and src is checked and
 *     unsafe ones are dropped.
 *
 * Rendering never alters what is stored: this is a view of the Markdown, and
 * the file on disk keeps whatever the model actually wrote.
 */

/**
 * Flattens the children of a code node to plain text.
 *
 * `String(children)` would render an element array as `[object Object]`;
 * react-markdown hands us a string for a simple fence but an array once the
 * content is split across nodes.
 */
function toText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  return '';
}

function CodeBlock({ text, language }: { text: string; language: string | null }) {
  const { copied, copy } = useCopy();

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{language ?? 'text'}</span>
        <button
          type="button"
          className="icon-button"
          onClick={() => copy(text)}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {/* The <pre> scrolls, not the page. */}
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a({ href, children, ...rest }) {
    const safe = safeUrl(href);
    // A stripped link keeps its text so the reader still sees what was written;
    // it simply is not clickable.
    if (safe === undefined) return <span className="link-blocked">{children}</span>;

    return (
      <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },

  img({ src, alt }) {
    const safe = safeUrl(typeof src === 'string' ? src : undefined);
    if (safe === undefined) return <span className="link-blocked">{alt ?? 'image'}</span>;
    return <img src={safe} alt={alt ?? ''} loading="lazy" />;
  },

  code({ className, children, ...rest }) {
    const text = toText(children).replace(/\n$/, '');
    const fenced = /language-(\w+)/.exec(className ?? '');

    // react-markdown gives inline code and fenced blocks the same component;
    // only a fenced block has a language class or a newline in it.
    if (fenced === null && !text.includes('\n')) {
      return (
        <code className="inline-code" {...rest}>
          {children}
        </code>
      );
    }

    return <CodeBlock text={text} language={fenced?.[1] ?? null} />;
  },

  // A fenced block is wrapped by CodeBlock already; this stops a nested <pre>.
  pre({ children }) {
    return <>{children}</>;
  },

  table({ children }) {
    /*
     * Wide tables scroll inside their own container, never the page.
     *
     * The wrapper is a labelled, focusable region rather than a plain div: a
     * region that scrolls only by dragging its scrollbar is unusable from a
     * keyboard, and `tabIndex` is what lets the arrow keys reach it. The label
     * is what stops that tab stop being an unexplained one.
     */
    return (
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Table">
        <table>{children}</table>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // No rehype-raw: raw HTML in the source is shown as text, never parsed.
        components={components}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
