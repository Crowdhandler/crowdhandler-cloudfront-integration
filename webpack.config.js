// webpack.config.js
const slsw = require('serverless-webpack');

module.exports = {
  devtool: 'source-map',
  target: 'node',
  entry: slsw.lib.entries,
  mode: slsw.lib.webpack.isLocal ? 'development' : 'production',
  node: false,
  optimization: {
    minimize: false,
  },
};
