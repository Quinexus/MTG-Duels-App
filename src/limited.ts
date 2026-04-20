import { scryfallCardToCardData, shuffleCards } from "./deck";
import jumpstartCatalog from "./data/jumpstart-catalog.json";
import type { CardData, ScryfallCard } from "./types";

export type LimitedColorGroup = "W" | "U" | "B" | "R" | "G" | "M" | "C";

export type LimitedGroup = {
  id: LimitedColorGroup;
  label: string;
  cards: CardData[];
};

export type JumpstartTheme = {
  id: string;
  name: string;
  color: "W" | "U" | "B" | "R" | "G" | "C" | "M";
  product?: string;
  source?: string;
  deck: Array<{ quantity: number; name: string }>;
};

type ScryfallListResponse = {
  data: ScryfallCard[];
  has_more?: boolean;
  next_page?: string;
};

export const basicLandNames = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;

export const popularLimitedSets = [
  { code: "fdn", name: "Foundations" },
  { code: "dft", name: "Aetherdrift" },
  { code: "tdm", name: "Tarkir: Dragonstorm" },
  { code: "fin", name: "Final Fantasy" },
  { code: "eoe", name: "Edge of Eternities" },
  { code: "j25", name: "Foundations Jumpstart" },
] as const;

export const jumpstartThemes = jumpstartCatalog.decks as JumpstartTheme[];
export async function fetchSetCards(setCode: string): Promise<CardData[]> {
  const normalized = setCode.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Choose a set code first.");
  }

  const cards: ScryfallCard[] = [];
  let nextUrl:
    | string
    | undefined = `https://api.scryfall.com/cards/search?order=set&q=${encodeURIComponent(
    `e:${normalized} -is:digital unique:prints`,
  )}`;

  while (nextUrl) {
    const response = await fetch(nextUrl);
    if (!response.ok) {
      throw new Error(`Scryfall returned ${response.status} for ${normalized.toUpperCase()}.`);
    }

    const result = (await response.json()) as ScryfallListResponse;
    cards.push(...result.data);
    nextUrl = result.has_more ? result.next_page : undefined;
  }

  return cards
    .map(scryfallCardToCardData)
    .filter((card) => !card.typeLine.toLowerCase().includes("token"));
}

export function createBooster(cards: CardData[]): CardData[] {
  const commons = cards.filter((card) => card.rarity === "common" && !isBasicLand(card));
  const uncommons = cards.filter((card) => card.rarity === "uncommon");
  const rares = cards.filter((card) => card.rarity === "rare" || card.rarity === "mythic");
  const lands = cards.filter((card) => card.typeLine.toLowerCase().includes("land"));
  const fallback = cards.filter((card) => !isBasicLand(card));

  return [
    ...pickMany(commons.length ? commons : fallback, 10),
    ...pickMany(uncommons.length ? uncommons : fallback, 3),
    ...pickMany(rares.length ? rares : fallback, 1),
    ...pickMany(lands.length ? lands : fallback, 1),
  ];
}

export function createSealedPool(cardsBySet: Record<string, CardData[]>, packSets: string[]) {
  return packSets.flatMap((setCode) => createBooster(cardsBySet[setCode.toLowerCase()] ?? []));
}

export function cardPoolToDecklist(cards: CardData[], lands: Record<string, number>) {
  const counts = new Map<string, { card: CardData; quantity: number }>();
  cards.forEach((card) => {
    const key = card.setCode && card.collectorNumber
      ? `${card.name}::${card.setCode}::${card.collectorNumber}`
      : card.name;
    const current = counts.get(key);
    counts.set(key, { card, quantity: (current?.quantity ?? 0) + 1 });
  });

  const cardLines = Array.from(counts.values())
    .sort((a, b) => sortLimitedCards(a.card, b.card))
    .map(({ card, quantity }) =>
      card.setCode && card.collectorNumber
        ? `${quantity} ${card.name} (${card.setCode.toUpperCase()}) ${card.collectorNumber}`
        : `${quantity} ${card.name}`,
    );
  const landLines = Object.entries(lands)
    .filter(([, quantity]) => quantity > 0)
    .map(([name, quantity]) => `${quantity} ${name}`);

  return [...cardLines, ...landLines].join("\n");
}

export function jumpstartDecklist(themeIds: string[]) {
  const cards = new Map<string, number>();
  themeIds
    .map((id) => jumpstartThemes.find((theme) => theme.id === id))
    .filter((theme): theme is JumpstartTheme => Boolean(theme))
    .flatMap((theme) => theme.deck)
    .filter((line) => !isVariableJumpstartSlot(line.name))
    .forEach((line) => cards.set(line.name, (cards.get(line.name) ?? 0) + line.quantity));

  return Array.from(cards.entries())
    .map(([name, quantity]) => `${quantity} ${name}`)
    .join("\n");
}

export function randomJumpstartThemeIds() {
  return shuffleCards(jumpstartThemes).slice(0, 2).map((theme) => theme.id);
}

export function groupLimitedCards(cards: CardData[]): LimitedGroup[] {
  const groups: LimitedGroup[] = [
    { id: "W", label: "White", cards: [] },
    { id: "U", label: "Blue", cards: [] },
    { id: "B", label: "Black", cards: [] },
    { id: "R", label: "Red", cards: [] },
    { id: "G", label: "Green", cards: [] },
    { id: "C", label: "Colorless", cards: [] },
    { id: "M", label: "Multicolor", cards: [] },
  ];
  const byId = new Map(groups.map((group) => [group.id, group]));

  cards.forEach((card) => {
    byId.get(colorGroupForCard(card))?.cards.push(card);
  });

  return groups.map((group) => ({
    ...group,
    cards: [...group.cards].sort(sortLimitedCards),
  }));
}

export function colorGroupForCard(card: CardData): LimitedColorGroup {
  const colors = card.colors?.length ? card.colors : card.colorIdentity ?? [];
  if (colors.length > 1) {
    return "M";
  }
  if (colors.length === 0) {
    return "C";
  }
  return (["W", "U", "B", "R", "G"].includes(colors[0]) ? colors[0] : "C") as LimitedColorGroup;
}

function pickMany<T>(items: T[], count: number) {
  if (items.length === 0) {
    return [];
  }

  const picked: T[] = [];
  const shuffled = shuffleCards(items);
  for (let index = 0; index < count; index += 1) {
    picked.push(shuffled[index % shuffled.length]);
  }
  return picked;
}

function sortLimitedCards(a: CardData, b: CardData) {
  return (
    a.cmc - b.cmc ||
    a.name.localeCompare(b.name) ||
    (a.collectorNumber ?? "").localeCompare(b.collectorNumber ?? "")
  );
}

function isBasicLand(card: CardData) {
  return basicLandNames.some((name) => card.name === name);
}

function isVariableJumpstartSlot(name: string) {
  return /random rare/i.test(name);
}
