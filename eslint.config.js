import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: { ...js.configs.recommended.rules, // ignoreRestSiblings allows `const { drop, ...rest } = x` to omit a key.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }] },
  },
];
