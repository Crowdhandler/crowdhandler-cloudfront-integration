"use strict";

const helpers = require("./helpers/misc");

require("source-map-support").install();

module.exports.viewerResponse = (event, context, callback) => {
  const response = event.Records[0].cf.response;
  try {
  const request = event.Records[0].cf.request;
  const requestHeaders = request.headers;
  const uri = request.uri;

  // Don't set cookies for static assets
  const fileExtension = uri.split(".").pop();
  const creativeAssetExtensions = helpers.creativeAssetExtensions;
  if (creativeAssetExtensions.indexOf(fileExtension) !== -1) {
    return callback(null, response);
  }

  // Read token from header set by viewer-request
  let crowdhandlerToken;
  try {
    const validToken = /(.*\d+.*)/;
    if (
      requestHeaders["x-ch-crowdhandler-token"] &&
      validToken.test(requestHeaders["x-ch-crowdhandler-token"][0].value)
    ) {
      crowdhandlerToken = requestHeaders["x-ch-crowdhandler-token"][0].value;
    }
  } catch (error) {
    console.error("Failed to read token header:", error);
    return callback(null, response);
  }

  // No valid token, nothing to do
  if (!crowdhandlerToken) {
    return callback(null, response);
  }

  // Set cookies
  if (!response.headers["set-cookie"]) {
    response.headers["set-cookie"] = [];
  }

  response.headers["set-cookie"].push({
    key: "Set-Cookie",
    value: `crowdhandler=${crowdhandlerToken}; path=/; Secure;`,
  });

  response.headers["set-cookie"].push({
    key: "Set-Cookie",
    value: `crowdhandler_integration=cloudfront; path=/; Secure;`,
  });

  return callback(null, response);
  } catch (error) {
    console.error('[CH] Unhandled error in viewerResponse - failing open:', error);
    return callback(null, response);
  }
};
