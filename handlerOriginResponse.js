"use strict";

const perf = require("./helpers/perf");

require("source-map-support").install();

/**
 * Origin Response Handler
 *
 * Reports performance for ORIGIN ERROR responses (status >= 400): 4xx sampled
 * like successes, 5xx reported on every occurrence. CloudFront never invokes
 * viewer-response for those, so without this they would vanish from the
 * performance data entirely. Successes are sampled at viewer-response (cache
 * hits and misses alike); each response is seen by exactly one of the two.
 *
 * Still invisible to any trigger: errors CloudFront generates itself, e.g.
 * origin read timeouts (504). Those only appear in CloudFront logs.
 */
module.exports.originResponse = async (event, context) => {
  let response = event.Records[0].cf.response;
  // Belt and braces: the sample's background response-drain must never hold
  // the invocation open once the response is returned.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }
  try {
    const request = event.Records[0].cf.request;
    const requestHeaders = request.headers;

    // Static files are never queued, so never reported.
    if (perf.isStaticAsset(request.uri)) {
      return response;
    }

    const status = parseInt(response.status, 10);
    // Successes are sampled at viewer-response; only errors are ours here.
    // Only token-bearing (checked-in) requests, matching viewer-response.
    if (!(status >= 400) || !perf.forwardedToken(requestHeaders)) {
      return response;
    }

    // 4xx sampled like everything else; 5xx reported every time.
    const send = perf.maybeSendPerfSample(requestHeaders, response.status, "origin-response", {
      always: status >= 500,
    });
    if (send) {
      await send;
    }
    return response;
  } catch (error) {
    console.error('[CH] Unhandled error in originResponse - failing open:', error);
    return response;
  }
};
