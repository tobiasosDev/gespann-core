import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { faviconSvg } from "../web/src/brand.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(resolve(root, "web/public/favicon.svg"), faviconSvg(), "utf8");
