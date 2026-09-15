import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SAMPLER_LIMITS, type SamplerSettings } from '@shared/generation';
import { SYSTEM_PROMPT_MAX_LENGTH } from '@shared/generation';
import { updateAdminSampler, type StoredSampler } from './api.ts';

/**
 * Per-model sampling, set by an administrator for everyone.
 *
 * Three things shape the design.
 *
 * **A default and an override have to look different.** Every control shows a
 * number whether or not anyone chose it, so without a distinction the panel
 * reads as six settings you own — when most of them are usually llama-server's.
 * A modified field is stated at full contrast and carries its own undo; one
 * still on its default is dimmed and says so.
 *
 * **A slider alone cannot hit 0.7 rather than 0.75.** The readout is an input,
 * so the value can be typed when it matters and dragged when it does not.
 *
 * **Undo is per field.** Resetting everything to clear one mistake is a bad
 * trade when the other five were deliberate.
 */

type Field = 'temperature' | 'topP' | 'topK' | 'minP' | 'repeatPenalty';

/**
 * Readable labels, with the wire name in the tooltip.
 *
 * An operator reading this panel is deciding what a model should do; an
 * operator reading llama-server's flags needs `top_p`. The label answers the
 * first and the title attribute answers the second.
 */
const FIELDS: { key: Field; label: string; hint: string }[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    hint: 'temperature — randomness. Lower is more predictable.',
  },
  {
    key: 'topP',
    label: 'Top P',
    hint: 'top_p — keeps the smallest set of tokens above this share of the probability mass.',
  },
  { key: 'topK', label: 'Top K', hint: 'top_k — considers only this many candidates.' },
  {
    key: 'minP',
    label: 'Min P',
    hint: 'min_p — drops tokens scoring below this share of the best one.',
  },
  {
    key: 'repeatPenalty',
    label: 'Repeat penalty',
    hint: 'repeat_penalty — above 1 discourages repetition.',
  },
];

export interface SamplerPanelProps {
  providerId: string;
  modelId: string;
  /** What the administrator has configured, if anything. */
  stored: StoredSampler | undefined;
  /** What the provider itself was launched with, where it reports it. */
  defaults: SamplerSettings | undefined;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

type Patch = Partial<Record<Field, number | null>> & { systemPrompt?: string | null };

export function SamplerPanel({
  providerId,
  modelId,
  stored,
  defaults,
  onSaved,
  onError,
}: SamplerPanelProps): React.JSX.Element {
  const [prompt, setPrompt] = useState(stored?.systemPrompt ?? '');
  /** What is in the number boxes while they are being typed into. */
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});

  // A different model is a different panel; nothing half-typed carries over.
  useEffect(() => {
    setPrompt(stored?.systemPrompt ?? '');
    setDrafts({});
  }, [stored?.systemPrompt, providerId, modelId]);

  const save = (patch: Patch): void => {
    updateAdminSampler({ providerId, modelId, ...patch })
      .then(onSaved)
      .catch(onError);
  };

  const overrides = FIELDS.filter((field) => stored?.[field.key] !== undefined).length;
  const hasPrompt = (stored?.systemPrompt ?? '') !== '';
  const customised = overrides + (hasPrompt ? 1 : 0);

  return (
    <div className="sampler">
      <header className="sampler__head">
        <div>
          <h3 className="sampler__title">{modelId}</h3>
          <p className="sampler__note">
            Applies to everyone using this model and is enforced by the server.
          </p>
        </div>

        <button
          type="button"
          className="linkish"
          // Nothing to undo is a reason to be unavailable, not to do nothing.
          disabled={customised === 0}
          onClick={() =>
            save({
              temperature: null,
              topP: null,
              topK: null,
              minP: null,
              repeatPenalty: null,
              systemPrompt: null,
            })
          }
        >
          {customised === 0
            ? 'Nothing overridden'
            : `Reset ${customised} ${customised === 1 ? 'override' : 'overrides'}`}
        </button>
      </header>

      <div className="sampler__grid">
        {FIELDS.map(({ key, label, hint }) => {
          const limits = SAMPLER_LIMITS[key];
          const override = stored?.[key];
          const inherited = defaults?.[key];
          const shown = override ?? inherited ?? limits.min;
          const isOverride = override !== undefined;

          const commit = (raw: string): void => {
            const value = Number(raw);
            if (!Number.isFinite(value)) return;
            const clamped = Math.min(limits.max, Math.max(limits.min, value));
            save({ [key]: clamped });
          };

          return (
            <div className={`sampler__field${isOverride ? ' is-override' : ''}`} key={key}>
              <div className="sampler__row">
                <label className="sampler__label" htmlFor={`sampler-${key}`} title={hint}>
                  {label}
                </label>

                <span className="sampler__controls">
                  {/*
                    Undo leads, so the number can sit flush against the right
                    edge and line up with the end of the slider beneath it.
                    Trailing the number, it pushed the value out of that column.
                  */}
                  {isOverride ? (
                    <button
                      type="button"
                      className="icon-button sampler__undo"
                      title={`Reset ${label}`}
                      aria-label={`Reset ${label}`}
                      onClick={() => save({ [key]: null })}
                    >
                      <RotateCcw size={13} />
                    </button>
                  ) : (
                    // Holds the column so every number starts at the same place.
                    <span className="sampler__undo-slot" aria-hidden="true" />
                  )}

                  <input
                    className="sampler__number"
                    type="number"
                    min={limits.min}
                    max={limits.max}
                    step={limits.step}
                    value={drafts[key] ?? String(shown)}
                    aria-label={`${label} value`}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [key]: event.target.value }))
                    }
                    onBlur={(event) => {
                      setDrafts((current) => ({ ...current, [key]: undefined }));
                      if (event.target.value !== String(shown)) commit(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                </span>
              </div>

              <input
                id={`sampler-${key}`}
                type="range"
                min={limits.min}
                max={limits.max}
                step={limits.step}
                value={shown}
                aria-label={label}
                onChange={(event) => save({ [key]: Number(event.target.value) })}
              />

              <p className="sampler__origin">{isOverride ? 'Modified' : 'Default'}</p>
            </div>
          );
        })}
      </div>

      {/* The question everyone asks next, answered before they ask it. */}
      <p className="sampler__note">
        Reply length is llama-server&apos;s to decide, from its own n-predict and context size.
        There is nothing to set for it here.
      </p>

      <label className="sampler__prompt">
        <span className="sampler__row">
          <span className="sampler__label">System prompt</span>
          {/* A count only once there is something to count; an empty box does
              not need a word to say it is empty. */}
          {prompt.length > 0 && (
            <span className="sampler__origin">
              {prompt.length} / {SYSTEM_PROMPT_MAX_LENGTH}
            </span>
          )}
        </span>
        <textarea
          value={prompt}
          rows={5}
          maxLength={SYSTEM_PROMPT_MAX_LENGTH}
          placeholder="Leads every conversation with this model. Leave empty for the model's own."
          onChange={(event) => setPrompt(event.target.value)}
          onBlur={() => {
            if (prompt === (stored?.systemPrompt ?? '')) return;
            save({ systemPrompt: prompt === '' ? null : prompt });
          }}
        />
      </label>

      {/* Under the field rather than in the placeholder: the placeholder is
          gone the moment anything is typed, which is exactly when someone
          wants to know what they can write. */}
      <p className="sampler__origin sampler__variables">
        <code>{'{{CURRENT_WEEKDAY}}'}</code>, <code>{'{{CURRENT_DATETIME}}'}</code> and{' '}
        <code>{'{{CURRENT_TIMEZONE}}'}</code> are filled with the reader&apos;s own clock at send
        time; <code>{'{{USER_NAME}}'}</code> with the signed-in name. Anything else in double braces
        is left as written.
      </p>
    </div>
  );
}
