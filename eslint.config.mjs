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
    // Wrangler writes its dev and deploy bundles here. They are generated,
    // gitignored, and megabytes of someone else's transpiled output — linting
    // them buries this project's own findings under hundreds of warnings.
    ".wrangler/**",
    "worker/node_modules/**",
  ]),
]);

export default eslintConfig;
