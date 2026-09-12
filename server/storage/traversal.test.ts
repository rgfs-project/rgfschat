import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StoragePaths } from './paths.ts';

/**
 * Every path constructor, against every shape of hostile input (INV-12).
 *
 * Driven from the class rather than from a list of methods written out here,
 * so a constructor added later is covered the moment it exists. That is the
 * failure this guards against: not a traversal in code that was reviewed, but
 * one in code added afterwards by someone who did not know to add it here.
 *
 * There are two layers in `StoragePaths`: segment validation, which rejects
 * anything that is not a canonical UUID (or a valid memory name), and a final
 * containment assertion that the resolved path is still inside `DATA_DIR`.
 * **Only the first is observable from here.** Removing the containment check
 * fails nothing, because no input that survives validation can escape — it is
 * defence in depth against a future constructor that forgets to validate,
 * verified by construction rather than by this file. Said plainly because a
 * test that cannot reach a guard should not be read as covering it.
 */

const ROOT = mkdtempSync(join(tmpdir(), 'traversal-'));
const paths = new StoragePaths(ROOT);
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

/**
 * Inputs that must never produce a path, in any position.
 *
 * Percent- and unicode-encoded forms are here because a validator that
 * rejected `..` textually would let them through to a layer that decodes.
 */
const HOSTILE = [
  '..',
  '../..',
  '../../etc/passwd',
  '..\\..\\windows',
  '/etc/passwd',
  'C:\\windows',
  `${VALID_UUID}/../../escape`,
  `${VALID_UUID}${sep}..`,
  '%2e%2e%2f',
  '..%2f..%2f',
  '\u002e\u002e/',
  '\u0000',
  `${VALID_UUID}\u0000.md`,
  '.',
  '',
  ' ',
  '\n',
  'a'.repeat(5_000),
  '11111111-1111-4111-8111-11111111111G',
  '11111111111141118111111111111111',
  '11111111-1111-4111-8111-111111111111 ',
  ' 11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111.md',
  '../11111111-1111-4111-8111-111111111111',
] as const;

/**
 * The constructors, discovered rather than listed.
 *
 * Each is called with the hostile value in each of its argument positions,
 * with a valid UUID filling the rest — so a two-argument constructor is tested
 * for a bad user *and* a bad conversation, not only the first.
 */
function constructors(): { name: string; arity: number; call: (args: string[]) => string }[] {
  const instance = paths as unknown as Record<string, (...args: string[]) => string>;
  const skip = new Set(['constructor', 'root']);

  return Object.getOwnPropertyNames(StoragePaths.prototype)
    .filter((name) => !skip.has(name) && typeof instance[name] === 'function')
    .map((name) => ({
      name,
      arity: instance[name]!.length,
      call: (args: string[]) => instance[name]!.apply(paths, args),
    }));
}

describe('every path constructor', () => {
  it('has been found, so this file is not silently testing nothing', () => {
    const found = constructors().map((c) => c.name);

    expect(found.length).toBeGreaterThan(5);
    // The ones that take request-adjacent input must be among them.
    for (const required of ['conversationFile', 'attachmentDir', 'memoryFile', 'userDir']) {
      expect(found, `${required} is not covered`).toContain(required);
    }
  });

  it('refuses hostile input in every argument position, or stays inside the root', () => {
    const escapes: string[] = [];

    for (const { name, arity, call } of constructors()) {
      const positions = Math.max(1, arity);

      for (let position = 0; position < positions; position += 1) {
        for (const hostile of HOSTILE) {
          const args = Array.from({ length: positions }, (_unused, index) =>
            index === position ? hostile : VALID_UUID
          );

          let resolved: string;
          try {
            resolved = call(args);
          } catch {
            // Refused before any syscall, which is the intended outcome.
            continue;
          }

          /*
           * A constructor that accepted the value must still have produced a
           * path inside the root. Both outcomes are acceptable; escaping is
           * not, and neither is a NUL surviving into a string that will be
           * handed to a syscall.
           */
          if (!resolved.startsWith(ROOT + sep) && resolved !== ROOT) {
            escapes.push(`${name}(${position}) with ${JSON.stringify(hostile)} -> ${resolved}`);
          }
          if (resolved.includes('\u0000')) {
            escapes.push(`${name}(${position}) kept a NUL: ${JSON.stringify(hostile)}`);
          }
        }
      }
    }

    expect(escapes, escapes.join('\n')).toEqual([]);
  });

  it('still builds the paths it is supposed to', () => {
    // The counterpart to the above: a constructor that refused everything
    // would pass every test here and be useless.
    expect(paths.userDir(VALID_UUID)).toBe(join(ROOT, VALID_UUID));
    expect(paths.conversationFile(VALID_UUID, VALID_UUID)).toBe(
      join(ROOT, VALID_UUID, 'chats', `${VALID_UUID}.md`)
    );
    expect(paths.attachmentBlob(VALID_UUID, VALID_UUID)).toBe(
      join(ROOT, VALID_UUID, 'attachments', VALID_UUID, 'blob')
    );
    expect(paths.memoryFile(VALID_UUID, 'a-memory')).toBe(
      join(ROOT, VALID_UUID, 'memories', 'a-memory.md')
    );
  });
});
