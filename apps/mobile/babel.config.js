// apps/mobile/babel.config.js
// configure mobile Babel transforms

module.exports = function (api)
{
  api.cache(true)
  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
  }
}
