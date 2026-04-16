import type { CardData, CardInstance, DeckLine, ScryfallCard, ZoneId } from "./types";

const QUANTITY_PREFIX = /^\s*(?:(?<qty>\d+)\s*[xX]?\s+)?(?<rest>.+?)\s*$/;
const SET_AND_COLLECTOR_SUFFIX =
  /\s+\((?<set>[A-Za-z0-9]{2,8})\)\s*(?<collector>[-A-Za-z0-9★]+)?\s*$/;

const SECTION_HEADERS: ReadonlyMap<string, DeckLine["section"]> = new Map([
  ["deck", "main"],
  ["main", "main"],
  ["maindeck", "main"],
  ["sideboard", "sideboard"],
  ["side board", "sideboard"],
  ["maybeboard", "sideboard"],
  ["commander", "commander"],
  ["commanders", "commander"],
] as const);

export const sampleDeck = `Commander
1 Atraxa, Praetors' Voice

1 Sol Ring
1 Arcane Signet
1 Command Tower
1 Swords to Plowshares
1 Cultivate
1 Counterspell
1 Birds of Paradise
1 Farseek
1 Beast Within
1 Llanowar Elves
1 Rhystic Study
1 Smothering Tithe
1 Lightning Greaves
1 Eternal Witness
1 Swiftfoot Boots

Sideboard
1 Path to Exile`;

export function parseDeckList(input: string): DeckLine[] {
  let section: DeckLine["section"] = "main";
  let commanderCardsInSection = 0;
  const lines: DeckLine[] = [];

  input.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();

    if (!line || line.startsWith("//") || line.startsWith("#")) {
      if (!line && section === "commander" && commanderCardsInSection > 0) {
        section = "main";
        commanderCardsInSection = 0;
      }
      return;
    }

    const normalized = line.replace(/:$/, "").toLowerCase();
    const header = SECTION_HEADERS.get(normalized);

    if (header) {
      section = header;
      commanderCardsInSection = 0;
      return;
    }

    const parsed = parseDeckCardLine(line);
    const quantity = parsed.quantity;
    const name = parsed.name;

    if (!name || Number.isNaN(quantity) || quantity < 1) {
      return;
    }

    lines.push({
      quantity,
      name,
      section,
      setCode: parsed.setCode,
      collectorNumber: parsed.collectorNumber,
    });
    if (section === "commander") {
      commanderCardsInSection += quantity;
    }
  });

  return lines;
}

export function uniqueCardNames(lines: DeckLine[]): string[] {
  return Array.from(new Set(lines.map(deckLineCacheKey)));
}

export function scryfallCardToCardData(card: ScryfallCard): CardData {
  const front = card.card_faces?.[0];
  const back = card.card_faces?.[1];
  const imageUrl =
    card.image_uris?.normal ??
    front?.image_uris?.normal ??
    card.image_uris?.large ??
    front?.image_uris?.large;

  return {
    id: card.id,
    name: card.name,
    typeLine: card.type_line ?? front?.type_line ?? "Unknown",
    oracleText: card.oracle_text ?? front?.oracle_text ?? "",
    manaCost: card.mana_cost ?? front?.mana_cost,
    cmc: card.cmc ?? 0,
    imageUrl,
    backImageUrl: back?.image_uris?.normal ?? back?.image_uris?.large,
    scryfallUri: card.scryfall_uri,
  };
}

export function buildInstances(
  lines: DeckLine[],
  cardsByName: Map<string, CardData>,
): CardInstance[] {
  return lines.flatMap((line) => {
    const card = cardsByName.get(deckLineCacheKey(line)) ?? cardsByName.get(line.name);
    if (!card) {
      return [];
    }
    const zone = zoneForSection(line.section);

    return Array.from({ length: line.quantity }, (_, index) => ({
      instanceId: `${card.id}-${line.section}-${index}-${crypto.randomUUID()}`,
      cardId: card.id,
      name: card.name,
      zone,
      owner: "you" as const,
      tapped: false,
      counters: {},
      faceDown: false,
      displayBack: false,
      isToken: false,
      isGenerated: false,
      originalZone: zone,
      battlefieldLane: "noncreatures" as const,
      battlefieldOrder: index,
      battlefieldPosition: { x: 8, y: 8 },
    }));
  });
}

export function shuffleCards<T>(cards: T[]): T[] {
  const next = [...cards];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export function deckLineCacheKey(line: Pick<DeckLine, "name" | "setCode" | "collectorNumber">) {
  if (line.setCode && line.collectorNumber) {
    return `${line.name}::${line.setCode.toLowerCase()}::${line.collectorNumber.toLowerCase()}`;
  }

  return line.name;
}

export function parseDeckCardLine(line: string): Omit<DeckLine, "section"> {
  const quantityMatch = QUANTITY_PREFIX.exec(line);
  const quantity = Number(quantityMatch?.groups?.qty ?? 1);
  let rest = quantityMatch?.groups?.rest ?? line;
  let setCode: string | undefined;
  let collectorNumber: string | undefined;

  rest = rest
    .replace(/\s*\^[^^]*\^\s*/g, " ")
    .replace(/\s*\[[^\]]+\]\s*/g, " ")
    .replace(/\s*\{[^}]+\}\s*/g, " ")
    .replace(/\s+\*[^*]*\*\s*/g, " ")
    .replace(/\s+#.*$/, " ")
    .trim();

  const setMatch = SET_AND_COLLECTOR_SUFFIX.exec(rest);
  if (setMatch?.groups?.set) {
    setCode = setMatch.groups.set;
    collectorNumber = setMatch.groups.collector;
    rest = rest.slice(0, setMatch.index).trim();
  }

  return {
    quantity,
    name: cleanupCardName(rest),
    setCode,
    collectorNumber,
  };
}

function cleanupCardName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function zoneForSection(section: DeckLine["section"]): ZoneId {
  if (section === "main") {
    return "library";
  }

  if (section === "commander") {
    return "command";
  }

  return "sideboard";
}
