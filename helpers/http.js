const https = require("https");

const dummyResponseData = {
  result: {
    status: 2,
    token: null,
    title: null,
    position: null,
    live_position: null,
    promoted: null,
    urlRedirect: null,
    onsale: null,
    message: null,
    slug: null,
    priority: null,
    priorityAvailable: null,
    logo: null,
    ttl: null,
  },
};

// GET
// Export HTTP Helper functions.
export const httpGET = function (options) {
  return new Promise(function (resolve, reject) {
    var req = https.request(options, function (res) {
      // reject on bad status
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(JSON.stringify(dummyResponseData));
      }
      // cumulate data
      var body = [];
      res.on("data", function (chunk) {
        body.push(chunk);
      });
      // resolve on end
      res.on("end", function () {
        try {
          body = body.join("");
        } catch (e) {
          reject(JSON.stringify(dummyResponseData));
        }
        resolve(body);
      });
    });
    // reject on request error
    req.on("error", function (err) {
      // This is not a "Second reject", just a different sort of failure
      console.error(err);
      reject(JSON.stringify(dummyResponseData));
    });
    req.end();
  });
};

// POST
export const httpPOST = function (options, data) {
  return new Promise(function (resolve, reject) {
    var req = https.request(options, function (res) {
      // reject on bad status
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(JSON.stringify(dummyResponseData));
      }
      // cumulate data
      var body = [];
      res.on("data", function (chunk) {
        body.push(chunk);
      });
      // resolve on end
      res.on("end", function () {
        try {
          body = body.join("");
        } catch (e) {
          reject(JSON.stringify(dummyResponseData));
        }
        resolve(body);
      });
    });
    // reject on request error
    req.on("error", function (err) {
      // This is not a "Second reject", just a different sort of failure
      console.error(err);
      reject(JSON.stringify(dummyResponseData));
    });

    req.write(data);
    req.end();
  });
};

// PUT
// Resolve on req.end to avoid waiting for a response that isn't needed.
export const httpPUT = function (options, data) {
  return new Promise(function (resolve, reject) {
    let req = https.request(options);
    req.write(data);
    req.end(null, null, () => {
      /* Request has been fully sent */
      resolve(req);
    });
    req.on("error", function (err) {
      console.error(err);
    });
  });
};

// Generic 200 response
export const http200Response = function (content) {
  const response = {
    status: "200",
    statusDescription: "OK",
    headers: {
      "cache-control": [
        {
          key: "Cache-Control",
          value: "max-age=60; public",
        },
      ],
      "content-type": [
        {
          key: "Content-Type",
          value: "text/html",
        },
      ],
      "content-encoding": [
        {
          key: "Content-Encoding",
          value: "UTF-8",
        },
      ],
    },
    body: content,
  };
  return response;
};

// Generic 302 Response
export const redirect302Response = function (redirect_location) {
  const response = {
    status: "302",
    statusDescription: "Found",
    headers: {
      location: [
        {
          key: "Location",
          value: redirect_location,
        },
      ],
    },
  };
  return response;
};

// Generic 404 response
export const error404Response = function () {
  const response = {
    status: "404",
    statusDescription: "Not Found",
    headers: {
      "cache-control": [
        {
          key: "Cache-Control",
          value: "max-age=60; public",
        },
      ],
      "content-type": [
        {
          key: "Content-Type",
          value: "text/html",
        },
      ],
      "content-encoding": [
        {
          key: "Content-Encoding",
          value: "UTF-8",
        },
      ],
    },
    body: "<div class=container> <div class=row> <div class=col-md-12> <div class=error-template> <h2> 404 Not Found</h2> <div class=error-details> Sorry, this page does not exist! </div> </div> </div> </div> </div>",
  };
  return response;
};
