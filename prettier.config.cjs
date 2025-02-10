/** @type {import('prettier').Config} */
module.exports = {
    semi: true,
    singleQuote: false,
    trailingComma: "all",

    // Import sorting
    plugins: [require.resolve("@trivago/prettier-plugin-sort-imports")],
    importOrderSeparation: true,
    importOrderSortSpecifiers: true,
    // https://github.com/IanVS/prettier-plugin-sort-imports/issues/193#issuecomment-2466985674
    importOrderParserPlugins: ["typescript", "jsx", "explicitResourceManagement"],
};
