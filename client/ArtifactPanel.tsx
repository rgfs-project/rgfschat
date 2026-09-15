import { useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import type { ArtifactDto } from '@shared/artifact.ts';

/**
 * One artifact, open beside the conversation it came from.
 *
 * A panel rather than a dialog: it is read *against* the transcript — scrolled
 * through while the reply that produced it is still on screen — so it must not
 * trap focus or cover what it refers to. On a narrow window there is no room
 * for two columns and the stylesheet gives it the whole width, which is the
 * only place it behaves like a sheet.
 *
 * The code is rendered as text and never as markup. This is model output: the
 * `<pre><code>` here is the same treatment the transcript gives it (INV-22),
 * and downloading goes through the server route, which serves it as a plain-text
 * attachment rather than as anything a browser would run.
 */

export interface ArtifactPanelProps {
  artifact: ArtifactDto;
  onClose: () => void;
}

export function ArtifactPanel({ artifact, onClose }: ArtifactPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(artifact.code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const downloadHref = `/api/conversations/${encodeURIComponent(
    artifact.conversationId
  )}/artifacts/${encodeURIComponent(artifact.id)}/download`;

  return (
    <aside className="artifact" aria-label={`Artifact: ${artifact.title}`}>
      <div className="artifact__head">
        <div className="artifact__heading">
          <h2 className="artifact__title">{artifact.title}</h2>
          <p className="artifact__kind muted">{artifact.language ?? 'text'}</p>
        </div>

        <div className="artifact__actions">
          <button
            type="button"
            className="icon-button"
            onClick={copy}
            aria-label={copied ? 'Copied' : 'Copy artifact'}
            title={copied ? 'Copied' : 'Copy'}
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
          </button>

          {/* A real link, so it is a plain same-origin GET the browser saves —
              no blob URL to fall foul of the app's own content policy. */}
          <a
            className="icon-button"
            href={downloadHref}
            download
            aria-label="Download artifact"
            title="Download"
          >
            <Download size={18} />
          </a>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close artifact"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* The <pre> scrolls, not the page — the same rule the transcript's code
          blocks follow, and the reason a wide line cannot push the layout. */}
      <pre className="artifact__code">
        <code>{artifact.code}</code>
      </pre>
    </aside>
  );
}
