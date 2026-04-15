import { deckLineCacheKey, scryfallCardToCardData } from "./deck";
import type { CardData, DeckLine, ScryfallCard } from "./types";

const CACHE_KEY = "mtg-duels-scryfall-cache-v1";

type CollectionResponse = {
  data: ScryfallCard[];
  not_found?: Array<{ name?: string }>;
};

export async function fetchCardsByName(names: string[]): Promise<{
  cardsByName: Map<string, CardData>;
  missing: string[];
}> {
  const cache = readCache();
  const cardsByName = new Map<string, CardData>();
  const uncached = names.filter((name) => {
    const cached = cache[name.toLowerCase()];
    if (cached) {
      cardsByName.set(name, cached);
      return false;
    }

    return true;
  });

  const batches = chunk(uncached, 75);
  const missing: string[] = [];

  for (const batch of batches) {
    const response = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identifiers: batch.map((name) => ({ name })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Scryfall returned ${response.status}`);
    }

    const result = (await response.json()) as CollectionResponse;
    const incomingByLowerName = new Map(
      result.data.map((card) => [card.name.toLowerCase(), card]),
    );

    batch.forEach((requestedName) => {
      const card =
        incomingByLowerName.get(requestedName.toLowerCase()) ??
        result.data.find((item) =>
          item.name.toLowerCase().includes(requestedName.toLowerCase()),
        );

      if (!card) {
        missing.push(requestedName);
        return;
      }

      const data = scryfallCardToCardData(card);
      cardsByName.set(requestedName, data);
      cache[requestedName.toLowerCase()] = data;
    });

    result.not_found?.forEach((item) => {
      if (item.name) {
        missing.push(item.name);
      }
    });
  }

  writeCache(cache);
  return { cardsByName, missing: Array.from(new Set(missing)) };
}

export async function fetchCardsForDeckLines(lines: DeckLine[]): Promise<{
  cardsByName: Map<string, CardData>;
  missing: string[];
}> {
  const uniqueLines = Array.from(
    new Map(lines.map((line) => [deckLineCacheKey(line), line])).values(),
  );
  const cache = readCache();
  const cardsByName = new Map<string, CardData>();
  const uncached = uniqueLines.filter((line) => {
    const key = deckLineCacheKey(line).toLowerCase();
    const cached = cache[key];
    if (cached) {
      cardsByName.set(deckLineCacheKey(line), cached);
      cardsByName.set(line.name, cached);
      return false;
    }

    return true;
  });
  const missing: string[] = [];

  for (const batch of chunk(uncached, 75)) {
    const response = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identifiers: batch.map((line) =>
          line.setCode && line.collectorNumber
            ? {
                set: line.setCode.toLowerCase(),
                collector_number: line.collectorNumber,
              }
            : { name: line.name },
        ),
      }),
    });

    if (!response.ok) {
      throw new Error(`Scryfall returned ${response.status}`);
    }

    const result = (await response.json()) as CollectionResponse;
    batch.forEach((line, index) => {
      const card =
        result.data[index] ??
        result.data.find((item) => item.name.toLowerCase() === line.name.toLowerCase()) ??
        result.data.find((item) => item.name.toLowerCase().includes(line.name.toLowerCase()));

      if (!card) {
        missing.push(line.name);
        return;
      }

      const data = scryfallCardToCardData(card);
      const key = deckLineCacheKey(line);
      cardsByName.set(key, data);
      cardsByName.set(line.name, data);
      cache[key.toLowerCase()] = data;
      cache[line.name.toLowerCase()] = data;
    });

    result.not_found?.forEach((item) => {
      if (item.name) {
        missing.push(item.name);
      }
    });
  }

  writeCache(cache);
  return { cardsByName, missing: Array.from(new Set(missing)) };
}

export async function fetchCardFromScryfallInput(input: string): Promise<CardData> {
  const value = input.trim();
  if (!value) {
    throw new Error("Enter a card name or Scryfall URL.");
  }

  const urlCardId = extractScryfallCardId(value);
  const endpoint = urlCardId
    ? `https://api.scryfall.com/cards/${urlCardId}`
    : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(value)}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Scryfall returned ${response.status}.`);
  }

  return scryfallCardToCardData((await response.json()) as ScryfallCard);
}

function readCache(): Record<string, CardData> {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return cached ? (JSON.parse(cached) as Record<string, CardData>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CardData>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    return;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function extractScryfallCardId(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (!url.hostname.includes("scryfall.com")) {
      return undefined;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    return parts[0] === "card" || parts[0] === "cards" ? parts.at(-1) : undefined;
  } catch {
    return undefined;
  }
}
