// Shared performance-sample logic for the two response-side handlers.
//
// CloudFront invokes viewer-response for 2xx/3xx only (never for status >= 400,
// never for responses it generates itself such as origin timeouts), and
// origin-response for every origin response including 4xx/5xx but never for
// cache hits. So:
//   - viewer-response samples successes (hits and misses alike)
//   - origin-response samples origin errors (status >= 400)
// Each response is seen by exactly one of the two paths, so nothing is
// double-counted. CloudFront-generated 5xx (origin read timeouts) are not
// visible to any Lambda@Edge trigger and can only be observed via CloudFront
// logs.

const http_helpers = require("./http");
const helpers = require("./misc");

// The lottery denominator AND the label the API multiplies each report by.
// One constant on purpose: the API trusts the label, so the two must never
// drift apart.
export const SAMPLE_ONE_IN = 3;
const SEND_BUDGET_MS = 250;

// Whether the URI is a static file that is never queued (last-dot extension).
export const isStaticAsset = function (uri) {
  const m = (uri || "").match(/\.([^.]+)$/);
  return m !== null && helpers.creativeAssetExtensions.indexOf(m[1]) !== -1;
};

// The token viewer-request forwarded, or undefined if absent/malformed.
export const forwardedToken = function (requestHeaders) {
  const value = requestHeaders?.["x-ch-crowdhandler-token"]?.[0]?.value;
  return helpers.isValidToken(value) ? value : undefined;
};

// The multiplier the API applies to one report.
export const sampleWeight = function (always) {
  return always ? 1 : SAMPLE_ONE_IN;
};

/**
 * Send one performance PUT for this response, if eligible.
 *
 * Sampled one-in-three by default. Pass options.always = true to report every
 * response (used for 5xx: an origin failure is never something to sample
 * away, and the volume is small even in an outage).
 *
 * Returns a Promise that resolves (never rejects) once the send is flushed,
 * timed out or errored, or null when nothing was sent (not sampled, or the
 * request lacks the control headers viewer-request sets on the forwarded
 * path). The bounded send never meaningfully delays the response.
 */
export const maybeSendPerfSample = function (requestHeaders, status, label, options) {
  const always = Boolean(options && options.always);
  const chResponseID = requestHeaders["x-ch-responseid"]?.[0]?.value;
  // Always set by our own viewer-request (viewer-supplied copies are
  // overwritten there before any return), so the send target is ours.
  const APIDomain = requestHeaders["x-ch-api-endpoint"]?.[0]?.value;
  const publicKey = requestHeaders["x-ch-public-key"]?.[0]?.value;
  // Parse defensively so the payload is never NaN.
  const requestTime = Number(requestHeaders["x-ch-request-time"]?.[0]?.value);
  const sampled = always || Math.floor(Math.random() * SAMPLE_ONE_IN) === SAMPLE_ONE_IN - 1;

  if (!(sampled && chResponseID && APIDomain && publicKey && Number.isFinite(requestTime) && requestTime > 0)) {
    return null;
  }

  const totalLoadTime = Date.now() - requestTime;
  return http_helpers
    .httpPUTBounded(
      {
        hostname: APIDomain,
        port: 443,
        path: `/v1/responses/${chResponseID}`,
        method: "PUT",
        headers: {
          "x-api-key": publicKey,
          "Content-Type": "application/json",
        },
      },
      JSON.stringify({
        httpCode: status,
        // Pegged to the lottery: an unsampled report stands for 1 request,
        // a sampled one for SAMPLE_ONE_IN. Never hard-code a number here.
        sampleRate: sampleWeight(always),
        time: totalLoadTime,
      }),
      SEND_BUDGET_MS
    )
    .then(function (outcome) {
      console.log(
        `[CH] perf ${always ? "report" : "sample"} ${outcome} (${totalLoadTime}ms, HTTP ${status}, ${label}, x${sampleWeight(always)})`
      );
    })
    .catch(function () {
      // httpPUTBounded never rejects; insurance so a throw here can't strand
      // the invocation.
    });
};
