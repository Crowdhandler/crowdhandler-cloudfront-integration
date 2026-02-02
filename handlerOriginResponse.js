"use strict";

const helpers = require("./helpers/misc");
const http_helpers = require("./helpers/http");

require("source-map-support").install();

module.exports.originResponse = async (event) => {
  let APIDomain;
  let crowdhandlerResponseID;
  let crowdhandlerToken;
  let publicKey;
  let requestTime;

  // Infer useful information from the request event and save it
  let request = event.Records[0].cf.request;
  let response = event.Records[0].cf.response;
  const requestHeaders = request.headers;
  const uri = request.uri;

  // Don't try and queue static assets
  let fileExtension = uri.split(".").pop();

  // No need to execute anymore of this script if the request is for a static file.
  const creativeAssetExtensions = helpers.creativeAssetExtensions;
  if (creativeAssetExtensions.indexOf(fileExtension) !== -1) {
    return response;
  }

  // Environment Setup
  (function () {
    // Guard against the crowdhandlerResponseID value coming back null from the API
    try {
      if (requestHeaders["x-ch-responseid"]) {
        crowdhandlerResponseID = requestHeaders["x-ch-responseid"][0].value;
      }
    } catch (error) {
      console.error(error);
    }

    // Handle lack of valid token i.e. partial API responses for unprotected rooms.
    try {
      //Make sure we don't set invalid values
      const validToken = /(.*\d+.*)/;

      if (
        requestHeaders["x-ch-crowdhandler-token"] &&
        validToken.test(requestHeaders["x-ch-crowdhandler-token"][0].value) ===
          true
      ) {
        crowdhandlerToken = requestHeaders["x-ch-crowdhandler-token"][0].value;
      }
    } catch (error) {
      console.error(error);
      return response;
    }

    APIDomain = requestHeaders["x-ch-api-endpoint"]?.[0]?.value;
    publicKey = requestHeaders["x-ch-public-key"]?.[0]?.value;
    requestTime = requestHeaders["x-ch-request-time"]?.[0]?.value;
  })();

  // If we don't have required headers or a valid crowdhandlerToken, return response early.
  if (!crowdhandlerToken || !APIDomain || !publicKey || !requestTime) {
    return response;
  }

  // Requested Domain
  const host = requestHeaders.host[0].value;

  // Cookies now set in viewer-response (fires on cached responses too)

  const totalLoadTime = Date.now() - requestTime;

  async function sendPageLoadTime() {
    let response;
    try {
      response = await http_helpers.httpPUT(
        {
          hostname: APIDomain,
          port: 443,
          path: `/v1/responses/${crowdhandlerResponseID}`,
          method: "PUT",
          headers: {
            "x-api-key": publicKey,
            "Content-Type": "application/json",
          },
        },
        JSON.stringify({
          httpCode: 200,
          sampleRate: 10,
          time: totalLoadTime,
        })
      );
    } catch (error) {
      console.error(error);
    }
  }

  // We don't want to send page performance information on every request so sampling is used.
  const sampleRate = Math.floor(Math.random() * 10);

  if (sampleRate === 9) {
    try {
      await sendPageLoadTime();
    } catch (error) {
      console.error(error);
    }
  }
  return response;
};
