export type ZoneId =
  | "library"
  | "hand"
  | "battlefield"
  | "graveyard"
  | "exile"
  | "command"
  | "sideboard"
  | "tokenBank";

export type CounterType =
  | "+1/+1"
  | "-1/-1"
  | "loyalty"
  | "charge"
  | "shield"
  | "stun"
  | "flying"
  | "custom";

export type CounterMap = Partial<Record<CounterType, number>>;

export type BattlefieldLane = "creatures" | "noncreatures" | "lands";

export type BattlefieldLayout = "lanes" | "free";

export type CardData = {
  id: string;
  name: string;
  typeLine: string;
  oracleText: string;
  manaCost?: string;
  cmc: number;
  imageUrl?: string;
  backImageUrl?: string;
  scryfallUri?: string;
  relatedTokens?: Array<{
    id: string;
    name: string;
  }>;
};

export type CardInstance = {
  instanceId: string;
  cardId: string;
  name: string;
  zone: ZoneId;
  owner: "you";
  tapped: boolean;
  counters: CounterMap;
  faceDown: boolean;
  displayBack?: boolean;
  isToken: boolean;
  isGenerated: boolean;
  originalZone?: ZoneId;
  zoneOrder?: number;
  battlefieldLane: BattlefieldLane;
  battlefieldOrder?: number;
  battlefieldPosition: {
    x: number;
    y: number;
  };
};

export type DeckLine = {
  quantity: number;
  name: string;
  section: "main" | "sideboard" | "commander";
  setCode?: string;
  collectorNumber?: string;
};

export type GameAction = {
  id: string;
  text: string;
  at: string;
};

export type GameState = {
  cardsById: Record<string, CardData>;
  instances: CardInstance[];
  life: number;
  poison: number;
  energy: number;
  turn: number;
  activeZone: ZoneId;
  selectedId?: string;
  actions: GameAction[];
  battlefieldLayout: BattlefieldLayout;
  commanderDamage: Record<string, number>;
  commanderTax: number;
};

export type PublicCard = {
  instanceId: string;
  cardId: string;
  name: string;
  zone: ZoneId;
  tapped: boolean;
  counters: CounterMap;
  faceDown: boolean;
  displayBack?: boolean;
  isToken: boolean;
  isGenerated: boolean;
  originalZone?: ZoneId;
  zoneOrder?: number;
  battlefieldLane: BattlefieldLane;
  battlefieldOrder?: number;
  battlefieldPosition: {
    x: number;
    y: number;
  };
};

export type PublicPlayerState = {
  playerId: string;
  playerName: string;
  roomCode: string;
  cardsById: Record<string, CardData>;
  publicCards: PublicCard[];
  zoneCounts: Record<ZoneId, number>;
  life: number;
  poison: number;
  energy: number;
  turn: number;
  battlefieldLayout: BattlefieldLayout;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  at: string;
};

export type LobbyWireMessage =
  | {
      type: "join" | "leave";
      playerId: string;
      playerName: string;
      roomCode: string;
    }
  | {
      type: "state";
      playerId: string;
      state: PublicPlayerState;
    }
  | {
      type: "chat";
      playerId: string;
      message: ChatMessage;
    }
  | {
      type: "action";
      playerId: string;
      action: GameAction;
    };

export type ScryfallCard = {
  id: string;
  name: string;
  type_line?: string;
  oracle_text?: string;
  mana_cost?: string;
  cmc?: number;
  scryfall_uri?: string;
  all_parts?: Array<{
    id: string;
    component?: string;
    name: string;
    type_line?: string;
  }>;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    art_crop?: string;
  };
  card_faces?: Array<{
    name?: string;
    type_line?: string;
    oracle_text?: string;
    mana_cost?: string;
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
    };
  }>;
};
