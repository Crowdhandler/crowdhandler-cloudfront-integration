"use strict";

const perf = require("./helpers/perf");

require("source-map-support").install();

/**
 * Viewer Response Handler
 *
 * Sets the crowdhandler cookie on every response (cached or not), so users
 * get their cookie even when hitting cached pages.
 *
 * Also sends the sampled performance PUT for successful responses, cache hits
 * and misses alike. CloudFront does not invoke this trigger for status >= 400;
 * those are reported at origin-response instead (see helpers/perf.js).
 *
 * Reads the token from the x-ch-crowdhandler-token header set by viewer-request.
 */
module.exports.viewerResponse = (event, context, callback) => {
  const response = event.Records[0].cf.response;
  // Don't let the perf sample's background response-drain hold the invocation
  // open past callback - the viewer's response goes out immediately.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }
  try {
    const request = event.Records[0].cf.request;
    const requestHeaders = request.headers;

    // Don't set cookies for static assets
    if (perf.isStaticAsset(request.uri)) {
      return callback(null, response);
    }

    // Token set by viewer-request; nothing to do without a valid one.
    const crowdhandlerToken = perf.forwardedToken(requestHeaders);
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

    const send = perf.maybeSendPerfSample(requestHeaders, response.status, "viewer-response");
    if (send) {
      send.then(function () {
        callback(null, response);
      });
      return;
    }

    return callback(null, response);
  } catch (error) {
    console.error('[CH] Unhandled error in viewerResponse - failing open:', error);
    return callback(null, response);
  }
};
