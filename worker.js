const MODEL_PATH = "/model/migan_pipeline_v2.onnx";
const MODEL_SOURCE = "https://huggingface.co/edgetools/migan/resolve/main/migan_pipeline_v2.onnx?download=true";
const MODEL_CACHE_KEY = "/__clearmark-cache/migan_pipeline_v2-mit-v1.onnx";
const CACHE_TTL = 60 * 60 * 24 * 30;

function responseHeaders(extra = {}) {
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": `public, max-age=${CACHE_TTL}, immutable`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
}

function errorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    },
  });
}

async function serveModel(request, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: responseHeaders({ "Access-Control-Allow-Headers": "Range, Content-Type" }),
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("Method not allowed", 405);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(MODEL_CACHE_KEY, request.url).toString(), { method: "GET" });
  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(request.method === "HEAD" ? null : cached.body, {
        status: cached.status,
        headers,
      });
    }
  } catch (err) {
    // The Cache API is an optimization only; continue to the upstream source.
    console.warn("Model cache read failed; fetching upstream", err);
  }

  if (request.method === "HEAD") {
    try {
      const upstream = await fetch(MODEL_SOURCE, { method: "HEAD", redirect: "follow" });
      if (!upstream.ok) return errorResponse(`Could not reach the MI-GAN model (upstream HTTP ${upstream.status}).`);
      return new Response(null, { status: 200, headers: responseHeaders() });
    } catch (err) {
      console.error("Model upstream HEAD request failed", err);
      return errorResponse("Could not reach the MI-GAN model source. Check the Worker deployment and try again.");
    }
  }

  try {
    const upstream = await fetch(MODEL_SOURCE, { redirect: "follow" });
    if (!upstream.ok) {
      console.error("Model upstream status:", upstream.status);
      return errorResponse(`Could not download the MI-GAN model (upstream HTTP ${upstream.status}). Please retry later.`);
    }

    // Do not forward Content-Length: upstream redirects/content encodings can make it stale.
    const headers = responseHeaders();
    const response = new Response(upstream.body, { status: 200, headers });

    // Cache the binary model at the edge so repeat visits do not fetch it from Hugging Face again.
    // If caching fails, the stream is still returned to the browser.
    try {
      ctx.waitUntil(cache.put(cacheKey, response.clone()).catch((err) => {
        console.warn("Model cache write failed; download still proceeds", err);
      }));
    } catch (err) {
      console.warn("Could not schedule model caching", err);
    }

    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return response;
  } catch (err) {
    console.error("Model upstream fetch failed", err);
    return errorResponse("Could not reach the MI-GAN model source. Check the Worker deployment and try again.");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === MODEL_PATH) return serveModel(request, ctx);
    return env.ASSETS.fetch(request);
  },
};
