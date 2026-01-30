"use strict";

const helpers = require("./helpers/misc");
const http_helpers = require("./helpers/http");

require("source-map-support").install();

module.exports.viewerRequest = async (event) => {
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

  // Extract request Meta Information
  let request = event.Records[0].cf.request;
  let requestHeaders = request.headers;
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
  let fileExtension = uri.split(".").pop();

  // No need to execute anymore of this script if the request is for a static file.
  const creativeAssetExtensions = helpers.creativeAssetExtensions;
  if (creativeAssetExtensions.indexOf(fileExtension) !== -1) {
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
  const IPAddress = request.clientIp || null;

  // Make sure we don't try and use undefined or null in parameters
  if (!chCode || chCode === "undefined" || chCode === "null") {
    chCode = "";
  }

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
  // Prepend & to the query string if it's not empty as we're always going to need to chain it to ?${FQDN}
  if (queryString) {
    //Update the querystring to remove special CH parameters
    request.querystring = queryString;
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

    if (token) {
      try {
        response = await http_helpers.httpGET({
          headers: headers,
          hostname: APIDomain,
          method: "GET",
          path: `/v1/requests/${token}?url=${targetURL}&agent=${encodeURIComponent(userAgent)}&ip=${encodeURIComponent(
            IPAddress
          )}&lang=${encodeURIComponent(language)}`,
          port: 443,
        });
      } catch (error) {
        console.error('CrowdHandler API GET failed:', error);
        response = error;
      } finally {
        return response;
      }
    } else {
      try {
        response = await http_helpers.httpPOST(
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
      } catch (error) {
        console.error('CrowdHandler API POST failed:', error);
        response = error;
      } finally {
        return response;
      }
    }
  }

  let response = await checkStatus();
  let result;
  try {
    result = JSON.parse(response).result;
  } catch (error) {
    console.error("Failed to parse API response:", error);
    // Fallback result triggers failTrust logic
    result = {
      status: 2,
      promoted: null,
      token: null,
      slug: null,
      responseID: null,
    };
  }

  let redirect;
  let redirectLocation;
  let WREndpoint;

  // Alter queue endpoint based on whitelabel flag value
  switch (whitelabel) {
    case true:
      WREndpoint = `${host}/ch`;
      break;
    case false: {
      WREndpoint = `wait.crowdhandler.com`;
      break;
    }
    default:
      WREndpoint = `wait.crowdhandler.com`;
      break;
  }

  // Normal healthy response
  if (result.promoted !== 1 && result.status !== 2) {
    redirect = true;
    redirectLocation = `https://${WREndpoint}/${result.slug}?url=${targetURL}&ch-code=${chCode}&ch-id=${result.token}&ch-public-key=${publicKey}`;
    // Abnormal response. Redirect to safety net waiting room until further notice
  } else if (
    failTrust !== true &&
    result.promoted !== 1 &&
    result.status === 2
  ) {
    redirect = true;
    if (safetyNetSlug) {
      // Your custom slug
      redirectLocation = `https://${WREndpoint}/${safetyNetSlug}?url=${targetURL}&ch-code=${chCode}&ch-id=${token}&ch-public-key=${publicKey}`;
    } else {
      // Generic fallback room
      redirectLocation = `https://${WREndpoint}/?url=${targetURL}&ch-code=${chCode}&ch-id=${token}&ch-public-key=${publicKey}`;
    }
    // User is promoted
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
  if (result.token) {
    requestHeaders["x-ch-crowdhandler-token"] = [
      {
        key: "x-ch-crowdhandler-token",
        value: result.token,
      },
    ];
  }
  if (result.responseID) {
    requestHeaders["x-ch-responseID"] = [
      {
        key: "x-ch-responseID",
        value: result.responseID,
      },
    ];
  }

  return request;
};
