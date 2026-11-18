"use strict";

const helpers = require("./helpers/misc");
const http_helpers = require("./helpers/http");
const perf = require("./helpers/perf");

require("source-map-support").install();

module.exports.viewerRequest = async (event) => {
  let request = event.Records[0].cf.request;
  // Environment Setup
  const APIDomain = "CROWDHANDLER_API_DOMAIN";
  // If  failtrust is false, users that fail to check-in with CrowdHandler will be sent to waiting room.
  // If true, users that fail to check-in with CrowdHandler will be trusted.
  const failTrust = true;
  const publicKey = "CROWDHANDLER_PUBLIC_KEY";
  // Set slug of fallback waiting room for users that fail to check-in with CrowdHandler.
  let safetyNetSlug;
  // Set whitelabel to true to redirect users to a waiting room on your site domain. See setup guide for more info.
  const whitelabel = true;
  // If CloudFront sits behind another proxy, set this to the lowercase name of the header that carries
  // the visitor's IP address (e.g. "cf-connecting-ip" for Cloudflare, "incap-client-ip" for Imperva).
  // Only set it if visitors cannot reach the distribution directly, as the header is otherwise spoofable.
  let trustedClientIPHeader;

  // Waiting room endpoint. On your site domain when whitelabel is on.
  const waitingRoomEndpoint = (host) =>
    whitelabel === true ? `${host}/ch` : `wait.crowdhandler.com`;
  // Safety net waiting room URL: your custom slug if set, otherwise the generic fallback room.
  // chCode comes from the visitor's query string and the token from their cookie: both are
  // encoded so neither can add parameters of its own. targetURL is already encoded by every caller.
  const safetyNetURL = (host, targetURL, chCode, token) =>
    `https://${waitingRoomEndpoint(host)}/${safetyNetSlug || ""}?url=${targetURL}&ch-code=${encodeURIComponent(chCode || "")}&ch-id=${encodeURIComponent(token || "")}&ch-public-key=${publicKey}`;

  // Captured before ch-code is stripped from the query string so the fail-closed
  // redirect in the catch block can still carry the visitor's priority code.
  let chCodeForFailClosed = "";

  try {
  // Extract request Meta Information
  let requestHeaders = request.headers;

  // Strip any viewer-supplied copies of the internal control headers first,
  // before anything that can throw or return early, so forged values can't
  // reach the response handlers on any path (including the fail-open one).
  delete requestHeaders["x-ch-crowdhandler-token"];
  delete requestHeaders["x-ch-responseid"];
  delete requestHeaders["x-ch-api-endpoint"];
  delete requestHeaders["x-ch-public-key"];
  delete requestHeaders["x-ch-request-time"];

  const host = requestHeaders.host[0].value;

  // Forward api endpoint and public key value as headers so our viewer response function has them at hand to use
  requestHeaders["x-ch-api-endpoint"] = [
    {
      key: "x-ch-api-endpoint",
      value: APIDomain,
    },
  ];

  requestHeaders["x-ch-public-key"] = [
    {
      key: "x-ch-public-key",
      value: publicKey,
    },
  ];

  // Used to determine request/response total time.
  let requestStartTime = Date.now();
  requestHeaders["x-ch-request-time"] = [
    {
      key: "x-ch-request-time",
      value: `${requestStartTime}`,
    },
  ];

  // Requested URI
  const uri = request.uri;
  // User Agent
  const userAgent = requestHeaders["user-agent"]?.[0]?.value || null;

  // Make best effort to determine language
  let language = null;
  try {
    language = requestHeaders["accept-language"][0].value.split(",")[0];
  } catch (error) {
    // Accept-language header not present - not critical
  }

  // Full URL of the protected domain.
  const FQDN = `https://${host}${uri}`;

  // Don't try and queue static assets
  // No need to execute anymore of this script if the request is for a static file.
  if (perf.isStaticAsset(uri)) {
    return request;
  }

  let queryString = helpers.queryStringParse(request.querystring, "object");

  // Destructure special params from query string if they exist.
  let {
    "ch-code": chCode,
    "ch-fresh": chFresh,
    "ch-id": chID,
    "ch-id-signature": chIDSignature,
    "ch-public-key": chPublicKey,
    "ch-requested": chRequested,
  } = queryString || {};

  // This is the right most address found in the x-forwarded-for header and can be trusted as it was discovered via the TCP connection.
  // A configured trustedClientIPHeader takes precedence when the request carries it.
  const IPAddress =
    (trustedClientIPHeader && requestHeaders[trustedClientIPHeader]?.[0]?.value) ||
    request.clientIp ||
    null;

  // Make sure we don't try and use undefined or null in parameters
  if (!chCode || chCode === "undefined" || chCode === "null") {
    chCode = "";
  }
  chCodeForFailClosed = chCode;

  // Remove special params from the queryString object now that we don't need them anymore
  if (queryString) {
    delete queryString["ch-code"];
    delete queryString["ch-fresh"]
    delete queryString["ch-id"];
    delete queryString["ch-id-signature"];
    delete queryString["ch-public-key"];
    delete queryString["ch-requested"];
  }

  // Stringify queryString
  queryString = helpers.queryStringParse(queryString, "string");
  // Update the querystring to remove special CH parameters. When every parameter
  // was one of ours the origin must see no query string at all.
  request.querystring = queryString || "";
  // Prepend ? to the query string if it's not empty as we're always going to need to chain it to ${FQDN}
  if (queryString) {
    queryString = `?${queryString}`;
  }


  //URL encode the targetURL to be used later in redirects
  let targetURL;
  if (queryString) {
    targetURL = encodeURIComponent(FQDN + queryString);
  } else {
    targetURL = encodeURIComponent(FQDN);
  }

  // Parse cookies
  const parsedCookies = helpers.parseCookies(requestHeaders);
  let crowdhandlerCookieValue = parsedCookies["crowdhandler"];

  // Prioritise tokens in the ch-id parameter and fallback to ones found in the cookie.
  let freshlyPromoted;
  let token;
  let tokenSource;
  if (chID) {
    freshlyPromoted = true;
    token = chID;
    tokenSource = 'param';
  } else if (crowdhandlerCookieValue) {
    token = crowdhandlerCookieValue;
    tokenSource = 'cookie';
  } else {
    token = null;
    tokenSource = 'new';
  }

  // Validate token format - must contain at least one digit
  const validToken = /(.*\d+.*)/;
  if (token && !validToken.test(token)) {
    token = null;
    tokenSource = 'new';
  }

  if (freshlyPromoted) {
    let redirectLocation
    if (queryString) {
      redirectLocation = `${FQDN}${queryString}`
    } else {
      redirectLocation = FQDN
    }
    return http_helpers.redirect302Response(redirectLocation, token);
  }

  // Check in with CrowdHandler
  async function checkStatus() {
    let headers = {
      "Content-Type": "application/json",
      "x-api-key": publicKey,
    };
    let response;

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('API Communication Timed Out!'));
      }, http_helpers.API_TIMEOUT_MS);
    });

    try {
      let apiCall;
      if (token) {
        apiCall = http_helpers.httpGET({
          headers: headers,
          hostname: APIDomain,
          method: "GET",
          path: `/v1/requests/${token}?url=${targetURL}&agent=${encodeURIComponent(userAgent)}&ip=${encodeURIComponent(
            IPAddress
          )}&lang=${encodeURIComponent(language)}`,
          port: 443,
        });
      } else {
        apiCall = http_helpers.httpPOST(
          {
            headers: headers,
            hostname: APIDomain,
            method: "POST",
            path: "/v1/requests",
            port: 443,
          },
          JSON.stringify({
            url: FQDN + queryString,
            ip: IPAddress,
            agent: userAgent,
            lang: language,
          })
        );
      }
      response = await Promise.race([apiCall, timeoutPromise]);
    } catch (error) {
      console.error('CrowdHandler API call failed:', error.message || error);
      response = error;
    } finally {
      clearTimeout(timeoutHandle);
      return response;
    }
  }

  let response = await checkStatus();
  let result;
  try {
    result = JSON.parse(response).result;
    if (!result || typeof result !== "object") {
      throw new Error("response has no result");
    }
  } catch (error) {
    console.error("Failed to parse API response:", error);
    // Fallback result triggers failTrust logic
    result = {
      status: 2,
      serverError: true,
      promoted: null,
      token: null,
      slug: null,
      responseID: null,
    };
  }

  let redirect;
  let redirectLocation;
  // Alter queue endpoint based on whitelabel flag value
  const WREndpoint = waitingRoomEndpoint(host);

  // Throttle response (status 6) - treated as a server error, respect failTrust setting
  if (result.status === 6 && failTrust === true) {
    redirect = false;
  } else if (result.status === 6) {
    console.error("[CH] API throttle response (status 6) - redirecting to safety net");
    redirect = true;
    redirectLocation = safetyNetURL(host, targetURL, chCode, result.token);
    // Normal healthy response
  } else if (result.promoted !== 1 && result.status !== 2) {
    redirect = true;
    redirectLocation = `https://${WREndpoint}/${result.slug}?url=${targetURL}&ch-code=${chCode}&ch-id=${result.token}&ch-public-key=${publicKey}`;
    // 4xx client error - always redirect to safety net (ignore failTrust)
  } else if (result.clientError === true) {
    console.error('[CH] API returned 4xx client error - redirecting to safety net');
    redirect = true;
    redirectLocation = safetyNetURL(host, targetURL, chCode, token);
    // 5xx server error, timeout or unreadable response - respect failTrust setting
  } else if (failTrust !== true && result.serverError === true) {
    redirect = true;
    redirectLocation = safetyNetURL(host, targetURL, chCode, token);
    // User is promoted, or the API answered status 2 (allowed through whatever failTrust says)
  } else {
    redirect = false;
  }

  switch (redirect) {
    case true: {
      console.log(`[CH] ${host}${uri} | src:${tokenSource} | action:redirect | token:${result.token || token || 'none'}`);
      return http_helpers.redirect302Response(redirectLocation, result.token);
    }
    case false: {
      console.log(`[CH] ${host}${uri} | src:${tokenSource} | action:allow | token:${result.token || 'none'}`);
      break;
    }
    default: {
      break;
    }
  }
  // This code only executes if a redirect hasn't been triggered.
  // Pass information required by the response handler.
  // A status 2 response that isn't a promotion carries nothing to forward.
  if (result.promoted !== 1 && result.status === 2) {
    return request;
  }
  if (result.token) {
    requestHeaders["x-ch-crowdhandler-token"] = [
      {
        key: "x-ch-crowdhandler-token",
        value: result.token,
      },
    ];
  }
  if (result.responseID) {
    requestHeaders["x-ch-responseid"] = [
      {
        key: "x-ch-responseid",
        value: result.responseID,
      },
    ];
  }

  return request;
  } catch (error) {
    console.error('[CH] Unhandled error in viewerRequest:', error);
    // Fail open unless failTrust is off, in which case go to the safety net.
    if (failTrust === true) {
      return request;
    }
    try {
      const host = request.headers.host[0].value;
      const targetURL = encodeURIComponent(
        `https://${host}${request.uri}${request.querystring ? "?" + request.querystring : ""}`
      );
      const cookieToken = helpers.parseCookies(request.headers)["crowdhandler"] || "";
      return http_helpers.redirect302Response(
        safetyNetURL(host, targetURL, chCodeForFailClosed, cookieToken),
        cookieToken
      );
    } catch (redirectError) {
      // Can't even build the redirect - nothing left but to let the request through.
      console.error('[CH] Could not build safety net redirect - failing open:', redirectError);
      return request;
    }
  }
};
