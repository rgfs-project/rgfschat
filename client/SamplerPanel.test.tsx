import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SamplerPanel } from './SamplerPanel.tsx';

/**
 * The system prompt's placeholder help.
 *
 * Worth a test because it is the only place the feature is discoverable: an
 * administrator who does not know `{{CURRENT_DATETIME}}` exists will never type
 * it, and the substitution is then dead code that nobody can reach.
 */
function setup() {
  render(
    <SamplerPanel
      providerId="local"
      modelId="GPT"
      stored={undefined}
      defaults={undefined}
      onSaved={vi.fn()}
      onError={vi.fn()}
    />
  );
}

describe('SamplerPanel system prompt help', () => {
  it.each(['{{CURRENT_WEEKDAY}}', '{{CURRENT_DATETIME}}', '{{CURRENT_TIMEZONE}}', '{{USER_NAME}}'])(
    'names %s',
    (token) => {
      setup();

      expect(screen.getByText(token)).toBeTruthy();
    }
  );

  it("says the clock is the reader's own, not the server's", () => {
    setup();

    expect(screen.getByText(/reader's own clock at send time/i)).toBeTruthy();
  });

  /* The rule that stops an administrator's own prose being eaten. */
  it('says unknown braces are left alone', () => {
    setup();

    expect(screen.getByText(/left as written/i)).toBeTruthy();
  });
});
