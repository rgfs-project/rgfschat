import { Brain, Check, Pencil, Trash2, X } from 'lucide-react';
import { ApiError, type MemoryProposalDto } from './api.ts';
import { useResolveProposal } from './queries.ts';

/**
 * Memory changes the model has asked for, offered to the reader.
 *
 * Nothing has been written when one of these is on screen, and the wording
 * everywhere says "wants to" rather than "has" for that reason. The
 * confirmation is not politeness: a memory is prepended to the system prompt of
 * every later conversation, so one the model could save unattended would be a
 * durable instruction it had given itself — and anything it reads, a pasted
 * document or an attached file included, is a way to put words in its mouth.
 * A person clicking is what stands between the two.
 *
 * Shown under the turn that asked, rather than in a corner of the settings
 * panel, because the answer depends on what was being discussed — a note is
 * worth keeping or not according to the conversation it came out of.
 */

const VERB: Record<MemoryProposalDto['operation'], string> = {
  create: 'wants to remember',
  update: 'wants to update',
  delete: 'wants to forget',
};

const ICON: Record<MemoryProposalDto['operation'], typeof Brain> = {
  create: Brain,
  update: Pencil,
  delete: Trash2,
};

export interface MemoryProposalsProps {
  conversationId: string;
  proposals: readonly MemoryProposalDto[];
}

export function MemoryProposals({
  conversationId,
  proposals,
}: MemoryProposalsProps): React.JSX.Element | null {
  const resolve = useResolveProposal();

  if (proposals.length === 0) return null;

  return (
    <ul className="proposals">
      {proposals.map((proposal) => {
        const Icon = ICON[proposal.operation];
        /*
         * Disabled per proposal rather than for the whole list: answering one
         * should not freeze the others, and `variables` is how this mutation
         * says which one is currently in flight.
         */
        const busy = resolve.isPending && resolve.variables?.proposalId === proposal.id;

        const answer = (accept: boolean): void => {
          resolve.mutate({ conversationId, proposalId: proposal.id, accept });
        };

        return (
          <li className="proposal" key={proposal.id}>
            <span className="proposal__icon" aria-hidden="true">
              <Icon size={15} />
            </span>

            <div className="proposal__text">
              <p className="proposal__head">
                {VERB[proposal.operation]} <span className="proposal__name">{proposal.name}</span>
              </p>
              {/* A deletion has no content to show; its name is the whole of it. */}
              {proposal.content !== undefined && (
                <p className="proposal__body">{proposal.content}</p>
              )}
            </div>

            <div className="proposal__actions">
              <button
                type="button"
                className="icon-button"
                title="Reject"
                aria-label={`Reject: ${VERB[proposal.operation]} ${proposal.name}`}
                disabled={busy}
                onClick={() => answer(false)}
              >
                <X size={15} />
              </button>
              <button
                type="button"
                className="icon-button proposal__accept"
                title="Accept"
                aria-label={`Accept: ${VERB[proposal.operation]} ${proposal.name}`}
                disabled={busy}
                onClick={() => answer(true)}
              >
                <Check size={15} />
              </button>
            </div>
          </li>
        );
      })}

      {resolve.isError && (
        <li className="proposal proposal--error" role="alert">
          {/*
           * A conflict already says exactly what happened — the name is taken,
           * or the note changed since the model asked — and the proposal is
           * still above this line to answer again once that is dealt with. The
           * generic lead-in would only bury it, and it reads wrong for a
           * deletion, which was never a save.
           */}
          {resolve.error instanceof ApiError && resolve.error.code === 'CONFLICT'
            ? resolve.error.message
            : `That could not be saved. ${resolve.error.message}`}
        </li>
      )}
    </ul>
  );
}
