// apps/mobile/modules/code456-markdown-text/react-native.config.js
// configure native module linking

module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: 'Code456MarkdownText.podspec',
      },
    },
  },
}
