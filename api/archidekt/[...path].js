export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const pathParts = normalizePathParts(request.query.path);
  const safePath = pathParts.map((part) => encodeURIComponent(part)).join("/");
  const upstreamUrl = new URL(`https://archidekt.com/api/${safePath}/`);

  Object.entries(request.query).forEach(([key, value]) => {
    if (key === "path") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => upstreamUrl.searchParams.append(key, item));
    } else if (value !== undefined) {
      upstreamUrl.searchParams.set(key, value);
    }
  });

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MTG-Duels-Sandbox/1.0",
      },
    });
    const body = await upstreamResponse.text();

    response.status(upstreamResponse.status);
    response.setHeader(
      "Content-Type",
      upstreamResponse.headers.get("content-type") ?? "application/json",
    );
    response.setHeader("X-Archidekt-Upstream", upstreamUrl.toString());
    response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
    response.send(body);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Archidekt proxy failed",
    });
  }
}

function normalizePathParts(rawPath) {
  const parts = Array.isArray(rawPath) ? rawPath : [rawPath].filter(Boolean);

  return parts
    .flatMap((part) => String(part).split("/"))
    .map((part) => part.trim())
    .filter(Boolean);
}
