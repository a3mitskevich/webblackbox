import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "docs/api/**",
      "apps/extension/e2e-demo/vendor/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-console": "off"
    }
  },
  {
    files: ["apps/extension/src/**/*.{ts,tsx}"],
    rules: {
      // God-module guard for the extension sources (the service-worker split, task 37).
      "max-lines": ["error", { max: 800, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    files: ["apps/**/e2e-demo/**/*.{js,mjs,cjs}", "apps/**/public/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  }
);
