import tsParser from "@typescript-eslint/parser";

const EFFECTS = ["useEffect", "useLayoutEffect", "useInsertionEffect"];

const effect = (name) => ({
  selector: `CallExpression[callee.name='${name}'], CallExpression[callee.object.name='React'][callee.property.name='${name}']`,
  message:
    `${name} runs after render and lets a late answer land on a page the user already left. ` +
    "Derive the value during render, act in the event handler, adjust state during render when a prop changes, " +
    "or read outside state through a store in web/src/live.ts (useResource, usePath, useTick).",
});

const timer = (name) => ({
  selector: `CallExpression[callee.name='${name}'], CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name='${name}']`,
  message: `${name} in a component usually patches an ordering problem. Wait for the event or data that matters, or use a store in web/src/live.ts.`,
});

const moduleState = (wrapper) => ({
  selector: `Program > ${wrapper}VariableDeclaration > VariableDeclarator > NewExpression[callee.name=/^(Map|Set)$/][arguments.length=0]`,
  message:
    "A module-level Map or Set is state inside one server process: a deploy or restart loses it. " +
    "Keep the state in the database (src/server/db.ts). A lock or in-flight dedupe that may vanish any time is fine: " +
    "add `// eslint-disable-next-line no-restricted-syntax -- lock: <why loss is harmless>`.",
});

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "react", importNames: EFFECTS, message: "No effects in this repo. See web/src/live.ts for the alternatives." }],
          patterns: [
            { regex: "^(\\.\\./)+(src|test)/", message: "The web app runs in the browser and must not import server or CLI code. Share types through the API." },
            { group: ["node:*", "hono", "hono/*", "@hono/*", "yaml"], message: "Server-only module in the browser bundle." },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...EFFECTS.map(effect)],
    },
  },
  {
    files: ["web/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...EFFECTS.map(effect), timer("setTimeout"), timer("setInterval")],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["react", "react-dom", "react-dom/client"].map((name) => ({ name, message: "React belongs to the web app (web/)." })),
          patterns: [{ regex: "^(\\.\\./)+web/", message: "Server and CLI code must not import the web app." }],
        },
      ],
    },
  },
  {
    files: ["src/server/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", moduleState(""), moduleState("ExportNamedDeclaration > ")],
    },
  },
];
