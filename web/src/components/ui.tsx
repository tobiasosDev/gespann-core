import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../cn.ts";

export { cn };

const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-body font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        outline: "border border-border bg-card hover:bg-accent",
        ghost: "hover:bg-accent",
        danger: "border border-border text-bad hover:bg-accent",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-3.5" },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export function Button({ className, variant, size, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...p} />;
}

export function LinkButton({ className, variant, size, ...p }: HTMLAttributes<HTMLAnchorElement> & { href: string; target?: string; rel?: string } & VariantProps<typeof button>) {
  return <a className={cn(button({ variant, size }), className)} {...p} />;
}

export type Tone = "ok" | "bad" | "warn" | "info" | "muted";
const tones: Record<Tone, string> = {
  ok: "text-ok border-ok/30 bg-ok/10",
  bad: "text-bad border-bad/30 bg-bad/10",
  warn: "text-warn border-warn/30 bg-warn/10",
  info: "text-info border-info/30 bg-info/10",
  muted: "text-muted-foreground border-border bg-muted",
};

export function Badge({ tone = "muted", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 font-mono text-label font-medium", tones[tone])}>
      {dot && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />}
      {children}
    </span>
  );
}

export function Card({ className, ...p }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-border bg-card", className)} {...p} />;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    // On phones an action too wide to sit beside the text moves under it instead of squeezing the text into a column.
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <h2 className="text-body font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-body text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const field = "w-full rounded-md border border-input bg-background px-2.5 text-body placeholder:text-muted-foreground/70 focus:border-info/60 focus:outline-none";

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, "h-9", className)} {...p} />;
}

export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, "h-9 cursor-pointer", className)} {...p} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, "min-h-28 py-2 font-mono leading-relaxed", className)} {...p} />;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("font-mono text-small", className)}>{children}</code>;
}

export function Log({ text, className }: { text: string; className?: string }) {
  return <pre className={cn("max-h-80 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-small leading-relaxed whitespace-pre-wrap break-words text-muted-foreground", className)}>{text}</pre>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-body text-muted-foreground">{children}</div>;
}
