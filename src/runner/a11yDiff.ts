import type { A11yDiff } from '../schema/result.ts';

/** Unchanged lines kept either side of a changed run. */
const CONTEXT = 2;

/** Emitted-line ceiling. Past it the payload is clipped and flagged. */
const MAX_LINES = 40;

/**
 * Per-side line ceiling for the LCS pass, applied AFTER the common prefix and
 * suffix are trimmed. The matrix is O(n×m), so an untrimmed pair of large
 * snapshots would allocate unboundedly; past this the coarse fallback below
 * reports counts without line detail.
 */
const MAX_LCS_LINES = 2000;

/** Marks elided unchanged lines between two changed runs. */
const GAP = '…';

/**
 * Unified line diff of two aria snapshots (`a11y.yaml`) — the payload the HTML
 * report and the Action's sticky PR comment render for an a11y-only `changed`
 * row, where the pixels matched and the committed accessibility tree is the only
 * thing that moved.
 *
 * Deliberately a TEXT diff, not a tree diff: `a11yTreeChanged` (runAction) already
 * owns the semantic verdict, parsing both sides so serialization noise never reads
 * as drift. This renders that verdict against the lines a reviewer actually reads
 * in the committed file. It is only ever called once that verdict is `true`.
 *
 * Returns `undefined` when the two texts are identical (defensive — a drifted tree
 * always drifts its text).
 */
export function buildA11yDiff(
  baseline: string,
  actual: string,
): A11yDiff | undefined {
  if (baseline === actual) return undefined;
  const before = splitLines(baseline);
  const after = splitLines(actual);

  let head = 0;
  while (head < before.length && head < after.length) {
    if (before[head] !== after[head]) break;
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  // Give the trimmed ends CONTEXT lines back, so a change on the first or last
  // line of the snapshot still renders with its neighbours around it.
  head = Math.max(0, head - CONTEXT);
  tail = Math.max(0, tail - CONTEXT);
  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);

  if (midBefore.length > MAX_LCS_LINES || midAfter.length > MAX_LCS_LINES) {
    return {
      lines: [],
      ...countChangedLines(midBefore, midAfter),
      truncated: true,
    };
  }

  const ops = diffLines(midBefore, midAfter);
  const added = ops.filter((op) => op[0] === '+').length;
  const removed = ops.filter((op) => op[0] === '-').length;
  // No line moved: the two texts differ only in trailing whitespace the split
  // normalizes away. Nothing to render.
  if (added === 0 && removed === 0) return undefined;
  const { lines, truncated } = withContext(ops);
  return { lines, added, removed, truncated };
}

/**
 * Lines of a snapshot, with the trailing newline's empty last element dropped so
 * a file that ends in a newline does not diff against one that does not.
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Exact added/removed counts for a pair too large to run the LCS pass over, in
 * O(n+m): how many lines each side holds that the other does not, tallied as
 * multisets so a line that merely moved is not billed as a change.
 *
 * A pure reordering tallies zero on both sides, which would render as "0 added,
 * 0 removed" on a row that did drift. A real unified diff emits a `-` and a `+`
 * for every moved line, so fall back to counting the lines that changed
 * position and report that under both.
 */
function countChangedLines(
  before: string[],
  after: string[],
): { added: number; removed: number } {
  const tally = new Map<string, number>();
  for (const line of before) tally.set(line, (tally.get(line) ?? 0) + 1);
  for (const line of after) tally.set(line, (tally.get(line) ?? 0) - 1);

  let added = 0;
  let removed = 0;
  for (const count of tally.values()) {
    if (count > 0) removed += count;
    else added -= count;
  }
  if (added > 0 || removed > 0) return { added, removed };

  const moved = before.filter((line, index) => line !== after[index]).length;
  return { added: moved, removed: moved };
}

/**
 * Longest-common-subsequence diff, emitting one prefixed entry per line in
 * output order (`' '` kept, `'-'` removed, `'+'` added). Removals of a changed
 * run precede its additions, the conventional unified-diff ordering.
 */
function diffLines(before: string[], after: string[]): string[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = new Int32Array(rows * columns);
  const lcs = (i: number, j: number): number => lengths[i * columns + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i * columns + j] =
        before[i] === after[j]
          ? lcs(i + 1, j + 1) + 1
          : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }

  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push(` ${before[i]}`);
      i += 1;
      j += 1;
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      ops.push(`-${before[i]}`);
      i += 1;
    } else {
      ops.push(`+${after[j]}`);
      j += 1;
    }
  }
  while (i < before.length) {
    ops.push(`-${before[i]}`);
    i += 1;
  }
  while (j < after.length) {
    ops.push(`+${after[j]}`);
    j += 1;
  }
  return ops;
}

/**
 * Clips the run of unchanged lines around each changed hunk to {@link CONTEXT},
 * replacing longer stretches with a single {@link GAP} marker, then caps the
 * whole payload at {@link MAX_LINES}. A snapshot's unchanged bulk is noise in a
 * PR comment; the changed nodes plus their neighbours are the reviewable part.
 */
function withContext(ops: string[]): { lines: string[]; truncated: boolean } {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op[0] === ' ') return;
    for (
      let near = Math.max(0, index - CONTEXT);
      near <= Math.min(ops.length - 1, index + CONTEXT);
      near += 1
    ) {
      keep[near] = true;
    }
  });

  const lines: string[] = [];
  let gapPending = false;
  let truncated = false;
  for (let index = 0; index < ops.length; index += 1) {
    if (!keep[index]) {
      gapPending = true;
      continue;
    }
    if (gapPending) {
      lines.push(GAP);
      gapPending = false;
    }
    lines.push(ops[index] ?? '');
    if (lines.length >= MAX_LINES) {
      truncated = keep.slice(index + 1).includes(true);
      break;
    }
  }
  return { lines, truncated };
}
