type MoxfieldBoardCard = {
  quantity?: number;
  card?: {
    name?: string;
  };
};

type MoxfieldDeck = {
  name?: string;
  commanders?: Record<string, MoxfieldBoardCard>;
  mainboard?: Record<string, MoxfieldBoardCard>;
  sideboard?: Record<string, MoxfieldBoardCard>;
};

type ArchidektCard = {
  quantity?: number;
  categories?: string[];
  card?: {
    oracleCard?: {
      name?: string;
    };
    name?: string;
  };
};

type ArchidektDeck = {
  name?: string;
  cards?: ArchidektCard[];
};

export async function importDeckFromUrl(url: string): Promise<{
  name: string;
  decklist: string;
}> {
  const parsed = new URL(url.trim());

  if (parsed.hostname.includes("moxfield.com")) {
    return importMoxfieldDeck(parsed);
  }

  if (parsed.hostname.includes("archidekt.com")) {
    return importArchidektDeck(parsed);
  }

  throw new Error("Paste an Archidekt or Moxfield deck URL.");
}

async function importMoxfieldDeck(url: URL) {
  const id = url.pathname.split("/").filter(Boolean).pop();
  if (!id) {
    throw new Error("Could not find the Moxfield deck id.");
  }

  const response = await fetch(`/moxfield-api/v3/decks/all/${id}`);
  if (!response.ok) {
    throw new Error(`Moxfield returned ${response.status}.`);
  }

  const deck = (await response.json()) as MoxfieldDeck;
  return {
    name: deck.name ?? "Moxfield deck",
    decklist: [
      boardToText("Commander", deck.commanders),
      boardToText("Deck", deck.mainboard),
      boardToText("Sideboard", deck.sideboard),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

async function importArchidektDeck(url: URL) {
  const id = url.pathname
    .split("/")
    .filter(Boolean)
    .find((part) => /^\d+$/.test(part));

  if (!id) {
    throw new Error("Could not find the Archidekt deck id.");
  }

  const deck = await fetchArchidektDeck(id);
  const commander: string[] = [];
  const main: string[] = [];
  const sideboard: string[] = [];

  deck.cards?.forEach((entry) => {
    const name = entry.card?.oracleCard?.name ?? entry.card?.name;
    const quantity = entry.quantity ?? 1;
    if (!name) {
      return;
    }

    const line = `${quantity} ${name}`;
    const categories = entry.categories?.map((category) => category.toLowerCase()) ?? [];

    if (categories.some((category) => category.includes("commander"))) {
      commander.push(line);
    } else if (categories.some((category) => category.includes("sideboard"))) {
      sideboard.push(line);
    } else {
      main.push(line);
    }
  });

  return {
    name: deck.name ?? "Archidekt deck",
    decklist: [
      commander.length ? `Commander\n${commander.join("\n")}` : "",
      main.length ? `Deck\n${main.join("\n")}` : "",
      sideboard.length ? `Sideboard\n${sideboard.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

async function fetchArchidektDeck(id: string) {
  try {
    const response = await fetch(`/archidekt-api/decks/${id}/`, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Archidekt returned ${response.status}.`);
    }

    return (await response.json()) as ArchidektDeck;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Archidekt import failed: ${error.message}. Make sure the deck is public, then try Load URL again.`
        : "Archidekt import failed. Make sure the deck is public, then try Load URL again.",
    );
  }
}

function boardToText(label: string, board?: Record<string, MoxfieldBoardCard>) {
  const lines = Object.values(board ?? {})
    .map((entry) => {
      const name = entry.card?.name;
      return name ? `${entry.quantity ?? 1} ${name}` : "";
    })
    .filter(Boolean);

  return lines.length ? `${label}\n${lines.join("\n")}` : "";
}
