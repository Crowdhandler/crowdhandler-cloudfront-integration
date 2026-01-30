# CloudFront Integration Comparison

## Overview

Comparing CloudFront non-proxy integration vs CloudFront proxy integration (accelerator branch) to identify architectural differences and potential improvements.

---

## Lambda@Edge Function Comparison

### Non-Proxy Integration (3 functions)

| Function | Trigger | Purpose |
|----------|---------|---------|
| `handlerViewerRequest.js` | viewer-request | API check, redirect to queue or pass through |
| `handlerOriginResponse.js` | origin-response | Set cookies, performance sampling |
| `handlerOriginOverride.js` | origin-request | Serve /ch/* waiting room pages |

### Proxy Integration - Accelerator Branch (7 functions)

| Function | Trigger | Purpose |
|----------|---------|---------|
| `handlerViewerReq.js` | viewer-request | API check, set `x-crowdhandler-token` header |
| `handlerViewerResp.js` | viewer-response | **Set cookies from token header** |
| `handlerOriginResp.js` | origin-response | Performance sampling |
| `handlerOriginMeta.js` | origin-request | Handle /ch/meta endpoint |
| `handlerOriginPageOverride.js` | origin-request | Serve /ch/* waiting room pages |
| `handlerOriginReqCleanup.js` | origin-request | Remove sensitive headers |
| `handlerOriginRespCleanup.js` | origin-response | Remove cookies from cached responses |

---

## Key Architectural Difference: Cookie Setting

### Non-Proxy (Current)
- Cookies set in **origin-response**
- Only fires when origin is hit (cache miss)
- Cached responses do NOT set cookies

### Proxy (Accelerator)
- Cookies set in **viewer-response**
- Fires on ALL responses (including cached)
- Token passed via `x-crowdhandler-token` header from viewer-request

**Why this matters:** Users hitting cached pages in non-proxy won't get their cookie refreshed. Proxy approach ensures cookie is always set.

---

## Query String Handling

Both integrations use `query-string` library:
- `queryStringParse(querystring, "object")` - parse to object
- `queryStringParse(querystring, "string")` - stringify back

This library handles encoding correctly (unlike URLSearchParams in Cloudflare/Akamai).

**Status:** No encoding fixes needed for either CloudFront integration.

---

## Robustness Review - Non-Proxy

### Current Diff (maintenance/robustness-review branch)

| File | Change | Purpose |
|------|--------|---------|
| `handlerViewerRequest.js` | `userAgent` optional chaining + `\|\| null` | Null safety |
| `handlerViewerRequest.js` | `language = null` init | Explicit null |
| `handlerViewerRequest.js` | `IPAddress \|\| null` | Null safety |
| `handlerViewerRequest.js` | Try/catch on `JSON.parse(response)` | Fallback for failTrust |
| `handlerViewerRequest.js` | Logging cleanup | Structured summary |
| `handlerOriginResponse.js` | Optional chaining `?.[0]?.value` | Null safety on headers |
| `handlerOriginResponse.js` | Check required headers before proceeding | Early exit |
| `handlerOriginResponse.js` | Removed "Static file detected" log | Less noise |
| `handlerOriginOverride.js` | `throw` → `return` | Fix: was throwing response object |
| `handlerOriginOverride.js` | `console.error` for template fetch | Consistent errors |
| `helpers/misc.js` | `parts[1] !== undefined` | Cookie parsing safety |

### Logging After Cleanup

**handlerViewerRequest.js:**
```
[CH] example.com/page | src:param | action:redirect | token:xxx
[CH] example.com/page | src:cookie | action:allow | token:xxx
```
Token source: `param` (ch-id), `cookie`, `new`

**Errors only:** API failures, parse failures, template fetch failures

---

## Potential Improvements

### 1. Adopt viewer-response cookie pattern
Move cookie setting from origin-response to viewer-response to ensure cookies on cached pages.

**Requires:**
- New `handlerViewerResponse.js` function
- Modify `handlerViewerRequest.js` to set `x-crowdhandler-token` header
- Modify `handlerOriginResponse.js` to only do perf sampling
- CloudFormation/serverless.yml update for new function

### 2. Add origin-response cleanup
Remove cookies from responses that will be cached to prevent cookie leakage.

---

## Deployment Notes

Non-proxy uses serverless framework with webpack:
- `npm run package` - Build to dist/
- Manual Lambda function updates possible (faster than full deploy)

Functions that changed:
1. viewerRequest
2. originResponse
3. originOverride

All three share `helpers/misc.js` (bundled in).

---

## Next Steps

1. [ ] Deploy robustness fixes to non-proxy (manual function updates)
2. [ ] Test non-proxy with encoding test suite
3. [ ] Evaluate viewer-response cookie pattern adoption
4. [ ] Document proxy accelerator branch changes separately

---

## Related Files

- `/Users/lukeowen/Sites/crowdhandler-clientside/tests.md` - Main test documentation
- `/Users/lukeowen/Sites/crowdhandler-cloudfront-integration/` - Non-proxy repo
- `/Users/lukeowen/Sites/crowdhandler-proxy-cloudfront/` - Proxy repo (accelerator branch)
