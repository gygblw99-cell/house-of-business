import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // The UI is written in Hebrew, where an ASCII double quote around a
      // quoted UI label ("הרץ ביקורת") is ordinary punctuation, not a stray
      // delimiter. The rule exists to catch unescaped apostrophes in English
      // prose; here it produced 77 hits, all correct code, which buried the
      // handful of real errors. Escaping them would make the Hebrew source
      // unreadable for no rendered difference.
      "react/no-unescaped-entities": "off",

      // Warn, don't error. Every occurrence in this codebase is one of two
      // legitimate shapes the rule can't distinguish from a cascading render:
      // (a) fetch-on-mount/param-change writing the result into state, and
      // (b) orchestrating a timed transition (page fade, sync badge flash).
      // Kept visible so genuinely cascading renders still get flagged in
      // review, but not failing the lint run.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
