import { Check } from "lucide-react";
import type { Viewport } from "../api.ts";
import { cn } from "./ui.tsx";

/** Pixels on the page per CSS pixel of a size: the largest desktop is about 72 px wide. */
const SCALE = 0.0375;

/**
 * The sizes the tester checks every PR at, each drawn to the same scale, so a phone stands small next
 * to a large desktop. A click switches a size on or off.
 */
export function ScreenSizes({ presets, selected, disabled, onChange }: { presets: Viewport[]; selected: string[]; disabled?: boolean; onChange: (next: string[]) => void }) {
  const tallest = Math.max(...presets.map((v) => v.height)) * SCALE;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <div role="group" aria-label="Screen sizes to test" className="flex flex-wrap gap-2">
      {presets.map((v) => {
        const on = selected.includes(v.id);
        return (
          <button
            key={v.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggle(v.id)}
            className={cn(
              "group flex w-[6.5rem] sm:w-28 cursor-pointer flex-col items-center gap-2 rounded-md border px-2 pt-3 pb-2 text-center transition-colors disabled:cursor-default disabled:opacity-60",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info",
              on ? "border-foreground/40 bg-accent" : "border-border hover:border-muted-foreground/50",
            )}
          >
            <span className="flex items-end justify-center" style={{ height: tallest }}>
              <span
                aria-hidden
                className={cn(
                  "relative flex items-center justify-center rounded-[3px] border-[1.5px] transition-colors",
                  on ? "border-foreground bg-foreground/10" : "border-dashed border-muted-foreground/50 group-hover:border-muted-foreground",
                )}
                style={{ width: v.width * SCALE, height: v.height * SCALE }}
              >
                {on && <Check className="size-3 text-foreground" strokeWidth={3} />}
              </span>
            </span>
            <span className="leading-tight">
              <span className={cn("block text-[13px]", on ? "font-medium text-foreground" : "text-muted-foreground")}>{v.name}</span>
              <span className="block font-mono text-[11px] text-muted-foreground tabular-nums">
                {v.width} × {v.height}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
