import { createContext, useContext } from 'react';

/**
 * How a code block in the transcript asks to be opened in the panel.
 *
 * Context rather than a prop because the block is rendered by react-markdown,
 * several layers below whoever knows about artifacts, and the only way to reach
 * it with a prop would be to thread one through the Markdown component's whole
 * component map.
 *
 * The callback takes the block's text, not an id: react-markdown hands its
 * `code` component the content and nothing about where it sat, so the message
 * that provided the callback is the thing that resolves text back to an
 * address. Two identical blocks in one message therefore resolve to the first
 * of them — which opens a panel showing exactly the same code, because the code
 * is what an artifact *is*.
 *
 * `null` means artifacts are unavailable here — a preview, a test rendering
 * Markdown on its own — and the block simply renders without the affordance.
 */
export type OpenArtifact = ((code: string) => void) | null;

export const ArtifactOpenContext = createContext<OpenArtifact>(null);

export function useOpenArtifact(): OpenArtifact {
  return useContext(ArtifactOpenContext);
}
