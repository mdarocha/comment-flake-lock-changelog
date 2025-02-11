import github from "eslint-plugin-github";

export default [
    {
        ignores: ["dist/**", "node_modules/**", "prettier.config.cjs"],
    },
    github.getFlatConfigs().recommended,
    ...github.getFlatConfigs().typescript,
    {
        rules: {
            "no-restricted-imports": ["error", { patterns: [".*"] }],
            "import/no-unresolved": "off",
            "import/extensions": ["error", "never", { graphql: "always" }],
            "i18n-text/no-en": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "all",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    ignoreRestSiblings: true,
                },
            ],
            // Disallow Bun to maintain node compatibility
            "no-restricted-globals": [
                "error",
                {
                    name: "Bun",
                    message: "Use node modules instead",
                },
                {
                    name: "console",
                    message: "Use @actions/core instead",
                },
            ],
        },
    },
];
