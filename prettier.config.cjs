/** @type {import('prettier').Config} */
module.exports = {
    plugins: [require.resolve("@trivago/prettier-plugin-sort-imports")],
    semi: true,
    singleQuote: false,
    tabWidth: 4,
    trailingComma: "all",
    useTabs: false,
    // Import sorting
    importOrderSeparation: true,
    importOrderSortSpecifiers: true,
};
