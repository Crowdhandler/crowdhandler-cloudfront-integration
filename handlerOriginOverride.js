"use strict";

const http_helpers = require("./helpers/http");

require("source-map-support").install();

module.exports.originOverride = async (event) => {
  let request = event.Records[0].cf.request;
  let queryString = request.querystring;
  // Trim /ch/
  let uri = request.uri.substring(4);

  // If we have a URI after trimming it means we have been sent a slug that can be used.
  let fallbackPath = `/?${queryString}`;
  let templateDomain = "wait.crowdhandler.com";
  let statusIdentifier = /^status$/;
  let templatePath;
  if (uri) {
    templatePath = `/${uri}`;
  } else {
    templatePath = fallbackPath;
  }

  // If the URI is a status page, return the status response.
  if (statusIdentifier.test(uri)) {
    return http_helpers.statusResponse();
  }

  // Template fetch with retry mechanic, governed by a total wall-clock budget
  // so a slow template host can't eat the Lambda's time limit. Each attempt
  // gets up to 1600ms (a cache-miss at the template host can take ~1s, so a
  // flat short deadline would false-positive on cold fetches) and never more
  // than the budget's remainder.
  const TOTAL_FETCH_BUDGET_MS = 4000;
  const PER_FETCH_CAP_MS = 1600;
  // Don't launch an attempt with less than this left - a near-zero slice is a
  // guaranteed-failed fetch; go straight to the fallback instead.
  const MIN_FETCH_SLICE_MS = 250;
  const MAX_FETCH_ATTEMPTS = 3;
  const fetchStartedAt = Date.now();
  let fetchCounter = 0;
  async function fetchTemplate() {
    let headers = {
      "Content-Type": "text/html",
    };
    let response;
    fetchCounter++;

    // Last attempt: fall back to the generic template.
    if (fetchCounter === MAX_FETCH_ATTEMPTS) {
      templatePath = fallbackPath;
    }

    // max(1) guards the falsy-0 edge if scheduling delay ate the slice
    // between the loop check and here.
    const remaining = TOTAL_FETCH_BUDGET_MS - (Date.now() - fetchStartedAt);
    try {
      response = await http_helpers.httpGET({
        headers: headers,
        hostname: templateDomain,
        method: "GET",
        path: templatePath,
        port: 443,
        timeout: Math.min(PER_FETCH_CAP_MS, Math.max(remaining, 1)),
      });
      return response;
    } catch (error) {
      // httpGET has already logged the cause; its rejection value is only a placeholder.
      console.error(`[CH] Template fetch attempt ${fetchCounter} failed`);
      response = null;
      return response;
    }
  }

  let templateBody;
  while (
    !templateBody &&
    fetchCounter < MAX_FETCH_ATTEMPTS &&
    TOTAL_FETCH_BUDGET_MS - (Date.now() - fetchStartedAt) >= MIN_FETCH_SLICE_MS
  ) {
    templateBody = await fetchTemplate();
  }

  if (templateBody) {
    let healthyResponse = http_helpers.http200Response(templateBody);
    return healthyResponse;
  } else {
    // Template host unreachable - serve the inline fallback room rather than
    // an error page to a queued visitor. The meta refresh retries shortly, by
    // which point the template host has usually recovered and the visitor
    // gets the proper branded room.
    console.error(
      `[CH] Template fetch failed ${fetchCounter}x from ${templateDomain} - serving inline fallback`
    );
    return http_helpers.fallbackWaitingRoomResponse();
  }
};
