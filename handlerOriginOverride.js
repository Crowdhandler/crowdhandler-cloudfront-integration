"use strict";

const helpers = require("./helpers/misc");
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

  // Template fetch with retry mechanic.
  let fetchCounter = 0;
  async function fetchTemplate(retry) {
    let headers = {
      "Content-Type": "text/html",
    };
    let response;
    fetchCounter++;

    if (fetchCounter === 3) {
      templatePath = fallbackPath;
    }

    try {
      response = await http_helpers.httpGET({
        headers: headers,
        hostname: templateDomain,
        method: "GET",
        path: templatePath,
        port: 443,
      });
      return response;
    } catch (error) {
      console.log(error);
      response = null;
      return response;
    }
  }

  let templateBody;
  while (!templateBody && fetchCounter < 4) {
    templateBody = await fetchTemplate();
  }

  if (templateBody) {
    let healthyResponse = http_helpers.http200Response(templateBody);
    return healthyResponse;
    // Handle failure to retrieve template
  } else {
    let errorResponse = http_helpers.error404Response();
    throw errorResponse;
  }
};
