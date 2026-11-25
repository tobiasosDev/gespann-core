import type { Judged } from "./verdict.ts";

/** Side of the grey thumbnail two screenshots are compared on. */
export const THUMB = 24;

/**
 * Mean difference per pixel (0–255) below which two thumbnails count as the same screen.
 * Measured on a real run: the same page with another radio button selected scores 0–1.5,
 * different pages score 2.4 and up.
 */
export const SAME_SCREEN = 2;

/** Shell snippet that prints `<file> <base64 thumbnail>` per image, with ImageMagick 7 or 6. */
export function thumbCommand(files: string[]): string {
  const size = `${THUMB}x${THUMB}!`;
  return files
    .map((f) => `printf '%s ' '${f}'; (magick '${f}' -resize ${size} -colorspace Gray -depth 8 gray:- 2>/dev/null || convert '${f}' -resize ${size} -colorspace Gray -depth 8 gray:- 2>/dev/null) | base64 -w0; echo`)
    .join("; ");
}

export function parseThumbs(stdout: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const line of stdout.split("\n")) {
    const [name, b64] = line.trim().split(" ");
    if (!name || !b64) continue;
    const buf = Buffer.from(b64, "base64");
    if (buf.length === THUMB * THUMB) out.set(name, buf);
  }
  return out;
}

const distance = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};

/**
 * Maps each screenshot that shows the same screen as an earlier one (by file name order) to that
 * earlier one. Files without a thumbnail are kept as they are.
 */
export function sameScreens(thumbs: Map<string, Buffer>): Map<string, string> {
  const kept: [string, Buffer][] = [];
  const alias = new Map<string, string>();
  for (const name of [...thumbs.keys()].sort()) {
    const t = thumbs.get(name)!;
    const twin = kept.find(([, k]) => distance(k, t) < SAME_SCREEN);
    if (twin) alias.set(name, twin[0]);
    else kept.push([name, t]);
  }
  return alias;
}

/** Points the verdict's proof at the kept screenshots, each listed once. */
export function withAliases(j: Judged, alias: Map<string, string>): Judged {
  if (!j.verdict || !alias.size) return j;
  const map = (files: string[]) => [...new Set(files.map((f) => alias.get(f) ?? f))];
  return {
    ...j,
    verdict: {
      ...j.verdict,
      proof: map(j.verdict.proof),
      checks: j.verdict.checks.map((c) => (c.proof ? { ...c, proof: map(c.proof) } : c)),
    },
  };
}
