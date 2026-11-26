/** A browser size the tester checks the app at, chosen per project on the Setup page. */
export interface Viewport {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** Common device sizes in CSS pixels, smallest first. */
export const VIEWPORTS: readonly Viewport[] = [
  { id: "phone-s", name: "Small phone", width: 375, height: 667 },
  { id: "phone-l", name: "Large phone", width: 430, height: 932 },
  { id: "tablet", name: "Tablet", width: 768, height: 1024 },
  { id: "laptop", name: "Laptop", width: 1280, height: 800 },
  { id: "desktop", name: "Desktop", width: 1440, height: 900 },
  { id: "desktop-l", name: "Large desktop", width: 1920, height: 1080 },
];

/** The project's stored list (`phone-s,desktop`), as known sizes in preset order; unknown ids drop out. */
export function viewportsOf(stored: string | null | undefined): Viewport[] {
  const ids = new Set((stored ?? "").split(",").map((s) => s.trim()));
  return VIEWPORTS.filter((v) => ids.has(v.id));
}

/**
 * The virtual screen a run needs so the browser window fits the largest size: the window adds
 * Chromium's tab strip and toolbar (about 90 px) and sits 10 px from the screen's corner.
 * Undefined without sizes: the sandbox keeps its default screen.
 */
export function screenFor(viewports: Viewport[]): string | undefined {
  if (!viewports.length) return undefined;
  const w = Math.max(1440, ...viewports.map((v) => v.width + 20));
  const h = Math.max(900, ...viewports.map((v) => v.height + 120));
  return `${w}x${h}x24`;
}
