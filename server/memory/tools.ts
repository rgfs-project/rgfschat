import { z } from 'zod';
import type { ToolCall, ToolDefinition } from '@shared/generation.ts';
import { MEMORY_MAX_BYTES } from '../storage/memories.ts';
import { isMemoryName, MEMORY_NAME_MAX_LENGTH } from '../storage/paths.ts';

/**
 * The memory operations a model may ask for.
 *
 * Asking is all it may do. Every call becomes a *proposal* that the reader
 * accepts or rejects, and nothing here writes anything — which is the whole
 * reason the model is allowed near memories at all. Memories are prepended to
 * the system prompt of every later generation, so a model that could write one
 * unattended would be a model that can give itself a durable instruction. Any
 * text it reads — a pasted document, an attached file, a quoted web page — is a
 * route to that, and the confirmation step is what closes it.
 *
 * The descriptions are written for the model rather than for us: they are the
 * only documentation it gets, and a vague one is answered with a vague call.
 */

export const REMEMBER = 'remember';
export const UPDATE_MEMORY = 'update_memory';
export const FORGET_MEMORY = 'forget_memory';

const nameDescription =
  'Short identifying slug: lowercase letters, digits and single hyphens, ' +
  `at most ${MEMORY_NAME_MAX_LENGTH} characters. For example "coffee-order" or "employer".`;

export const MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: REMEMBER,
      description:
        'Propose saving a new long-term note about this user, so it is available in ' +
        'every future conversation. Use it only for durable facts and preferences the ' +
        'user would want recalled later — not for anything specific to the conversation ' +
        'at hand. The user is shown the proposal and must accept it before anything is ' +
        'saved, so say what you are proposing in your reply rather than claiming it is done.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: nameDescription },
          content: {
            type: 'string',
            description:
              'The note itself, as one or two plain sentences written in the third person, ' +
              'for example "Prefers TypeScript over JavaScript for new projects."',
          },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: UPDATE_MEMORY,
      description:
        'Propose replacing the contents of an existing note. The name must be one of the ' +
        'notes already listed in your context; use it when a remembered fact has changed ' +
        'rather than saving a second note that contradicts the first.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name of the existing note to replace.' },
          content: { type: 'string', description: 'The full replacement text for the note.' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: FORGET_MEMORY,
      description:
        'Propose deleting a note that is no longer true or that the user has asked you to ' +
        'forget. The name must be one of the notes already listed in your context.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name of the note to delete.' },
        },
        required: ['name'],
      },
    },
  },
];

/** What the reader will be asked to approve. */
export type ProposedOperation = 'create' | 'update' | 'delete';

export interface ParsedMemoryCall {
  operation: ProposedOperation;
  name: string;
  /** Absent for a deletion, which has nothing to write. */
  content?: string;
}

/*
 * The arguments, believed only after checking.
 *
 * A model emits whatever it likes — the JSON Schema above is a prompt, not a
 * contract — so these are validated with the same suspicion applied to a
 * request body. The name in particular becomes a filename, so it goes through
 * `isMemoryName` exactly as the HTTP route's does (INV-12).
 */
const memoryName = z.string().refine(isMemoryName, {
  message: `A memory name is lowercase letters, digits and hyphens, up to ${MEMORY_NAME_MAX_LENGTH} characters.`,
});

/*
 * Bounded here as well as in the store, and bounded the *same way*.
 *
 * `MemoryStore.write` enforces the real limit when the proposal is accepted,
 * but a proposal is held on disk and shown in the browser before that — so an
 * 8MB "note" should be refused at the door rather than parked in the
 * transcript waiting for someone to click it.
 *
 * The cap is UTF-8 bytes, not characters, because that is what the store
 * measures: a note of emoji or CJK is up to four bytes a character, so a
 * character count would wave through something the store then refuses — and
 * the refusal would land on the reader's click, long after the model made the
 * mistake. Whitespace-only content is refused for the same reason: the store
 * calls it empty, so this must too, rather than accepting a note that can
 * never be applied.
 */
const memoryContent = z
  .string()
  .refine((value) => value.trim() !== '', { message: 'A memory cannot be empty.' })
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MEMORY_MAX_BYTES, {
    message: `A memory is at most ${MEMORY_MAX_BYTES / 1024}KB.`,
  });

const writeArgs = z.strictObject({ name: memoryName, content: memoryContent });
const deleteArgs = z.strictObject({ name: memoryName });

/**
 * Turns one call into something that can be proposed, or explains why not.
 *
 * Returns a reason rather than throwing: a malformed call is the model's
 * mistake and costs that call, never the reply it arrived with. The caller
 * logs the reason and drops the proposal.
 */
export function parseMemoryCall(
  call: ToolCall
): { ok: true; value: ParsedMemoryCall } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(call.arguments);
  } catch {
    return { ok: false, reason: 'arguments were not valid JSON' };
  }

  if (call.name === FORGET_MEMORY) {
    const parsed = deleteArgs.safeParse(json);
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid' };
    return { ok: true, value: { operation: 'delete', name: parsed.data.name } };
  }

  if (call.name === REMEMBER || call.name === UPDATE_MEMORY) {
    const parsed = writeArgs.safeParse(json);
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid' };
    return {
      ok: true,
      value: {
        operation: call.name === REMEMBER ? 'create' : 'update',
        name: parsed.data.name,
        content: parsed.data.content,
      },
    };
  }

  return { ok: false, reason: `unknown tool "${call.name}"` };
}
