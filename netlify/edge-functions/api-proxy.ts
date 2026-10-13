/**
 * Same-origin proxy for the CraveDirect API.
 * Set BACKEND_API_ORIGIN in Netlify runtime / Functions environment variables
 * to the backend origin only, e.g. https://your-api.onrender.com (no /api/v1).
 */
export default async function apiProxy(request: Request): Promise<Response> {
  const configuredOrigin = Netlify.env.get("BACKEND_API_ORIGIN");

  if (!configuredOrigin) {
    return jsonError(503, "API_NOT_CONFIGURED", "The backend API origin has not been configured for this deployment.");
  }

  let backend: URL;
  try {
    backend = new URL(configuredOrigin);
    if (
      !["https:", "http:"].includes(backend.protocol) ||
      backend.username ||
      backend.password ||
      backend.pathname !== "/" ||
      backend.search ||
      backend.hash
    ) {
      throw new Error("Expected a plain HTTP(S) origin.");
    }
  } catch {
    return jsonError(500, "API_CONFIGURATION_INVALID", "BACKEND_API_ORIGIN must be a valid backend origin without a path or credentials.");
  }

  const incoming = new URL(request.url);
  const upstreamUrl = new URL(`${incoming.pathname}${incoming.search}`, backend.origin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const header of ["content-length", "content-encoding", "transfer-encoding", "connection"]) {
      responseHeaders.delete(header);
    }
    responseHeaders.set("cache-control", "no-store");

    return new Response(
      upstream.status === 204 || upstream.status === 304 ? null : upstream.body,
      { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders },
    );
  } catch {
    return jsonError(502, "API_UPSTREAM_UNAVAILABLE", "The CraveDirect API could not be reached. Check the backend deployment and logs.");
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
