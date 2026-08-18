import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildA11yDiff } from './a11yDiff.ts';

const lines = (...entries: string[]): string => entries.join('\n') + '\n';

describe('buildA11yDiff', () => {
  it('returns undefined for identical snapshots', () => {
    const snapshot = lines('- navigation:', '  - link "Home"');
    assert.equal(buildA11yDiff(snapshot, snapshot), undefined);
  });

  it('marks a renamed node as a removal followed by an addition', () => {
    const diff = buildA11yDiff(
      lines('- navigation:', '  - link "Home"', '  - button "Menu"'),
      lines('- navigation:', '  - link "Home page"', '  - button "Menu"'),
    );
    assert.deepEqual(diff, {
      lines: [
        ' - navigation:',
        '-  - link "Home"',
        '+  - link "Home page"',
        '   - button "Menu"',
      ],
      added: 1,
      removed: 1,
      truncated: false,
    });
  });

  it('counts an added node with no removal', () => {
    const diff = buildA11yDiff(
      lines('- main:', '  - heading "Title"'),
      lines('- main:', '  - heading "Title"', '  - status "3 items"'),
    );
    assert.equal(diff?.added, 1);
    assert.equal(diff?.removed, 0);
    assert.ok(diff?.lines.includes('+  - status "3 items"'));
  });

  it('keeps two lines of context around a change and elides the rest', () => {
    const before = lines(
      ...Array.from({ length: 20 }, (_, index) => `  - link "${index}"`),
    );
    const after = before.replace('link "10"', 'link "ten"');
    const diff = buildA11yDiff(before, after);
    assert.deepEqual(diff?.lines, [
      '   - link "8"',
      '   - link "9"',
      '-  - link "10"',
      '+  - link "ten"',
      '   - link "11"',
      '   - link "12"',
    ]);
  });

  it('keeps context around a change on the first line', () => {
    const diff = buildA11yDiff(
      lines('- banner:', '  - link "Home"', '  - button "Menu"'),
      lines('- navigation:', '  - link "Home"', '  - button "Menu"'),
    );
    assert.deepEqual(diff?.lines, [
      '-- banner:',
      '+- navigation:',
      '   - link "Home"',
      '   - button "Menu"',
    ]);
  });

  it('separates distant changes with an elision marker', () => {
    const before = lines(
      ...Array.from({ length: 30 }, (_, index) => `  - link "${index}"`),
    );
    const after = before
      .replace('link "2"', 'link "two"')
      .replace('link "25"', 'link "twenty-five"');
    const diff = buildA11yDiff(before, after);
    assert.equal(diff?.lines.filter((line) => line === '…').length, 1);
    assert.ok(diff?.lines.includes('+  - link "two"'));
    assert.ok(diff?.lines.includes('+  - link "twenty-five"'));
  });

  it('clips a large diff and reports the full counts', () => {
    const before = lines(
      ...Array.from({ length: 60 }, (_, index) => `  - link "${index}"`),
    );
    const after = lines(
      ...Array.from({ length: 60 }, (_, index) => `  - button "${index}"`),
    );
    const diff = buildA11yDiff(before, after);
    assert.equal(diff?.truncated, true);
    assert.equal(diff?.lines.length, 40);
    assert.equal(diff?.added, 60);
    assert.equal(diff?.removed, 60);
  });

  it('reports counts without line detail when the change is too large to diff', () => {
    const before = lines(
      ...Array.from({ length: 2100 }, (_, index) => `  - link "${index}"`),
    );
    const after = lines(
      ...Array.from({ length: 2100 }, (_, index) => `  - button "${index}"`),
    );
    assert.deepEqual(buildA11yDiff(before, after), {
      lines: [],
      added: 2100,
      removed: 2100,
      truncated: true,
    });
  });

  it('counts only the lines that moved when the change is too large to diff', () => {
    // Divergence at both ends, so the prefix/suffix trim cannot shrink the
    // region below the LCS ceiling. Two lines changed, not 2100.
    const rows = Array.from(
      { length: 2100 },
      (_, index) => `  - link "${index}"`,
    );
    const before = lines(...rows);
    const after = lines(
      '  - link "first"',
      ...rows.slice(1, -1),
      '  - link "last"',
    );
    assert.deepEqual(buildA11yDiff(before, after), {
      lines: [],
      added: 2,
      removed: 2,
      truncated: true,
    });
  });

  it('counts a reordering too large to diff as a move on each side', () => {
    const rows = Array.from(
      { length: 2100 },
      (_, index) => `  - link "${index}"`,
    );
    const swapped = [...rows];
    swapped[0] = rows[2099] as string;
    swapped[2099] = rows[0] as string;
    const diff = buildA11yDiff(lines(...rows), lines(...swapped));
    assert.deepEqual(diff, {
      lines: [],
      added: 2,
      removed: 2,
      truncated: true,
    });
  });

  it('ignores a trailing-newline-only difference', () => {
    const snapshot = lines('- navigation:', '  - link "Home"');
    assert.equal(buildA11yDiff(snapshot, snapshot.trimEnd()), undefined);
  });
});
