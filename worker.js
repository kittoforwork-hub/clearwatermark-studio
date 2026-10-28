const MODELS = {
  "/model/migan_pipeline_v2.onnx": {
    source: "https://huggingface.co/edgetools/migan/resolve/main/migan_pipeline_v2.onnx?download=true",
    cacheKey: "/__clearmark-cache/migan_pipeline_v2-mit-v2.onnx",
    ttl: 60 * 60 * 24 * 30,
  },
  "/model/lama_fp32.onnx": {
    source: "https://huggingface.co/edgetools/lama/resolve/main/lama_fp32.onnx?download=true",
    cacheKey: "/__clearmark-cache/lama_fp32-apache2-v1.onnx",
    ttl: 60 * 60 * 24 * 30,
  },
};

function responseHeaders(ttl, extra = {}) {
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": `public, max-age=${ttl}, immutable`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
}

function errorResponse(message, status = 502) {
  return new Response(message, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  }});
}

async function serveModel(request, ctx, model, pathname) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(model.ttl, { "Access-Control-Allow-Headers": "Range, Content-Type" }) });
  if (request.method !== "GET" && request.method !== "HEAD") return errorResponse("Method not allowed", 405);
  const cacheKey = new Request(new URL(model.cacheKey, request.url).toString(), { method: "GET" });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(request.method === "HEAD" ? null : cached.body, { status: cached.status, headers });
    }
  } catch (err) { console.warn(`Model cache read failed for ${pathname}`, err); }
  try {
    const upstream = await fetch(model.source, { method: request.method === "HEAD" ? "HEAD" : "GET", redirect: "follow" });
    if (!upstream.ok) {
      console.error(`Model upstream status for ${pathname}:`, upstream.status);
      return errorResponse(`Could not download model (upstream HTTP ${upstream.status}). Please retry later.`);
    }
    const headers = responseHeaders(model.ttl);
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const response = new Response(upstream.body, { status: 200, headers });
    try {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch((err) => console.warn(`Model cache write failed for ${pathname}; download still proceeds`, err)));
    } catch (err) { console.warn(`Could not schedule model caching for ${pathname}`, err); }
    return response;
  } catch (err) {
    console.error(`Model upstream fetch failed for ${pathname}`, err);
    return errorResponse("Could not reach the model source. Check the Worker deployment and retry.");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const model = MODELS[url.pathname];
    if (model) return serveModel(request, ctx, model, url.pathname);
    return env.ASSETS.fetch(request);
  },
};
