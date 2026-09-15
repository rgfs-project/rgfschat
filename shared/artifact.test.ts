import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fromMarkdown } from 'mdast-util-from-markdown';
import {
  ARTIFACT_MIN_CHARS,
  artifactFilename,
  artifactId,
  deriveTitle,
  extractCodeBlocks,
  isArtifact,
  parseArtifactId,
} from './artifact.ts';

describe('extractCodeBlocks', () => {
  it('takes the language from the info string and the content between fences', () => {
    const blocks = extractCodeBlocks('before\n```ts\nconst a = 1;\n```\nafter');
    expect(blocks).toEqual([{ language: 'ts', code: 'const a = 1;', ordinal: 0 }]);
  });

  it('numbers blocks by position within the body', () => {
    const blocks = extractCodeBlocks('```a\n1\n```\ntext\n```b\n2\n```');
    expect(blocks.map((b) => [b.ordinal, b.language])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
  });

  it('has no language for a bare fence', () => {
    expect(extractCodeBlocks('```\nplain\n```')[0]?.language).toBeNull();
  });

  it('lowercases the language and ignores the rest of the info string', () => {
    expect(extractCodeBlocks('```TS  title=x\nq\n```')[0]?.language).toBe('ts');
  });

  it('supports tilde fences', () => {
    expect(extractCodeBlocks('~~~python\nx = 1\n~~~')[0]).toEqual({
      language: 'python',
      code: 'x = 1',
      ordinal: 0,
    });
  });

  it('does not let a shorter inner fence close a longer outer one', () => {
    const blocks = extractCodeBlocks('````md\n```ts\nnested\n```\n````');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('```ts\nnested\n```');
  });

  it('does not let a tilde fence close a backtick fence', () => {
    const blocks = extractCodeBlocks('```\na\n~~~\nb\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('a\n~~~\nb');
  });

  it('strips the opening fence indent from content, and no more', () => {
    // Fence indented by two; the body line indented by four keeps two.
    const blocks = extractCodeBlocks('  ```\n    deep\n  shallow\n  ```');
    expect(blocks[0]?.code).toBe('  deep\nshallow');
  });

  /*
   * The cases a hand-rolled fence scanner gets wrong, and the reason this uses
   * the renderer's own parser instead. Each of these is a block the transcript
   * draws as code, so each must be findable as an artifact.
   */
  it('finds a block nested in a list item', () => {
    const blocks = extractCodeBlocks('- step one\n\n  ```sh\n  npm ci\n  npm test\n  ```\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('npm ci\nnpm test');
  });

  it('finds a block inside a blockquote', () => {
    const blocks = extractCodeBlocks('> quoted:\n>\n> ```js\n> const a = 1;\n> ```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('const a = 1;');
  });

  it('finds an indented code block, which renders as code too', () => {
    const blocks = extractCodeBlocks('text\n\n    indented one\n    indented two\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.language).toBeNull();
    expect(blocks[0]?.code).toBe('indented one\nindented two');
  });

  it('runs an unterminated block to the end of the body rather than dropping it', () => {
    expect(extractCodeBlocks('```sh\nnpm ci\nnpm test')[0]?.code).toBe('npm ci\nnpm test');
  });

  it('ignores a backtick fence whose info string contains a backtick', () => {
    // This is inline code in a sentence, not the start of a block.
    expect(extractCodeBlocks('``` `a` and `b` ```')).toEqual([]);
  });

  it('keeps blank lines inside a block', () => {
    expect(extractCodeBlocks('```\na\n\nb\n```')[0]?.code).toBe('a\n\nb');
  });

  it('returns nothing for prose', () => {
    expect(extractCodeBlocks('just words, and `inline code` too')).toEqual([]);
  });
});

/**
 * Extraction shares the renderer's parser, so agreement with it is structural
 * rather than something to assert — with one exception.
 *
 * `extractCodeBlocks` skips parsing entirely for bodies that cannot contain a
 * code node, because the gallery parses every message of every conversation and
 * most of them are prose. That pre-filter is the one place where this can
 * silently lose an artifact, so it is checked against the parser with nothing
 * skipped, over exactly the kinds of line that make it a near thing.
 */
function blocksWithoutPrefilter(doc: string): number {
  let count = 0;
  const visit = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'code') {
      count += 1;
      return;
    }
    for (const child of node.children ?? []) visit(child as { type: string; children?: unknown[] });
  };
  visit(fromMarkdown(doc));
  return count;
}

describe('the pre-filter never skips a body that has code in it', () => {
  const line = fc.constantFrom(
    '```',
    '```ts',
    '````',
    '~~~',
    '~~~js',
    '  ```',
    '   ```',
    'prose line',
    '',
    'a: 1',
    '# heading',
    '    indented code',
    '\ttab indented',
    '```` ```',
    '- list item',
    '> quoted',
    '  - nested item'
  );

  it('agrees with the unfiltered parser on generated documents', () => {
    fc.assert(
      fc.property(fc.array(line, { maxLength: 14 }), (lines) => {
        const doc = lines.join('\n');
        expect(extractCodeBlocks(doc)).toHaveLength(blocksWithoutPrefilter(doc));
      }),
      { numRuns: 1000 }
    );
  });

  it('agrees on prose that merely mentions code', () => {
    for (const doc of ['see `npm ci` above', 'nothing here', 'a ~ b', 'x  y', '']) {
      expect(extractCodeBlocks(doc)).toHaveLength(blocksWithoutPrefilter(doc));
    }
  });
});

describe('isArtifact', () => {
  const block = (code: string) => ({ language: null, code, ordinal: 0 });

  it('rejects a one-line command', () => {
    expect(isArtifact(block('npm install'))).toBe(false);
  });

  it('rejects an empty or whitespace-only block', () => {
    expect(isArtifact(block(''))).toBe(false);
    expect(isArtifact(block('   \n  \n '))).toBe(false);
  });

  it('accepts three lines', () => {
    expect(isArtifact(block('a\nb\nc'))).toBe(true);
  });

  it('accepts one long line', () => {
    expect(isArtifact(block('x'.repeat(ARTIFACT_MIN_CHARS)))).toBe(true);
    expect(isArtifact(block('x'.repeat(ARTIFACT_MIN_CHARS - 1)))).toBe(false);
  });
});

describe('deriveTitle', () => {
  it('uses a leading hash comment', () => {
    expect(deriveTitle('python', '# Save to SQLite\nimport sqlite3')).toBe('Save to SQLite');
  });

  it('uses a leading slash comment', () => {
    expect(deriveTitle('ts', '// Login page\nexport function Page() {}')).toBe('Login page');
  });

  it('uses SQL and INI comment forms', () => {
    expect(deriveTitle('sql', '-- Monthly totals\nSELECT 1')).toBe('Monthly totals');
    expect(deriveTitle('ini', '; Draft settings\n[main]')).toBe('Draft settings');
  });

  it('uses a block comment, opened and closed or left open', () => {
    expect(deriveTitle('ts', '/* Rate limiter */\nconst x = 1;')).toBe('Rate limiter');
    expect(deriveTitle('ts', '/** Rate limiter\n * detail\n */')).toBe('Rate limiter');
    expect(deriveTitle('html', '<!-- Sign up -->\n<form></form>')).toBe('Sign up');
  });

  it('ignores a shebang, which names an interpreter rather than the snippet', () => {
    expect(deriveTitle('bash', '#!/usr/bin/env bash\nset -e\necho hi')).toBe('bash snippet');
  });

  it('strips banner decoration and a trailing colon', () => {
    expect(deriveTitle('py', '# ---- Setup ----\nx = 1')).toBe('Setup');
    expect(deriveTitle('py', '# Usage:\nx = 1')).toBe('Usage');
  });

  it('falls back to the language when the first line is code', () => {
    // The reference behaviour: a config that opens with a section header gets a
    // plain name, not a meaningless fragment of its own first line.
    expect(deriveTitle('ini', '[Gemi]\nmodel = /models/x.gguf')).toBe('ini snippet');
    expect(deriveTitle('sql', 'CREATE TABLE t (id int)')).toBe('sql snippet');
    expect(deriveTitle(null, 'model "$MODEL" \\')).toBe('code snippet');
  });

  it('rejects a comment too short to be a name', () => {
    expect(deriveTitle('py', '# x\nprint(1)')).toBe('py snippet');
  });

  it('prefers an HTML <title> over the language', () => {
    expect(deriveTitle('html', '<html><head><title>Sign up</title></head></html>')).toBe('Sign up');
  });

  it('truncates a long comment at a word boundary', () => {
    const title = deriveTitle('py', `# ${'word '.repeat(40)}\nx = 1`);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('  ');
  });

  it('never returns a title containing control characters or newlines', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const title = deriveTitle('py', `# ${text}\ncode`);
        // eslint-disable-next-line no-control-regex -- asserting their absence
        expect(title).not.toMatch(/[\u0000-\u001f\u007f]/);
      })
    );
  });
});

describe('artifact ids', () => {
  const uuid = '0b7e6d3c-2f41-4a9e-8d55-1c2b3a4d5e6f';

  it('round-trips', () => {
    expect(parseArtifactId(artifactId(uuid, 3))).toEqual({ messageId: uuid, ordinal: 3 });
  });

  it('rejects hostile or malformed ids rather than guessing', () => {
    for (const bad of [
      '',
      uuid,
      `${uuid}#`,
      `${uuid}#x`,
      `${uuid}#-1`,
      `../../etc/passwd#0`,
      `${uuid}#00000`,
      `${uuid}#0#0`,
      `${uuid.toUpperCase()}#0`,
    ]) {
      expect(parseArtifactId(bad)).toBeNull();
    }
  });
});

describe('artifactFilename', () => {
  it('maps a language to its usual extension', () => {
    expect(artifactFilename('Rate limiter', 'typescript')).toBe('Rate limiter.ts');
    expect(artifactFilename('Config', 'yml')).toBe('Config.yaml');
  });

  it('falls back to .txt for an unknown or absent language', () => {
    expect(artifactFilename('Notes', null)).toBe('Notes.txt');
    expect(artifactFilename('Notes', 'brainfuck')).toBe('Notes.txt');
  });

  it('never produces a path, a traversal, or a hidden file', () => {
    expect(artifactFilename('../../etc/passwd', 'sh')).toBe('etc_passwd.sh');
    expect(artifactFilename('..', 'sh')).toBe('artifact.sh');
    expect(artifactFilename('.bashrc', 'sh')).toBe('bashrc.sh');
    expect(artifactFilename('a/b\\c', 'sh')).toBe('a_b_c.sh');
  });

  it('is always a single safe path segment', () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const name = artifactFilename(title, 'txt');
        expect(name).not.toContain('/');
        expect(name).not.toContain('\\');
        expect(name.startsWith('.')).toBe(false);
        // eslint-disable-next-line no-control-regex -- asserting their absence
        expect(name).not.toMatch(/[\u0000-\u001f\u007f]/);
      })
    );
  });
});
