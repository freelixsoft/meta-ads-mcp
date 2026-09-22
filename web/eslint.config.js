import tseslint from "typescript-eslint";

/**
 * Frontend-only config. The root config lints src/ for the server; without
 * this the whole web/ tree would ship unlinted through a CI that looks green.
 */
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
  },
  {
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
