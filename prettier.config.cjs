/** @type {import('prettier').Config} */
module.exports = {
    semi: true,
    singleQuote: false,
    trailingComma: "all",

    // Import sorting
    plugins: [require.resolve("@trivago/prettier-plugin-sort-imports")],
    importOrderSeparation: true,
    importOrderSortSpecifiers: true,
};
