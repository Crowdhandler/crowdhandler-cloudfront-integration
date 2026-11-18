"use strict";
// End-to-end tests of the four edge handlers against a stubbed https module.
// The handlers are bundled with webpack first (as they are for deployment).
// Run: npm test (sets the OpenSSL legacy provider this webpack version needs
// on Node 17+, as generateLaunch.js does).
const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const webpack = require("webpack");

const ROOT = path.join(__dirname, "..");
const HANDLERS = ["handlerViewerRequest", "handlerViewerResponse", "handlerOriginResponse", "handlerOriginOverride"];

// Bundle the handlers, optionally rewriting the viewer-request source first
// (the same way a customer edits the configuration constants).
function build(name, rewrite) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), `ch-edge-${name}-`));
  fs.mkdirSync(path.join(src, "helpers"));
  for (const file of [...HANDLERS.map((h) => `${h}.js`), ...fs.readdirSync(path.join(ROOT, "helpers")).map((f) => `helpers/${f}`)]) {
    let code = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (rewrite && file === "handlerViewerRequest.js") {
      code = rewrite(code);
    }
    fs.writeFileSync(path.join(src, file), code);
  }
  const entry = {};
  HANDLERS.forEach((h) => (entry[h] = path.join(src, `${h}.js`)));
  return new Promise((resolve, reject) => {
    webpack(
      {
        mode: "development",
        devtool: false,
        target: "node",
        node: false,
        entry,
        resolve: { modules: [path.join(ROOT, "node_modules")] },
        output: { path: path.join(src, "out"), filename: "[name].js", libraryTarget: "commonjs2" },
      },
      (err, stats) => {
        if (err || stats.hasErrors()) {
          return reject(err || new Error(stats.toString("errors-only")));
        }
        const out = {};
        HANDLERS.forEach((h) => Object.assign(out, require(path.join(src, "out", `${h}.js`))));
        resolve(out);
      }
    );
  });
}

function replaceOnce(code, from, to) {
  assert(code.includes(from), `config line not found: ${from}`);
  return code.replace(from, to);
}

// ---- https stub -----------------------------------------------------------
// respond(call) returns { status, body } | { hang: true } | { error: true }.
let respond;
let calls = [];
https.request = function (options, onResponse) {
  const req = new EventEmitter();
  const call = { options, body: "" };
  calls.push(call);
  let destroyed = false;
  req.write = (data) => (call.body += data);
  req.setTimeout = () => req;
  req.destroy = (err) => {
    if (destroyed) return;
    destroyed = true;
    setImmediate(() => {
      if (err) req.emit("error", err);
      req.emit("close");
    });
  };
  req.end = () => {
    const outcome = respond(call);
    if (outcome.hang) return;
    setImmediate(() => {
      if (destroyed) return;
      if (outcome.error) {
        req.emit("error", new Error("socket hang up"));
        return req.emit("close");
      }
      req.emit("finish");
      if (onResponse) {
        const res = new EventEmitter();
        res.statusCode = outcome.status;
        res.resume = () => {};
        onResponse(res);
        if (outcome.body !== undefined) res.emit("data", outcome.body);
        res.emit("end");
      }
      req.emit("close");
    });
  };
  return req;
};
const api = (result, status = 200) => () => ({ status, body: JSON.stringify({ result }) });

// ---- event helpers --------------------------------------------------------
const h = (value) => [{ key: "x", value }];
function viewerRequestEvent({ uri = "/tickets", querystring = "", cookie, headers = {} } = {}) {
  const all = Object.assign({ host: h("shop.example.com"), "user-agent": h("UA"), "accept-language": h("en-GB,en;q=0.9") }, headers);
  if (cookie) all.cookie = h(cookie);
  return { Records: [{ cf: { request: { clientIp: "203.0.113.9", uri, querystring, headers: all } } }] };
}
function responseEvent({ status = "200", uri = "/tickets", headers } = {}) {
  const defaults = {
    host: h("shop.example.com"),
    "x-ch-crowdhandler-token": h("tok0abc123"),
    "x-ch-responseid": h("resp1"),
    "x-ch-api-endpoint": h("api.crowdhandler.com"),
    "x-ch-public-key": h("pk"),
    "x-ch-request-time": h(String(Date.now() - 120)),
  };
  return { Records: [{ cf: { request: { uri, headers: headers || defaults }, response: { status, headers: {} } } }] };
}
const viewerResponse = (fns, event) => new Promise((resolve) => fns.viewerResponse(event, {}, (err, res) => resolve(res)));
const location = (res) => res.headers.location[0].value;
const withRandom = async (value, fn) => {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
};
const SAMPLED = 0.99; // wins the 1-in-3 lottery
const NOT_SAMPLED = 0.1;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- viewer-request -------------------------------------------------------
test("promoted: passes to origin with token and response id, forged headers dropped", async ({ open }) => {
  respond = api({ status: 1, promoted: 1, token: "tok0abc123", responseID: "resp1", slug: "room" });
  const res = await open.viewerRequest(viewerRequestEvent({ cookie: "crowdhandler=tok0abc123", headers: { "x-ch-responseid": h("forged") } }));
  assert.strictEqual(res.headers["x-ch-crowdhandler-token"][0].value, "tok0abc123");
  assert.strictEqual(res.headers["x-ch-responseid"][0].value, "resp1");
  assert.strictEqual(res.headers["x-ch-api-endpoint"][0].value, "api.test.example");
  assert.strictEqual(calls[0].options.method, "GET");
  assert(Object.keys(res.headers).every((k) => k === k.toLowerCase()), "header keys must be lowercase");
});

test("static asset: forged control headers are stripped, no API call", async ({ open }) => {
  respond = () => assert.fail("no API call expected");
  const res = await open.viewerRequest(
    viewerRequestEvent({ uri: "/js/jquery.fancybox-1.3.4.css", headers: { "x-ch-crowdhandler-token": h("forged1"), "x-ch-responseid": h("forged2"), "x-ch-api-endpoint": h("evil.example") } })
  );
  assert.strictEqual(res.headers["x-ch-crowdhandler-token"], undefined);
  assert.strictEqual(res.headers["x-ch-responseid"], undefined);
  assert.strictEqual(res.headers["x-ch-api-endpoint"][0].value, "api.test.example");
});

test("queued: redirects to the waiting room and sets the cookie", async ({ open }) => {
  respond = api({ status: 1, promoted: 0, token: "tok0new1", slug: "room" });
  const res = await open.viewerRequest(viewerRequestEvent({ querystring: "a=1" }));
  assert.strictEqual(res.status, "302");
  assert(location(res).startsWith("https://shop.example.com/ch/room?url="));
  assert(location(res).includes("ch-id=tok0new1"));
  assert.strictEqual(res.headers["set-cookie"][0].value, "crowdhandler=tok0new1; path=/; Secure");
  assert.strictEqual(calls[0].options.method, "POST");
});

test("only ch-* parameters: origin sees an empty query string", async ({ open }) => {
  respond = api({ status: 1, promoted: 1, token: "tok0abc123", responseID: "resp1" });
  const res = await open.viewerRequest(viewerRequestEvent({ querystring: "ch-code=VIP", cookie: "crowdhandler=tok0abc123" }));
  assert.strictEqual(res.querystring, "");
});

test("ch-id: redirects to the clean URL with the cookie", async ({ open }) => {
  respond = () => assert.fail("no API call expected");
  const res = await open.viewerRequest(viewerRequestEvent({ querystring: "a=1&ch-id=tok0abc123&ch-public-key=pk" }));
  assert.strictEqual(res.status, "302");
  assert.strictEqual(location(res), "https://shop.example.com/tickets?a=1");
  assert.strictEqual(res.headers["set-cookie"][0].value, "crowdhandler=tok0abc123; path=/; Secure");
});

test("API 5xx: fail open with failTrust on, safety net with it off", async ({ open, closed }) => {
  respond = () => ({ status: 503, body: "" });
  const allowed = await open.viewerRequest(viewerRequestEvent({ cookie: "crowdhandler=tok0abc123" }));
  assert.strictEqual(allowed.status, undefined);
  const res = await closed.viewerRequest(viewerRequestEvent({ querystring: "ch-code=VIP", cookie: "crowdhandler=tok0abc123" }));
  assert.strictEqual(res.status, "302");
  assert(location(res).startsWith("https://shop.example.com/ch/?url="), location(res));
  assert(location(res).includes("ch-code=VIP&ch-id=tok0abc123&ch-public-key=pk_test"));
});

test("API 429 and status 6: follow failTrust", async ({ open, closed }) => {
  respond = () => ({ status: 429, body: "" });
  assert.strictEqual((await open.viewerRequest(viewerRequestEvent())).status, undefined);
  assert.strictEqual((await closed.viewerRequest(viewerRequestEvent())).status, "302");
  respond = api({ status: 6, promoted: 0, token: "tok0thr1" });
  assert.strictEqual((await open.viewerRequest(viewerRequestEvent())).status, undefined);
  const res = await closed.viewerRequest(viewerRequestEvent());
  assert(location(res).includes("/ch/?url=") && location(res).includes("ch-id=tok0thr1"));
});

test("API 4xx: safety net even with failTrust on, no 'null' token in the URL", async ({ open }) => {
  respond = () => ({ status: 403, body: "" });
  const res = await open.viewerRequest(viewerRequestEvent());
  assert.strictEqual(res.status, "302");
  assert(location(res).includes("ch-id=&ch-public-key="), location(res));
});

test("API timeout and unreadable body: follow failTrust", async ({ open, closed }) => {
  respond = () => ({ status: 200, body: "<html>WAF</html>" });
  assert.strictEqual((await open.viewerRequest(viewerRequestEvent())).status, undefined);
  assert.strictEqual((await closed.viewerRequest(viewerRequestEvent())).status, "302");
  respond = () => ({ status: 200, body: "{}" });
  assert.strictEqual((await open.viewerRequest(viewerRequestEvent())).status, undefined);
  assert.strictEqual((await closed.viewerRequest(viewerRequestEvent())).status, "302");
});

test("genuine status 2 (not promoted): allowed whatever failTrust says, no token forwarded", async ({ open, closed }) => {
  respond = api({ status: 2, promoted: 0, token: "tok0abc123", responseID: "resp1" });
  for (const fns of [open, closed]) {
    const res = await fns.viewerRequest(viewerRequestEvent({ cookie: "crowdhandler=tok0abc123" }));
    assert.strictEqual(res.status, undefined);
    assert.strictEqual(res.headers["x-ch-crowdhandler-token"], undefined);
    assert.strictEqual(res.headers["x-ch-responseid"], undefined);
  }
});

test("unexpected error: fail open with failTrust on, safety net with it off", async ({ open, closed }) => {
  respond = () => assert.fail("no API call expected");
  const broken = () => {
    const event = viewerRequestEvent({ querystring: "a=1", cookie: "crowdhandler=tok0abc123" });
    Object.defineProperty(event.Records[0].cf.request, "clientIp", {
      get() {
        throw new Error("boom");
      },
    });
    return event;
  };
  assert.strictEqual((await open.viewerRequest(broken())).status, undefined);
  const res = await closed.viewerRequest(broken());
  assert.strictEqual(res.status, "302");
  assert(location(res).startsWith(`https://shop.example.com/ch/?url=${encodeURIComponent("https://shop.example.com/tickets?a=1")}`), location(res));
  assert(location(res).includes("ch-id=tok0abc123"));
});

test("safetyNetSlug, whitelabel off and trustedClientIPHeader are honoured", async ({ custom }) => {
  respond = () => ({ status: 403, body: "" });
  const res = await custom.viewerRequest(viewerRequestEvent({ headers: { "cf-connecting-ip": h("198.51.100.7") } }));
  assert(location(res).startsWith("https://wait.crowdhandler.com/safety?url="), location(res));
  assert.strictEqual(JSON.parse(calls[0].body).ip, "198.51.100.7");
});

test("client IP defaults to the connection address", async ({ open }) => {
  respond = api({ status: 1, promoted: 1, token: "tok0abc123" });
  await open.viewerRequest(viewerRequestEvent({ headers: { "cf-connecting-ip": h("198.51.100.7") } }));
  assert.strictEqual(JSON.parse(calls[0].body).ip, "203.0.113.9");
});

// ---- viewer-response ------------------------------------------------------
test("viewer-response: sets cookies and sends a sampled report with the real status", async ({ open }) => {
  respond = () => ({ status: 200, body: "" });
  const res = await withRandom(SAMPLED, () => viewerResponse(open, responseEvent({ status: "301" })));
  assert.deepStrictEqual(
    res.headers["set-cookie"].map((c) => c.value),
    ["crowdhandler=tok0abc123; path=/; Secure;", "crowdhandler_integration=cloudfront; path=/; Secure;"]
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.path, "/v1/responses/resp1");
  assert.strictEqual(calls[0].options.hostname, "api.crowdhandler.com");
  const body = JSON.parse(calls[0].body);
  assert.strictEqual(String(body.httpCode), "301");
  assert.strictEqual(body.sampleRate, 3);
  assert(body.time >= 120 && body.time < 5000);
});

test("viewer-response: nothing sent when not sampled, for static files or without a token", async ({ open }) => {
  respond = () => assert.fail("no API call expected");
  await withRandom(NOT_SAMPLED, () => viewerResponse(open, responseEvent()));
  const asset = await withRandom(SAMPLED, () => viewerResponse(open, responseEvent({ uri: "/a.css" })));
  assert.strictEqual(asset.headers["set-cookie"], undefined);
  const noToken = await withRandom(SAMPLED, () => viewerResponse(open, responseEvent({ headers: { host: h("shop.example.com") } })));
  assert.strictEqual(noToken.headers["set-cookie"], undefined);
});

test("viewer-response: a hung API delays the response by the send budget at most", async ({ open }) => {
  for (const outcome of [{ hang: true }, { error: true }]) {
    respond = () => outcome;
    const started = Date.now();
    const res = await withRandom(SAMPLED, () => viewerResponse(open, responseEvent()));
    assert(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
    assert.strictEqual(res.headers["set-cookie"].length, 2);
  }
});

test("report weights add up: reports x label ~= requests", async ({ open }) => {
  respond = () => ({ status: 200, body: "" });
  const N = 3000;
  for (let i = 0; i < N; i++) await viewerResponse(open, responseEvent());
  const estimate = calls.reduce((sum, c) => sum + JSON.parse(c.body).sampleRate, 0);
  assert(Math.abs(estimate - N) / N < 0.15, `estimate ${estimate} for ${N} requests`);
});

// ---- origin-response ------------------------------------------------------
test("origin-response: every 5xx reported with weight 1, 4xx sampled, successes left to viewer-response", async ({ open }) => {
  respond = () => ({ status: 200, body: "" });
  await withRandom(NOT_SAMPLED, () => open.originResponse(responseEvent({ status: "503" })));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([String(JSON.parse(calls[0].body).httpCode), JSON.parse(calls[0].body).sampleRate], ["503", 1]);

  await withRandom(NOT_SAMPLED, () => open.originResponse(responseEvent({ status: "404" })));
  assert.strictEqual(calls.length, 1);
  await withRandom(SAMPLED, () => open.originResponse(responseEvent({ status: "404" })));
  assert.deepStrictEqual([String(JSON.parse(calls[1].body).httpCode), JSON.parse(calls[1].body).sampleRate], ["404", 3]);

  await withRandom(SAMPLED, () => open.originResponse(responseEvent({ status: "200" })));
  await withRandom(SAMPLED, () => open.originResponse(responseEvent({ status: "503", headers: { host: h("shop.example.com") } })));
  assert.strictEqual(calls.length, 2);
});

test("origin-response: a hung API never holds the response", async ({ open }) => {
  respond = () => ({ hang: true });
  const started = Date.now();
  const res = await open.originResponse(responseEvent({ status: "500" }));
  assert.strictEqual(res.status, "500");
  assert(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

// ---- origin override (/ch/*) ----------------------------------------------
const overrideEvent = (uri, querystring = "url=x") => ({ Records: [{ cf: { request: { uri, querystring, headers: { host: h("shop.example.com") } } } }] });

test("override: serves the room template, and the status endpoint", async ({ open }) => {
  respond = () => ({ status: 200, body: "<html>room</html>" });
  const res = await open.originOverride(overrideEvent("/ch/room"));
  assert.strictEqual(res.body, "<html>room</html>");
  assert.strictEqual(res.headers["cache-control"][0].value, "max-age=60, public");
  assert.deepStrictEqual([calls[0].options.hostname, calls[0].options.path], ["wait.crowdhandler.com", "/room"]);
  const status = await open.originOverride(overrideEvent("/ch/status"));
  assert.strictEqual(JSON.parse(status.body).status, "ok");
});

test("override: failing template host gets three attempts, then the uncached inline room", async ({ open }) => {
  respond = () => ({ status: 502, body: "" });
  const res = await open.originOverride(overrideEvent("/ch/room"));
  assert.deepStrictEqual(calls.map((c) => c.options.path), ["/room", "/room", "/?url=x"]);
  assert.strictEqual(res.status, "200");
  assert(res.body.includes('http-equiv="refresh"'));
  assert.strictEqual(res.headers["cache-control"][0].value, "no-cache, no-store, must-revalidate");
});

test("override: hung template host is cut off within the time budget", async ({ open }) => {
  respond = () => ({ hang: true });
  const started = Date.now();
  const res = await open.originOverride(overrideEvent("/ch/room"));
  const took = Date.now() - started;
  assert(took < 4500, `took ${took}ms`);
  assert(res.body.includes('http-equiv="refresh"'));
});

// ---- runner ---------------------------------------------------------------
(async () => {
  const configure = (code) =>
    replaceOnce(replaceOnce(code, '"CROWDHANDLER_API_DOMAIN"', '"api.test.example"'), '"CROWDHANDLER_PUBLIC_KEY"', '"pk_test"');
  const failClosed = (code) => replaceOnce(configure(code), "const failTrust = true;", "const failTrust = false;");
  const customised = (code) =>
    replaceOnce(
      replaceOnce(replaceOnce(configure(code), "let safetyNetSlug;", 'let safetyNetSlug = "safety";'), "const whitelabel = true;", "const whitelabel = false;"),
      "let trustedClientIPHeader;",
      'let trustedClientIPHeader = "cf-connecting-ip";'
    );
  const fns = { open: await build("open", configure), closed: await build("closed", failClosed), custom: await build("custom", customised) };

  // Keep the handlers' own logging out of the test output.
  const quiet = ["log", "error"].map((m) => [m, console[m]]);
  let failed = 0;
  for (const { name, fn } of tests) {
    calls = [];
    quiet.forEach(([m]) => (console[m] = () => {}));
    let error;
    try {
      await fn(fns);
    } catch (e) {
      error = e;
    }
    quiet.forEach(([m, original]) => (console[m] = original));
    if (error) {
      failed++;
      console.error(`FAIL  ${name}\n      ${error.stack || error}`);
    } else {
      console.log(`ok    ${name}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
