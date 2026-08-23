/**
 * Minimal unified-diff generation for proposed repository repairs.
 *
 * A promotion must be reviewable as an ordinary file diff (R6.3), so the
 * output here is the standard unified format a reviewer already knows how to
 * read - not a bespoke change description.
 */

interface Op {
  readonly kind: "equal" | "insert" | "delete";
  readonly line: string;
}

function diffLines(before: readonly string[], after: readonly string[]): Op[] {
  // Classic Myers-style LCS table. Diffs here are small manifest files, so the
  // O(n*m) table is the right trade for exactness and no dependency.
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal", line: before[i] as string });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1] as number[])[j]! >= (lcs[i] as number[])[j + 1]!) {
      ops.push({ kind: "delete", line: before[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "insert", line: after[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "delete", line: before[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "insert", line: after[j] as string });
    j += 1;
  }
  return ops;
}

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const ops = diffLines(beforeLines, afterLines);

  const hunks: string[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let index = 0;

  while (index < ops.length) {
    if ((ops[index] as Op).kind === "equal") {
      beforeLine += 1;
      afterLine += 1;
      index += 1;
      continue;
    }

    const changeStart = index;
    let changeEnd = index;
    let equalRun = 0;
    while (changeEnd < ops.length) {
      const op = ops[changeEnd] as Op;
      if (op.kind === "equal") {
        equalRun += 1;
        if (equalRun > context * 2) break;
      } else {
        equalRun = 0;
      }
      changeEnd += 1;
    }

    const start = Math.max(0, changeStart - context);
    const end = Math.min(ops.length, changeEnd);

    let hunkBeforeStart = beforeLine;
    let hunkAfterStart = afterLine;
    for (let k = changeStart - 1; k >= start; k -= 1) {
      hunkBeforeStart -= 1;
      hunkAfterStart -= 1;
    }

    const body: string[] = [];
    let beforeCount = 0;
    let afterCount = 0;
    for (let k = start; k < end; k += 1) {
      const op = ops[k] as Op;
      if (op.kind === "equal") {
        body.push(` ${op.line}`);
        beforeCount += 1;
        afterCount += 1;
      } else if (op.kind === "delete") {
        body.push(`-${op.line}`);
        beforeCount += 1;
      } else {
        body.push(`+${op.line}`);
        afterCount += 1;
      }
    }
    hunks.push(
      `@@ -${hunkBeforeStart},${beforeCount} +${hunkAfterStart},${afterCount} @@\n${body.join("\n")}`,
    );

    for (let k = index; k < end; k += 1) {
      const op = ops[k] as Op;
      if (op.kind !== "insert") beforeLine += 1;
      if (op.kind !== "delete") afterLine += 1;
    }
    index = end;
  }

  return `--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`;
}
