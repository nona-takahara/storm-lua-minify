// @ts-check
const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    // Temporary copies and agent worktrees can contain generated dist trees and
    // independent toolchains. Lint the source and tests of this checkout.
    ignores: ["dist/**", ".temp/**", ".worktrees/**", ".claude/worktrees/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylistic,
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: __dirname,
      },
    },
  },
  eslintConfigPrettier,
);
