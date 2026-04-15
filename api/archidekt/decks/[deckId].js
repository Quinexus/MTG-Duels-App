export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const deckId = Array.isArray(request.query.deckId)
    ? request.query.deckId[0]
    : request.query.deckId;

  if (!deckId || !/^\d+$/.test(deckId)) {
    response.status(400).json({ error: "Missing or invalid Archidekt deck id" });
    return;
  }

  const upstreamUrl = `https://archidekt.com/api/decks/${encodeURIComponent(deckId)}/`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MTG-Duels-Sandbox/1.0",
      },
    });
    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";

    response.status(upstreamResponse.status);
    response.setHeader("Content-Type", contentType);
    response.setHeader("X-Archidekt-Upstream", upstreamUrl);
    response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
    response.send(body);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Archidekt proxy failed",
      upstream: upstreamUrl,
    });
  }
}
