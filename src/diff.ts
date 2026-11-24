/** Line diff (LCS) rendered like `diff -u` without hunk headers. Inputs are small rule files. */
export function lineDiff(before: string, after: string, context = 3): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] as string });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      ops.push({ op: "+", line: b[j] as string });
      j++;
    } else {
      ops.push({ op: "-", line: a[i] as string });
      i++;
    }
  }
  const keep = ops.map((o, k) => o.op !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.op !== " "));
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) {
      out.push(`${o.op} ${o.line}`);
      skipped = false;
    } else if (!skipped) {
      out.push("  …");
      skipped = true;
    }
  });
  return out.join("\n");
}
