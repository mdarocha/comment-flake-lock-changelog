import github from "eslint-plugin-github";

export default [
    {
        ignores: ["dist/**", "node_modules/**", "prettier.config.cjs"],
    },
    github.getFlatConfigs().recommended,
    ...github.getFlatConfigs().typescript,
];
