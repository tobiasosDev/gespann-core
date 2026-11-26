import { Check, ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minus, Scan, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./ui.tsx";

export type ShotResult = "pass" | "fail" | "blocked";

export interface Shot {
  src: string;
  caption: string;
  result?: ShotResult;
}

const RESULT: Record<ShotResult, { icon: ReactNode; label: string; bar: string }> = {
  pass: { icon: <Check className="size-4 shrink-0 text-ok" />, label: "Check passed", bar: "bg-ok" },
  fail: { icon: <X className="size-4 shrink-0 text-bad" />, label: "Check failed", bar: "bg-bad" },
  blocked: { icon: <Minus className="size-4 shrink-0 text-warn" />, label: "Check blocked", bar: "bg-warn" },
};

function ResultIcon({ result }: { result?: ShotResult }) {
  if (!result) return null;
  return (
    <span title={RESULT[result].label} className="mt-px">
      {RESULT[result].icon}
      <span className="sr-only">{RESULT[result].label}: </span>
    </span>
  );
}

/** Screenshots at the width of the page, each one opens the full-screen viewer. */
export function ShotList({ shots, className }: { shots: Shot[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className={cn("grid grid-cols-1 gap-6", className)}>
        {shots.map((s, i) => (
          <figure key={s.src} className="min-w-0">
            <button
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`View full screen: ${s.caption}`}
              className="group relative block w-full cursor-zoom-in overflow-hidden rounded-md border border-border bg-background transition-colors hover:border-info/60"
            >
              <img src={s.src} alt={s.caption} loading="lazy" className="block h-auto w-full" />
              <span className="pointer-events-none absolute right-2 bottom-2 inline-flex size-8 items-center justify-center rounded-md border border-white/15 bg-black/60 text-white backdrop-blur-sm transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">
                <Maximize2 className="size-4" />
              </span>
            </button>
            <figcaption className="mt-2 flex gap-2 text-body leading-snug">
              <ResultIcon result={s.result} />
              <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{s.caption}</span>
            </figcaption>
          </figure>
        ))}
      </div>
      {open !== null && <ShotViewer shots={shots} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Full-screen viewer: fit to screen or actual size, arrow keys and swipe between shots. */
function ShotViewer({ shots, index, onIndex, onClose }: { shots: Shot[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [actual, setActual] = useState(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const shot = shots[index];
  const many = shots.length > 1;
  const go = useCallback(
    (step: number) => {
      if (!many) return;
      setActual(false);
      onIndex((index + step + shots.length) % shots.length);
    },
    [index, many, onIndex, shots.length],
  );

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    d.showModal();
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
      if (d.open) d.close();
    };
  }, []);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [index]);

  if (!shot) return null;
  return (
    <dialog
      ref={ref}
      aria-label={`Screenshot ${index + 1} of ${shots.length}`}
      // StrictMode closes and reopens the dialog once in development; only a real close ends the viewer.
      onClose={(e) => {
        if (!e.currentTarget.open) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        else if (e.key === "ArrowLeft") go(-1);
        else if (e.key === "f" || e.key === "1") setActual((a) => !a);
      }}
      className="shot-viewer fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col bg-black p-0 text-white backdrop:bg-transparent"
    >
      <div className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-4">
        <span className="px-2 font-mono text-small text-white/60 tabular-nums">
          {index + 1} / {shots.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ViewerButton label={actual ? "Fit to screen" : "Actual size"} onClick={() => setActual((a) => !a)} pressed={actual}>
            {actual ? <Scan className="size-4" /> : <span className="font-mono text-small">1:1</span>}
          </ViewerButton>
          <a
            href={shot.src}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the original image in a new tab"
            title="Open original"
            className="inline-flex size-9 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          >
            <ExternalLink className="size-4" />
          </a>
          <ViewerButton label="Close" onClick={() => ref.current?.close()}>
            <X className="size-5" />
          </ViewerButton>
        </div>
      </div>

      <div
        className={cn("relative min-h-0 flex-1", actual ? "overflow-auto" : "overflow-hidden [touch-action:pinch-zoom]")}
        onClick={(e) => {
          if (e.target === e.currentTarget) ref.current?.close();
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse" && !actual) swipe.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) go(dx < 0 ? 1 : -1);
        }}
      >
        <div
          className={cn("flex min-h-full min-w-full", actual ? "w-max items-start justify-start p-4" : "absolute inset-0 items-center justify-center px-2 pb-2 sm:px-16")}
          onClick={(e) => {
            if (e.target === e.currentTarget) ref.current?.close();
          }}
        >
          <img
            key={shot.src}
            src={shot.src}
            alt={shot.caption}
            onClick={() => setActual((a) => !a)}
            className={cn(
              "shot-viewer-img select-none rounded-sm shadow-[0_0_0_1px_rgba(255,255,255,0.08)]",
              actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
            )}
            draggable={false}
          />
        </div>
        {many && (
          <>
            <ViewerButton label="Previous screenshot" onClick={() => go(-1)} className="absolute top-1/2 left-3 hidden -translate-y-1/2 border border-white/10 bg-black/50 sm:inline-flex">
              <ChevronLeft className="size-5" />
            </ViewerButton>
            <ViewerButton label="Next screenshot" onClick={() => go(1)} className="absolute top-1/2 right-3 hidden -translate-y-1/2 border border-white/10 bg-black/50 sm:inline-flex">
              <ChevronRight className="size-5" />
            </ViewerButton>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="mx-auto flex max-w-3xl gap-2 text-body leading-snug text-white/85">
          <ResultIcon result={shot.result} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{shot.caption}</span>
        </p>
        {many && (
          <div ref={strip} className="mx-auto mt-3 flex max-w-3xl gap-2 overflow-x-auto pb-1">
            {shots.map((s, i) => (
              <button
                key={s.src}
                type="button"
                data-i={i}
                onClick={() => {
                  setActual(false);
                  onIndex(i);
                }}
                aria-label={`Screenshot ${i + 1}: ${s.caption}`}
                aria-current={i === index}
                className={cn("relative h-12 w-20 shrink-0 cursor-pointer overflow-hidden rounded-sm border transition-opacity", i === index ? "border-white opacity-100" : "border-white/10 opacity-50 hover:opacity-90")}
              >
                <img src={s.src} alt="" className="size-full object-cover object-top" />
                {s.result && <span className={cn("absolute inset-x-0 bottom-0 h-0.5", RESULT[s.result].bar)} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}

function ViewerButton({ label, onClick, pressed, className, children }: { label: string; onClick: () => void; pressed?: boolean; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={cn("inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white", pressed && "bg-white/15 text-white", className)}
    >
      {children}
    </button>
  );
}
