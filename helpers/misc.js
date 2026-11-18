const queryString = require("query-string");

// Array of known file extensions that should not be considered for queueing.
export const creativeAssetExtensions = [
  "avi",
  "css",
  "csv",
  "eot",
  "gif",
  "ico",
  "jpg",
  "js",
  "json",
  "map",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "ogg",
  "ogv",
  "ott",
  "pdf",
  "png",
  "svg",
  "ttf",
  "webmanifest",
  "wmv",
  "woff",
  "woff2",
  "xml",
];

// What a CrowdHandler token may look like. Tokens are short URL-safe strings
// that always carry a digit (e.g. tok0RBHG4n25KRDl). Anything else is
// discarded and the visitor checks in as new. The character class matters as
// much as the digit: a token goes into the API request path and into a
// Set-Cookie header, so it must not be able to carry anything else.
const TOKEN_SHAPE = /^(?=.*\d)[A-Za-z0-9_-]{4,128}$/;

export const isValidToken = function (value) {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
};

export const parseCookies = function (headers) {
  const parsedCookie = {};
  if (headers.cookie) {
    headers.cookie[0].value.split(";").forEach((cookie) => {
      if (cookie) {
        const parts = cookie.split("=");
        if (parts[1] !== undefined) {
          parsedCookie[parts[0].trim()] = parts[1].trim();
        }
      }
    });
  }
  return parsedCookie;
};

export const queryStringParse = function (querystring, type) {
  if (querystring && type === "object") {
    return queryString.parse(querystring, {sort: false});
  } else if (querystring && type === "string") {
    return queryString.stringify(querystring, {sort: false});
  }
  return "";
};
