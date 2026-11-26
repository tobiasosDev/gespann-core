import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The type scale's sizes (index.css); without them twMerge takes text-body for a colour and drops it next to text-muted-foreground.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["title", "body", "small", "label"] } } });

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
