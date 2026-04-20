import { scryfallCardToCardData, shuffleCards } from "./deck";
import jumpstartCatalog from "./data/jumpstart-catalog.json";
import type { CardData, ScryfallCard } from "./types";

export type LimitedColorGroup = "W" | "U" | "B" | "R" | "G" | "M" | "C";

export type LimitedGroup = {
  id: LimitedColorGroup;
  label: string;
  cards: CardData[];
};

export type PackRequest = {
  setCode: string;
};

export type SealedPack = {
  setCode: string;
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

type ScryfallSetResponse = {
  icon_svg_uri?: string;
};

export const basicLandNames = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;

export const popularLimitedSets = [
  { code: "sos", name: "Secrets of Strixhaven" },
  { code: "tmt", name: "Teenage Mutant Ninja Turtles" },
  { code: "ecl", name: "Lorwyn Eclipsed" },
  { code: "tla", name: "Avatar: The Last Airbender" },
  { code: "fdn", name: "Foundations" },
  { code: "dft", name: "Aetherdrift" },
  { code: "tdm", name: "Tarkir: Dragonstorm" },
  { code: "fin", name: "Final Fantasy" },
  { code: "eoe", name: "Edge of Eternities" },
  { code: "blb", name: "Bloomburrow" },
  { code: "dsk", name: "Duskmourn" },
  { code: "otj", name: "Outlaws of Thunder Junction" },
  { code: "mkm", name: "Murders at Karlov Manor" },
  { code: "lci", name: "Lost Caverns of Ixalan" },
  { code: "woe", name: "Wilds of Eldraine" },
  { code: "mom", name: "March of the Machine" },
  { code: "one", name: "Phyrexia: All Will Be One" },
  { code: "bro", name: "The Brothers War" },
  { code: "dmu", name: "Dominaria United" },
  { code: "snc", name: "Streets of New Capenna" },
  { code: "neo", name: "Kamigawa: Neon Dynasty" },
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

export async function fetchSetIcon(setCode: string): Promise<string | undefined> {
  const normalized = setCode.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const response = await fetch(`https://api.scryfall.com/sets/${encodeURIComponent(normalized)}`);
  if (!response.ok) {
    return undefined;
  }

  const result = (await response.json()) as ScryfallSetResponse;
  return result.icon_svg_uri;
}

export function createBooster(cards: CardData[]): CardData[] {
  const commons = cards.filter((card) => card.rarity === "common" && !isBasicLand(card));
  const uncommons = cards.filter((card) => card.rarity === "uncommon");
  const rares = cards.filter((card) => card.rarity === "rare");
  const mythics = cards.filter((card) => card.rarity === "mythic");
  const lands = cards.filter((card) => card.typeLine.toLowerCase().includes("land"));
  const fallback = cards.filter((card) => !isBasicLand(card));

  return [
    ...pickMany(commons.length ? commons : fallback, 6),
    ...pickMany(commons.length ? commons : fallback, 1),
    ...pickMany(uncommons.length ? uncommons : fallback, 3),
    ...pickWildcardSlot({ commons, uncommons, rares, mythics, fallback }, "play"),
    ...pickRareSlot(rares, mythics, fallback),
    ...pickMany(lands.length ? lands : fallback, 1),
    ...pickWildcardSlot({ commons, uncommons, rares, mythics, fallback }, "foil"),
  ];
}

export function createSealedPool(cardsBySet: Record<string, CardData[]>, packs: PackRequest[]) {
  return createSealedPacks(cardsBySet, packs).flatMap((pack) => pack.cards);
}

export function createSealedPacks(cardsBySet: Record<string, CardData[]>, packs: PackRequest[]): SealedPack[] {
  return packs.map((pack) => ({
    setCode: pack.setCode.toLowerCase(),
    cards: createBooster(cardsBySet[pack.setCode.toLowerCase()] ?? []),
  }));
}

export function createBonusRare(
  cards: CardData[],
  options: { mythicOnly?: boolean; creaturesOnly?: boolean } = {},
) {
  const eligibleCards = cards.filter((card) =>
    !isBasicLand(card) &&
    (!options.creaturesOnly || card.typeLine.toLowerCase().includes("creature")),
  );
  const mythics = eligibleCards.filter((card) => card.rarity === "mythic");
  const rares = options.mythicOnly ? [] : eligibleCards.filter((card) => card.rarity === "rare");
  if (rares.length === 0 && mythics.length === 0) {
    return undefined;
  }
  return pickRareSlot(rares, mythics, [])[0];
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
    .forEach((theme) => {
      let themeTotal = 0;
      theme.deck.forEach((line) => {
        const name = isVariableJumpstartSlot(line.name)
          ? replacementLandForJumpstartTheme(theme)
          : line.name;
        cards.set(name, (cards.get(name) ?? 0) + line.quantity);
        themeTotal += line.quantity;
      });
      if (themeTotal < 20) {
        const name = replacementLandForJumpstartTheme(theme);
        cards.set(name, (cards.get(name) ?? 0) + 20 - themeTotal);
      }
    });

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

function pickRareSlot(rares: CardData[], mythics: CardData[], fallback: CardData[]) {
  const pool = mythics.length && Math.random() < 0.125 ? mythics : rares.length ? rares : mythics;
  return pickMany(pool.length ? pool : fallback, 1);
}

function pickWildcardSlot(
  pools: {
    commons: CardData[];
    uncommons: CardData[];
    rares: CardData[];
    mythics: CardData[];
    fallback: CardData[];
  },
  slot: "play" | "foil",
) {
  const roll = Math.random();
  const thresholds =
    slot === "play"
      ? [
          { max: 0.125, cards: pools.commons },
          { max: 0.75, cards: pools.uncommons },
          { max: 0.96, cards: pools.rares },
          { max: 1, cards: pools.mythics },
        ]
      : [
          { max: 0.62, cards: pools.commons },
          { max: 0.92, cards: pools.uncommons },
          { max: 0.985, cards: pools.rares },
          { max: 1, cards: pools.mythics },
        ];
  const selected = thresholds.find((threshold) => roll <= threshold.max)?.cards ?? pools.fallback;
  return pickMany(selected.length ? selected : pools.fallback, 1);
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

function replacementLandForJumpstartTheme(theme: JumpstartTheme) {
  const existingLand = theme.deck.find((line) =>
    basicLandNames.includes(line.name as (typeof basicLandNames)[number]),
  );
  if (existingLand) {
    return existingLand.name;
  }

  const colorToLand: Partial<Record<JumpstartTheme["color"], (typeof basicLandNames)[number]>> = {
    W: "Plains",
    U: "Island",
    B: "Swamp",
    R: "Mountain",
    G: "Forest",
  };
  return colorToLand[theme.color] ?? "Plains";
}
