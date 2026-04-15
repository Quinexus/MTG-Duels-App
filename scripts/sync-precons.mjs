import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const preconsPath = join(__dirname, "../src/precons.ts");
const manifestPath = join(__dirname, "../src/archidekt-precons.json");
const source = await readFile(preconsPath, "utf8");
const deckCount = [...source.matchAll(/id: "/g)].length;

if (deckCount < 1) {
  throw new Error("No local precon decklists found in src/precons.ts");
}

try {
  const response = await fetch("https://archidekt.com/commander-precons", {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Archidekt returned ${response.status}`);
  }

  const html = await response.text();
  const decks = [...html.matchAll(/href="\/decks\/(\d+)\/([^"]+)"/g)]
    .map((match) => ({
      id: match[1],
      slug: match[2],
      url: `https://archidekt.com/decks/${match[1]}/${match[2]}`,
      name: humanizeSlug(match[2]),
    }))
    .filter((deck, index, decks) => decks.findIndex((item) => item.id === deck.id) === index)
    .slice(0, 80);

  if (decks.length < 1) {
    throw new Error("No Archidekt precon links found");
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        source: "https://archidekt.com/commander-precons",
        updatedAt: new Date().toISOString(),
        decks,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`precon sync: refreshed ${decks.length} Archidekt precon links`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.log(`precon sync: Archidekt refresh skipped (${message})`);
}

console.log(`precon sync: using ${deckCount} bundled local decklists`);

function humanizeSlug(slug) {
  return slug
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
