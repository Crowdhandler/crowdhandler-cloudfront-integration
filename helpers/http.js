const https = require("https");

export const API_TIMEOUT_MS = 2000;

// Server error response (5xx, network errors) - respects failTrust setting
const dummyResponseData = {
  result: {
    status: 2,
    serverError: true,
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

// Client error response (4xx, excluding 429) - never triggers failTrust, always safety net
export const clientErrorResponseData = {
  result: {
    status: 2,
    clientError: true,
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
// options.timeout (ms, optional): hard wall-clock deadline for the whole
// request. The request is destroyed on expiry, so a slow upstream (a hung
// connect or a slowly dribbling response) can't eat the Lambda's time budget.
export const httpGET = function (options) {
  return new Promise(function (resolve, reject) {
    var req = https.request(options, function (res) {
      // reject on bad status
      // 429 throttle is treated as a server error so failTrust is respected
      if (res.statusCode === 429) {
        console.error(`[CH] API 429: throttled`);
        reject(JSON.stringify(dummyResponseData));
      } else if (res.statusCode >= 400 && res.statusCode < 500) {
        console.error(`[CH] API 4xx: ${res.statusCode}`);
        reject(JSON.stringify(clientErrorResponseData));
      } else if (res.statusCode < 200 || res.statusCode >= 300) {
        console.error(`[CH] API 5xx: ${res.statusCode}`);
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
    let deadline;
    if (options.timeout) {
      // Destroy triggers the 'error' handler below, which rejects.
      deadline = setTimeout(function () {
        req.destroy(new Error(`timeout after ${options.timeout}ms`));
      }, options.timeout);
    }
    // A response cut off part-way closes the request with neither a response
    // 'end' nor a request 'error'. Reject so the caller isn't left pending;
    // a no-op when the promise has already settled.
    req.on("close", function () {
      clearTimeout(deadline);
      reject(JSON.stringify(dummyResponseData));
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
      // 429 throttle is treated as a server error so failTrust is respected
      if (res.statusCode === 429) {
        console.error(`[CH] API 429: throttled`);
        reject(JSON.stringify(dummyResponseData));
      } else if (res.statusCode >= 400 && res.statusCode < 500) {
        console.error(`[CH] API 4xx: ${res.statusCode}`);
        reject(JSON.stringify(clientErrorResponseData));
      } else if (res.statusCode < 200 || res.statusCode >= 300) {
        console.error(`[CH] API 5xx: ${res.statusCode}`);
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
// Best-effort PUT with a hard wall-clock bound, for telemetry sends that must
// never meaningfully delay a response. Resolves (never rejects) with
// 'flushed' | 'timeout' | 'error'.
//
// Resolves when the request has been fully written to the socket - NOT when
// the API responds. The response is drained in the background purely so the
// keep-alive socket can be reused; the agent amortises the TLS handshake
// across invocations in a warm execution environment.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
export const httpPUTBounded = function (options, data, timeoutMs) {
  return new Promise(function (resolve) {
    let deadline;
    let settled = false;
    const done = function (outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };
    try {
      const req = https.request(
        Object.assign({}, options, { agent: keepAliveAgent }),
        function (res) {
          // Background drain so the keep-alive socket frees up.
          res.resume();
        }
      );
      deadline = setTimeout(function () {
        req.destroy(new Error(`httpPUTBounded timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      // Backstop for the background drain, which the deadline above no longer
      // covers once the flush has settled the promise: destroy sockets stuck
      // on a hung API response so the agent discards them.
      req.setTimeout(5000, function () {
        req.destroy(new Error("httpPUTBounded drain inactivity"));
      });
      // 'finish' = request body fully flushed to the socket.
      req.on("finish", function () {
        done("flushed");
      });
      req.on("error", function (err) {
        console.error("[CH] httpPUTBounded:", err.message || err);
        done(err.message && err.message.includes("timeout") ? "timeout" : "error");
      });
      req.write(data);
      req.end();
    } catch (err) {
      console.error("[CH] httpPUTBounded setup:", err);
      done("error");
    }
  });
};

export const statusResponse = function () {
  const response = {
    status: "200",
    statusDescription: "OK",
    headers: {
      "cache-control": [
        {
          key: "Cache-Control",
          value: "max-age=300, public",
        },
      ],
      "content-type": [
        {
          key: "Content-Type",
          value: "application/json",
        },
      ],
      "access-control-allow-origin": [
        {
          key: "Access-Control-Allow-Origin",
          value: "*",
        },
      ],
    },
    body: JSON.stringify({
      integration: "cloudfront",
      status: "ok",
    }),
  };
  return response;
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
          value: "max-age=60, public",
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
export const redirect302Response = function (redirect_location, token) {
  let response;

  if (token) {
    response = {
      status: "302",
      statusDescription: "Found",
      headers: {
        location: [
          {
            key: "Location",
            value: redirect_location,
          },
        ],
        "set-cookie": [
          {
            key: "Set-Cookie",
            value: `crowdhandler=${token}; path=/; Secure`,
          },
        ],
        "cache-control": [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
        expires: [
          {
            key: "Expires",
            value: "Fri, 01 Jan 1970 00:00:00 GMT",
          },
        ],
        pragma: [
          {
            key: "Pragma",
            value: "no-cache",
          },
        ],
      },
    };
  } else {
    response = {
      status: "302",
      statusDescription: "Found",
      headers: {
        location: [
          {
            key: "Location",
            value: redirect_location,
          },
        ],
        "cache-control": [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
        expires: [
          {
            key: "Expires",
            value: "Fri, 01 Jan 1970 00:00:00 GMT",
          },
        ],
        pragma: [
          {
            key: "Pragma",
            value: "no-cache",
          },
        ],
      },
    };
  }
  return response;
};

// Minimal self-contained waiting room, served only when the template host is
// unreachable. No external assets - nothing else that can fail. Never cached,
// or it would keep serving after the template host recovers.
export const fallbackWaitingRoomResponse = function () {
  const response = {
    status: "200",
    statusDescription: "OK",
    headers: {
      "cache-control": [
        {
          key: "Cache-Control",
          value: "no-cache, no-store, must-revalidate",
        },
      ],
      expires: [
        {
          key: "Expires",
          value: "Fri, 01 Jan 1970 00:00:00 GMT",
        },
      ],
      pragma: [
        {
          key: "Pragma",
          value: "no-cache",
        },
      ],
      "content-type": [
        {
          key: "Content-Type",
          value: "text/html",
        },
      ],
    },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="7">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Waiting Room</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f5f6f8;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}
  .card{background:#fff;border-radius:12px;padding:48px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:420px}
  h1{font-size:1.4rem;margin:0 0 12px}
  p{margin:0;color:#555;line-height:1.5}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2c6e9c;margin:0 3px;animation:p 1.2s infinite ease-in-out}
  .dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
  @keyframes p{0%,80%,100%{opacity:.25}40%{opacity:1}}
</style>
</head>
<body>
<div class="card">
  <h1>You're in line</h1>
  <p>Please keep this page open.<br>It will refresh automatically.</p>
  <p style="margin-top:24px"><span class="dot"></span><span class="dot"></span><span class="dot"></span></p>
</div>
</body>
</html>`,
  };
  return response;
};

