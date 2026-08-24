// @ts-check
const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    // Local agent worktrees contain their own generated dist trees and toolchain
    // versions. They are separate repositories, not lint inputs of this checkout.
    ignores: ["dist/**", ".worktrees/**", ".claude/worktrees/**"],
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
