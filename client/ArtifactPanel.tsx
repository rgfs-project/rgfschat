import { useEffect } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import { ARTIFACT_LANGUAGE, type ArtifactDto } from '@shared/artifact';
import { useArtifactSource } from './queries.ts';
import { useCopy } from './useCopy.ts';

/**
 * One artifact, open beside the conversation.
 *
 * A panel rather than a dialog because an artifact is read *against* the
 * transcript that produced it: the question that asked for it and the file
 * that answered belong on screen together, and a dialog would cover the half
 * that gives the other half its meaning.
 *
 * Source, not a rendering. An artifact is usually HTML, and rendering one
 * means running somebody's script; showing what it says needs neither a frame
 * nor a relaxed policy, and it is what a reader wants most of the time anyway
 * — the artifact is a file they are working on.
 */

export interface ArtifactPanelProps {
  artifact: ArtifactDto;
  onClose: () => void;
}

export function ArtifactPanel({ artifact, onClose }: ArtifactPanelProps): React.JSX.Element {
  const source = useArtifactSource(artifact.id);
  const { copied, copy } = useCopy();

  // Escape closes it, as it closes every other layer in the application. The
  // panel does not trap focus: unlike a dialog, what is behind it stays usable.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * Saved through a blob of our own rather than by linking at the source route.
   *
   * The route deliberately serves `text/plain` so that nothing a browser does
   * with an artifact depends on the artifact's own type. A download should
   * still land under the name and extension the reader expects, and building
   * the blob here is what separates those two concerns.
   */
  const download = (): void => {
    const text = source.data;
    if (text === undefined) return;

    const url = URL.createObjectURL(new Blob([text], { type: artifact.mediaType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = artifact.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="artifact-panel" aria-label={`Artifact: ${artifact.name}`}>
      <header className="artifact-panel__head">
        <div className="artifact-panel__title">
          <h2>{artifact.name}</h2>
          <p className="artifact-panel__lang">{ARTIFACT_LANGUAGE[artifact.mediaType]}</p>
        </div>

        <div className="artifact-panel__actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => copy(source.data ?? '')}
            disabled={source.data === undefined}
            aria-label={copied ? 'Copied' : 'Copy source'}
            title={copied ? 'Copied' : 'Copy'}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={download}
            disabled={source.data === undefined}
            aria-label="Download artifact"
            title="Download"
          >
            <Download size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close artifact"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {artifact.description !== undefined && (
        <p className="artifact-panel__description">{artifact.description}</p>
      )}

      <div className="artifact-panel__body">
        {source.isPending && <p className="muted">Loading…</p>}
        {source.isError && (
          <p className="muted">That artifact could not be read. It may have been deleted.</p>
        )}
        {source.data !== undefined && (
          // The block scrolls in both directions; the panel itself does not.
          <pre className="artifact-panel__source">
            <code>{source.data}</code>
          </pre>
        )}
      </div>
    </aside>
  );
}
