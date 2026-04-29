import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type TouchEvent,
} from "react";
import {
  buildInstances,
  parseDeckList,
  shuffleCards,
  uniqueCardNames,
} from "./deck";
import { importDeckFromUrl } from "./deckImporters";
import {
  createLobbyTransport,
  getConfiguredRelayUrl,
  getSavedRelayUrl,
  saveRelayUrl,
  type LobbyTransport,
  type LobbyTransportStatus,
} from "./multiplayer";
import { preconDecks, randomPrecon } from "./precons";
import archidektCatalog from "./archidekt-precons.json";
import {
  basicLandNames,
  cardPoolToDecklist,
  createBooster,
  createBonusRare,
  createSealedPacks,
  fetchSetCards,
  fetchSetIcon,
  groupLimitedCards,
  jumpstartDecklist,
  jumpstartThemes,
  popularLimitedSets,
  randomJumpstartThemeIds,
  type JumpstartTheme,
  type PackRequest,
} from "./limited";
import {
  fetchCardFromScryfallInput,
  fetchCardsForDeckLines,
  fetchRelatedTokensForCards,
} from "./scryfall";
import type {
  CardData,
  CardInstance,
  BattlefieldLayout,
  BattlefieldLane,
  ChatMessage,
  CounterType,
  GameAction,
  GameState,
  LobbyWireMessage,
  PublicCard,
  PublicPlayerState,
  ZoneId,
} from "./types";

const zones: Array<{ id: ZoneId; label: string; helper: string }> = [
  { id: "library", label: "Library", helper: "Draw, scry, search" },
  { id: "hand", label: "Hand", helper: "Private testing space" },
  { id: "battlefield", label: "Battlefield", helper: "Tap, counters, tokens" },
  { id: "graveyard", label: "Graveyard", helper: "Spent spells" },
  { id: "exile", label: "Exile", helper: "Removed cards" },
  { id: "command", label: "Command", helper: "Commander zone" },
  { id: "sideboard", label: "Sideboard", helper: "Maybeboard" },
  { id: "tokenBank", label: "Tokens", helper: "Reusable token bank" },
];

const publicZones = new Set<ZoneId>(["battlefield", "graveyard", "exile", "command"]);
const privateZones = new Set<ZoneId>(["library", "hand", "sideboard"]);
const maxPassSeats = 4;
const battlefieldLanes: Array<{ id: BattlefieldLane; label: string; helper: string }> = [
  { id: "creatures", label: "Creatures", helper: "Attackers, blockers, tokens" },
  { id: "noncreatures", label: "Artifacts / enchantments", helper: "Engines, rocks, walkers" },
  { id: "lands", label: "Lands", helper: "Mana base" },
];
const counterTypes: CounterType[] = [
  "+1/+1",
  "-1/-1",
  "loyalty",
  "charge",
  "shield",
  "stun",
  "flying",
  "custom",
];

const tokenPresets: Array<{
  name: string;
  typeLine: string;
  oracleText: string;
}> = [
  { name: "Treasure Token", typeLine: "Token Artifact - Treasure", oracleText: "Tap, Sacrifice this artifact: Add one mana of any color." },
  { name: "Clue Token", typeLine: "Token Artifact - Clue", oracleText: "2, Sacrifice this artifact: Draw a card." },
  { name: "Food Token", typeLine: "Token Artifact - Food", oracleText: "2, Tap, Sacrifice this artifact: You gain 3 life." },
  { name: "Blood Token", typeLine: "Token Artifact - Blood", oracleText: "1, Tap, Discard a card, Sacrifice this artifact: Draw a card." },
  { name: "1/1 Soldier Token", typeLine: "Token Creature - Soldier", oracleText: "A 1/1 white Soldier creature token." },
  { name: "2/2 Zombie Token", typeLine: "Token Creature - Zombie", oracleText: "A 2/2 black Zombie creature token." },
  { name: "3/3 Beast Token", typeLine: "Token Creature - Beast", oracleText: "A 3/3 green Beast creature token." },
  { name: "Custom Token", typeLine: "Token Creature", oracleText: "A placeholder token for quick board testing." },
];

const keywordReference = [
  ["Deathtouch", "Any damage this deals to a creature is enough to destroy it."],
  ["Defender", "This creature can't attack."],
  ["Double strike", "This deals first-strike and regular combat damage."],
  ["First strike", "This deals combat damage before creatures without first strike."],
  ["Flying", "Can be blocked only by creatures with flying or reach."],
  ["Haste", "Can attack and tap as soon as it comes under your control."],
  ["Hexproof", "Can't be the target of spells or abilities opponents control."],
  ["Indestructible", "Damage and destroy effects don't destroy it."],
  ["Lifelink", "Damage dealt by this also causes its controller to gain that much life."],
  ["Menace", "Can't be blocked except by two or more creatures."],
  ["Reach", "Can block creatures with flying."],
  ["Trample", "Excess combat damage can be assigned to the defending player or planeswalker."],
  ["Vigilance", "Attacking doesn't cause this creature to tap."],
  ["Ward", "Opponent must pay the ward cost or the spell/ability is countered."],
] as const;

const initialState: GameState = {
  cardsById: {},
  instances: [],
  life: 40,
  poison: 0,
  energy: 0,
  turn: 1,
  activeZone: "hand",
  actions: [],
  battlefieldLayout: "lanes",
  commanderDamage: {},
  commanderTax: 0,
};

const autosaveKey = "mtg-duels-autosave-v1";
const playerIdKey = "mtg-duels-player-id";

type AutosavedSession = {
  version: 1;
  savedAt: number;
  playerName: string;
  roomCode: string;
  game: GameState;
};

type LeftTool = "room" | "deck" | "limited" | "actions";
type RightTool = "card" | "damage" | "log" | "chat";
type PlayMode = "solo" | "pass" | "multiplayer";
type TabletopSide = "top" | "bottom" | "left" | "right";
type TabletopSeatGroups = Record<TabletopSide, PublicPlayerState[]>;
type LocalSeat = {
  id: string;
  name: string;
  game: GameState;
};
type LimitedMode = "jumpstart" | "sealed" | "draft";
type LimitedCardSource = "pool" | "deck" | "draft";
type LimitedSelection = {
  card: CardData;
  source: LimitedCardSource;
  draftIndex?: number;
  displayBack?: boolean;
};
type SealedPackView = {
  id: string;
  label: string;
  setCode: string;
  cards: CardData[];
  opened: boolean;
  isBonus?: boolean;
  iconUrl?: string;
};
type BonusRareRarityMode = "rare-mythic" | "mythic";
type ManaColor = "W" | "U" | "B" | "R" | "G";
type DeckStats = {
  totalCards: number;
  averageManaValue: number;
  manaCosts: Record<ManaColor, number>;
  manaProduction: Record<ManaColor, number>;
  curve: Array<{ label: string; count: number }>;
};
type JumpstartFilter = {
  product: string;
  color: string;
};
type JumpstartRandomScope = "selected" | "same-set" | "all";

const manaColors: ManaColor[] = ["W", "U", "B", "R", "G"];
const defaultJumpstartFilter: JumpstartFilter = { product: "All", color: "All" };

function App() {
  const [autosavedSession, setAutosavedSession] = useState(readAutosavedSession);
  const [initialPrecon] = useState(randomPrecon);
  const [playerId] = useState(getOrCreatePlayerId);
  const [playerName, setPlayerName] = useState(autosavedSession?.playerName ?? "Player");
  const [roomCode, setRoomCode] = useState(autosavedSession?.roomCode ?? createRoomCode);
  const [isConnected, setIsConnected] = useState(false);
  const [mode, setMode] = useState<PlayMode>("solo");
  const [passSeats, setPassSeats] = useState<LocalSeat[]>(() => [
    { id: "local-player-1", name: "Player 1", game: autosavedSession?.game ?? initialState },
    { id: "local-player-2", name: "Player 2", game: initialState },
  ]);
  const [activePassSeatId, setActivePassSeatId] = useState("local-player-1");
  const [selectedPassSeatId, setSelectedPassSeatId] = useState("local-player-2");
  const [passDeviceSeatId, setPassDeviceSeatId] = useState<string>();
  const [isPrivateHidden, setIsPrivateHidden] = useState(false);
  const [peersById, setPeersById] = useState<Record<string, PublicPlayerState>>({});
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [configuredRelayUrl] = useState(getConfiguredRelayUrl);
  const [relayUrl, setRelayUrl] = useState(getSavedRelayUrl);
  const [isRelaySettingsOpen, setIsRelaySettingsOpen] = useState(false);
  const [transportStatus, setTransportStatus] = useState<LobbyTransportStatus>("local");
  const transportRef = useRef<LobbyTransport | undefined>(undefined);
  const gameRef = useRef<GameState>(autosavedSession?.game ?? initialState);
  const autosaveTimeoutRef = useRef<number | undefined>(undefined);
  const remoteActionIdsRef = useRef(new Set<string>());
  const sharedActionIdsRef = useRef(new Set<string>());
  const [selectedPreconId, setSelectedPreconId] = useState(initialPrecon.id);
  const [deckInput, setDeckInput] = useState(initialPrecon.decklist);
  const [deckUrl, setDeckUrl] = useState("");
  const [selectedCatalogUrl, setSelectedCatalogUrl] = useState(
    archidektCatalog.decks[0]?.url ?? "",
  );
  const [limitedMode, setLimitedMode] = useState<LimitedMode>("jumpstart");
  const [jumpstartThemeIds, setJumpstartThemeIds] = useState(() =>
    randomJumpstartThemeIds(),
  );
  const [jumpstartFilters, setJumpstartFilters] = useState<[JumpstartFilter, JumpstartFilter]>([
    defaultJumpstartFilter,
    defaultJumpstartFilter,
  ]);
  const [jumpstartRandomScope, setJumpstartRandomScope] =
    useState<JumpstartRandomScope>("selected");
  const [limitedSetCode, setLimitedSetCode] = useState<string>(popularLimitedSets[0].code);
  const [sealedPackSetCodes, setSealedPackSetCodes] = useState<string[]>(() =>
    Array.from({ length: 6 }, () => popularLimitedSets[0].code),
  );
  const [draftPackSetCodes, setDraftPackSetCodes] = useState<string[]>(() =>
    Array.from({ length: 3 }, () => popularLimitedSets[0].code),
  );
  const [limitedCardsBySet, setLimitedCardsBySet] = useState<Record<string, CardData[]>>({});
  const [limitedPool, setLimitedPool] = useState<CardData[]>([]);
  const [limitedDeck, setLimitedDeck] = useState<CardData[]>([]);
  const [sealedPacks, setSealedPacks] = useState<SealedPackView[]>([]);
  const [includeBonusRare, setIncludeBonusRare] = useState(false);
  const [bonusRareFromOtherSet, setBonusRareFromOtherSet] = useState(false);
  const [bonusRareSetCode, setBonusRareSetCode] = useState("");
  const [bonusRareCreaturesOnly, setBonusRareCreaturesOnly] = useState(false);
  const [bonusRareRarityMode, setBonusRareRarityMode] =
    useState<BonusRareRarityMode>("rare-mythic");
  const [limitedSetIcons, setLimitedSetIcons] = useState<Record<string, string>>({});
  const [limitedLands, setLimitedLands] = useState<Record<string, number>>(() =>
    Object.fromEntries(basicLandNames.map((name) => [name, 0])),
  );
  const [limitedStatus, setLimitedStatus] = useState(
    "Pick Jumpstart themes or open a Limited pool.",
  );
  const [isLimitedLoading, setIsLimitedLoading] = useState(false);
  const [draftPlayers, setDraftPlayers] = useState(4);
  const [draftSeats, setDraftSeats] = useState<CardData[][]>([]);
  const [draftPacks, setDraftPacks] = useState<CardData[][]>([]);
  const [draftRound, setDraftRound] = useState(0);
  const [limitedSelection, setLimitedSelection] = useState<LimitedSelection>();
  const [game, setGame] = useState<GameState>(autosavedSession?.game ?? initialState);
  const [status, setStatus] = useState(() =>
    autosavedSession
      ? `Autosaved board restored from ${formatSavedAt(autosavedSession.savedAt)}.`
      : "Paste a decklist, import, then draw.",
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isUrlLoading, setIsUrlLoading] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [libraryView, setLibraryView] = useState<"hidden" | "scry" | "search">("hidden");
  const [scryCount, setScryCount] = useState(0);
  const [layoutScale, setLayoutScale] = useState(1);
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => !isCompactViewport());
  const [rightPanelOpen, setRightPanelOpen] = useState(() => !isCompactViewport());
  const [leftTool, setLeftTool] = useState<LeftTool>("deck");
  const [rightTool, setRightTool] = useState<RightTool>("card");
  const [cardScale, setCardScale] = useState(1);
  const [freeBattlefieldExpanded, setFreeBattlefieldExpanded] = useState(false);
  const [isTabletopMode, setIsTabletopMode] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{
    card: CardData;
    imageUrl?: string;
    x: number;
    y: number;
    faceDown?: boolean;
  }>();
  const [xValue, setXValue] = useState(3);
  const [diceSides, setDiceSides] = useState(20);
  const [latestRoll, setLatestRoll] = useState<{ sides: number; result: number }>();
  const [mulliganPenalty, setMulliganPenalty] = useState(0);
  const [tokenName, setTokenName] = useState(tokenPresets[0].name);
  const [tokenQuantity, setTokenQuantity] = useState(1);
  const [spawnInput, setSpawnInput] = useState("");
  const [isSpawnLoading, setIsSpawnLoading] = useState(false);
  const [isReferenceOpen, setIsReferenceOpen] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState<{
    playerId: string;
    cardId: string;
  }>();
  const peers = useMemo(
    () => Object.values(peersById).sort((a, b) => a.playerName.localeCompare(b.playerName)),
    [peersById],
  );
  const activePassSeat =
    passSeats.find((seat) => seat.id === activePassSeatId) ?? passSeats[0] ?? {
      id: "local-player-1",
      name: "Player 1",
      game: initialState,
    };
  const passDeviceSeat = passDeviceSeatId
    ? passSeats.find((seat) => seat.id === passDeviceSeatId)
    : undefined;
  const passTargets = passSeats.filter((seat) => seat.id !== activePassSeatId);
  const selectedPassSeat =
    passTargets.find((seat) => seat.id === selectedPassSeatId) ?? passTargets[0];
  const passOpponentStates = useMemo(
    () =>
      passSeats
        .filter((seat) => seat.id !== activePassSeatId)
        .map((seat) => buildPublicState(seat.game, seat.id, seat.name, "LOCAL")),
    [activePassSeatId, passSeats],
  );
  const visibleOpponents = mode === "pass" ? passOpponentStates : peers;
  const remotePlayersById = useMemo(
    () =>
      Object.fromEntries(
        [...peers, ...passOpponentStates].map((player) => [player.playerId, player]),
      ),
    [passOpponentStates, peers],
  );
  const localTablePlayer = useMemo(
    () =>
      mode === "pass"
        ? buildPublicState(game, activePassSeat.id, activePassSeat.name, "LOCAL")
        : buildPublicState(game, playerId, playerName, roomCode),
    [activePassSeat.id, activePassSeat.name, game, mode, playerId, playerName, roomCode],
  );
  const tabletopPlayers = useMemo(() => {
    if (mode === "pass") {
      return [localTablePlayer, ...passOpponentStates];
    }

    if (mode === "multiplayer") {
      return [localTablePlayer, ...peers];
    }

    return [localTablePlayer];
  }, [localTablePlayer, mode, passOpponentStates, peers]);
  const commanderDamageSources = useMemo(() => {
    if (mode === "pass") {
      return passSeats.map((seat) => ({
        key: `player-${seat.id}`,
        label: `${seat.name}'s commander`,
      }));
    }

    if (mode !== "multiplayer") {
      return [
        { key: "solo-opponent", label: "Opponent commander" },
        { key: `player-${playerId}`, label: "Your commander" },
      ];
    }

    return [
      { key: `player-${playerId}`, label: `${playerName.trim() || "You"}'s commander` },
      ...peers.map((peer) => ({
        key: `player-${peer.playerId}`,
        label: `${peer.playerName}'s commander`,
      })),
    ];
  }, [mode, passSeats, peers, playerId, playerName]);
  const connectedRoomLabel =
    mode === "pass"
      ? `${activePassSeat.name}'s seat`
      : isConnected
        ? `Room ${roomCode.toUpperCase()}`
        : "Goldfish sandbox";
  const relayEnabled = Boolean(relayUrl.trim());
  const hasConfiguredRelay = Boolean(configuredRelayUrl);
  const canEditRelayUrl = !hasConfiguredRelay && isRelaySettingsOpen;
  const transportLabel = relayEnabled ? "Cross-device relay" : "This browser";
  const transportStatusLabel =
    transportStatus === "connected"
      ? "relay connected"
      : transportStatus === "connecting"
        ? "relay connecting"
      : transportStatus === "error"
        ? "relay unavailable"
        : "local tabs";
  const canUseDraftMode = mode === "multiplayer" && isConnected && peers.length + 1 >= 2;
  const showLimitedWorkspace =
    leftTool === "limited" &&
    (limitedMode === "sealed" || limitedMode === "draft") &&
    (limitedPool.length > 0 || limitedDeck.length > 0 || sealedPacks.length > 0 || draftPacks[0]?.length > 0);
  const canUseTabletopMode =
    (mode === "multiplayer" || mode === "pass") && tabletopPlayers.length >= 2;
  const canShowTabletopView = canUseTabletopMode && !showLimitedWorkspace;
  const isTabletopView = canShowTabletopView && isTabletopMode;
  const jumpstartProducts = useMemo(
    () => ["All", ...Array.from(new Set(jumpstartThemes.map((theme) => theme.product ?? "Jumpstart")))],
    [],
  );
  const filteredJumpstartThemesBySlot = useMemo(
    () => jumpstartFilters.map(filterJumpstartThemesBy) as [JumpstartTheme[], JumpstartTheme[]],
    [jumpstartFilters],
  );
  const deckStats = useMemo(() => buildDeckStatsFromGame(game), [game]);

  const selected = game.instances.find((card) => card.instanceId === game.selectedId);
  const selectedData = selected ? game.cardsById[selected.cardId] : undefined;
  const selectedRemoteCard = selectedRemote
    ? remotePlayersById[selectedRemote.playerId]?.publicCards.find(
        (card) => card.instanceId === selectedRemote.cardId,
      )
    : undefined;
  const selectedRemotePlayer = selectedRemote ? remotePlayersById[selectedRemote.playerId] : undefined;
  const selectedRemoteData =
    selectedRemoteCard && selectedRemotePlayer
      ? selectedRemotePlayer.cardsById[selectedRemoteCard.cardId]
      : undefined;
  const visibleZones = useMemo(
    () =>
      zones.map((zone) => ({
        ...zone,
        cards: orderedZoneCards(
          game.instances.filter((card) => card.zone === zone.id),
          zone.id,
        ),
      })),
    [game.instances],
  );

  const postLobbyMessage = useCallback((message: LobbyWireMessage) => {
    transportRef.current?.postMessage(message);
  }, []);

  const buildJoinMessage = useCallback(
    (): LobbyWireMessage => ({
      type: "join",
      playerId,
      playerName,
      roomCode: roomCode.toUpperCase(),
    }),
    [playerId, playerName, roomCode],
  );

  const buildStateMessage = useCallback(
    (): LobbyWireMessage => ({
      type: "state",
      playerId,
      state: buildPublicState(gameRef.current, playerId, playerName, roomCode),
    }),
    [playerId, playerName, roomCode],
  );

  const getLobbyOpenMessages = useCallback(
    () => [buildJoinMessage(), buildStateMessage()],
    [buildJoinMessage, buildStateMessage],
  );

  const publishState = useCallback(() => {
    postLobbyMessage(buildStateMessage());
  }, [buildStateMessage, postLobbyMessage]);

  const handleLobbyMessage = useCallback(
    (message: LobbyWireMessage) => {
      if (!message || message.playerId === playerId) {
        return;
      }

      if (message.type === "state" && message.state.roomCode === roomCode.toUpperCase()) {
        setPeersById((current) => ({
          ...current,
          [message.playerId]: message.state,
        }));
      }

      if (message.type === "join" && message.roomCode === roomCode.toUpperCase()) {
        publishState();
      }

      if (message.type === "leave") {
        setPeersById((current) => {
          const next = { ...current };
          delete next[message.playerId];
          return next;
        });
      }

      if (message.type === "chat") {
        setChatMessages((current) =>
          current.some((chat) => chat.id === message.message.id)
            ? current
            : [...current, message.message].slice(-60),
        );
      }

      if (message.type === "action") {
        remoteActionIdsRef.current.add(message.action.id);
        setGame((current) =>
          current.actions.some((action) => action.id === message.action.id)
            ? current
            : { ...current, actions: [message.action, ...current.actions] },
        );
      }
    },
    [playerId, publishState, roomCode],
  );

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    if (!canUseTabletopMode && isTabletopMode) {
      setIsTabletopMode(false);
    }
  }, [canUseTabletopMode, isTabletopMode]);

  useEffect(() => {
    if (!isTabletopMode || typeof window === "undefined") {
      return;
    }

    function leaveCompactTabletop() {
      if (isCompactViewport()) {
        setIsTabletopMode(false);
      }
    }

    leaveCompactTabletop();
    window.addEventListener("resize", leaveCompactTabletop);
    return () => window.removeEventListener("resize", leaveCompactTabletop);
  }, [isTabletopMode]);

  useEffect(() => {
    if (
      passSeats.some((seat) => seat.id === selectedPassSeatId && seat.id !== activePassSeatId)
    ) {
      return;
    }

    setSelectedPassSeatId(passSeats.find((seat) => seat.id !== activePassSeatId)?.id ?? "");
  }, [activePassSeatId, passSeats, selectedPassSeatId]);

  useEffect(() => {
    if (mode !== "pass") {
      return;
    }

    setPassSeats((current) =>
      current.map((seat) => (seat.id === activePassSeatId ? { ...seat, game } : seat)),
    );
  }, [activePassSeatId, game, mode]);

  useEffect(() => {
    if (!isPrivateHidden) {
      return;
    }

    setHoverPreview(undefined);
    setSelectedRemote(undefined);
    setLimitedSelection(undefined);
    setGame((current) =>
      current.selectedId ? { ...current, selectedId: undefined } : current,
    );
  }, [isPrivateHidden]);

  useEffect(() => {
    autosaveTimeoutRef.current = window.setTimeout(() => {
      const nextAutosave: AutosavedSession = {
        version: 1,
        savedAt: Date.now(),
        playerName: playerName.trim() || "Player",
        roomCode: roomCode.trim().toUpperCase() || createRoomCode(),
        game,
      };
      saveAutosavedSession(nextAutosave);
      setAutosavedSession(nextAutosave);
      autosaveTimeoutRef.current = undefined;
    }, 250);

    return () => {
      if (autosaveTimeoutRef.current !== undefined) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, [game, playerName, roomCode]);

  useEffect(() => {
    if (!isConnected) {
      transportRef.current?.close();
      transportRef.current = undefined;
      setTransportStatus("local");
      return;
    }

    const transport = createLobbyTransport({
      roomCode,
      relayUrl,
      onMessage: handleLobbyMessage,
      onStatusChange: setTransportStatus,
      getOpenMessages: getLobbyOpenMessages,
    });
    transportRef.current = transport;

    if (!relayUrl.trim()) {
      postLobbyMessage(buildJoinMessage());
      publishState();
    }

    return () => {
      transport.postMessage({
        type: "leave",
        playerId,
        playerName,
        roomCode: roomCode.toUpperCase(),
      } satisfies LobbyWireMessage);
      transport.close();
      if (transportRef.current === transport) {
        transportRef.current = undefined;
      }
    };
  }, [
    buildJoinMessage,
    getLobbyOpenMessages,
    handleLobbyMessage,
    isConnected,
    playerId,
    playerName,
    postLobbyMessage,
    publishState,
    relayUrl,
    roomCode,
  ]);

  useEffect(() => {
    if (isConnected) {
      publishState();
    }
  }, [game, isConnected, publishState]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    postLobbyMessage(buildJoinMessage());
    publishState();
  }, [buildJoinMessage, isConnected, playerName, postLobbyMessage, publishState]);

  useEffect(() => {
    if (limitedMode === "draft" && !canUseDraftMode) {
      setLimitedMode("sealed");
      setLimitedStatus("Draft needs a lobby with at least two connected players.");
    }
  }, [canUseDraftMode, limitedMode]);

  useEffect(() => {
    setJumpstartThemeIds((current) =>
      current.map((id, index) => {
        const themes = filteredJumpstartThemesBySlot[index];
        if (themes.length === 0 || themes.some((theme) => theme.id === id)) {
          return id;
        }
        return themes[0].id;
      }),
    );
  }, [filteredJumpstartThemesBySlot]);

  useEffect(() => {
    const action = game.actions[0];
    if (!isConnected || !action || remoteActionIdsRef.current.has(action.id)) {
      return;
    }

    if (sharedActionIdsRef.current.has(action.id) || !isPublicActionText(action.text)) {
      return;
    }

    sharedActionIdsRef.current.add(action.id);
    const prefixedAction = {
      ...action,
      text: action.text.startsWith(`${playerName}: `)
        ? action.text
        : `${playerName}: ${action.text}`,
    };
    postLobbyMessage({ type: "action", playerId, action: prefixedAction });
  }, [game.actions, isConnected, playerId, playerName, postLobbyMessage]);

  async function importDeck() {
    await importDeckText(deckInput);
  }

  async function importDeckText(input: string, sourceLabel = "Deck") {
    const lines = parseDeckList(input);
    const names = uniqueCardNames(lines);

    if (names.length === 0) {
      setStatus("No cards found in that list.");
      return;
    }

    setIsLoading(true);
    setStatus(`Fetching ${names.length} cards from Scryfall...`);

    try {
      const { cardsByName, missing } = await fetchCardsForDeckLines(lines);
      const cardsById = Object.fromEntries(
        Array.from(cardsByName.values()).map((card) => [card.id, card]),
      );
      const instances = shuffleCards(buildInstances(lines, cardsByName));
      let relatedTokens: CardData[] = [];
      let tokenFetchFailed = false;

      try {
        relatedTokens = await fetchRelatedTokensForCards(Object.values(cardsById));
      } catch {
        tokenFetchFailed = true;
      }

      const relatedTokenCardsById = Object.fromEntries(
        relatedTokens.map((card) => [card.id, card]),
      );
      const tokenBank = buildTokenBankForDeck(instances.length, relatedTokens);

      setGame({
        ...initialState,
        cardsById: { ...cardsById, ...relatedTokenCardsById, ...tokenBank.cards },
        instances: [...tokenBank.instances, ...instances],
        actions: [
          createAction(
            `Imported ${instances.length} cards${tokenBank.instances.length ? ` and ${tokenBank.instances.length} token bank entries` : ""}${missing.length ? `; missing ${missing.join(", ")}` : ""}${tokenFetchFailed ? "; token lookup failed" : ""}.`,
          ),
        ],
      });
      setLibraryView("hidden");
      setScryCount(0);
      setSelectedRemote(undefined);
      setStatus(
        missing.length
          ? `Imported with ${missing.length} missing card name${missing.length === 1 ? "" : "s"}.`
          : `${sourceLabel} imported and shuffled.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function chooseJumpstartTheme(slot: 0 | 1, themeId: string) {
    setJumpstartThemeIds((current) => current.map((id, index) => (index === slot ? themeId : id)));
  }

  function updateJumpstartFilter(slot: 0 | 1, update: Partial<JumpstartFilter>) {
    setJumpstartFilters((current) =>
      current.map((filter, index) =>
        index === slot ? { ...filter, ...update } : filter,
      ) as [JumpstartFilter, JumpstartFilter],
    );
  }

  function randomizeJumpstart() {
    const sources = randomJumpstartSources();
    const nextIds = sources.map((source) => shuffleCards(source)[0]?.id).filter(Boolean);
    if (nextIds.length < 2) {
      setLimitedStatus("No Jumpstart half-decks match those random filters.");
      return;
    }
    setJumpstartThemeIds(nextIds);
    const names = nextIds
      .map((id) => jumpstartThemes.find((theme) => theme.id === id)?.name)
      .filter(Boolean)
      .join(" + ");
    setLimitedStatus(`Random Jumpstart: ${names}.`);
  }

  function randomJumpstartSources(): [JumpstartTheme[], JumpstartTheme[]] {
    if (jumpstartRandomScope === "all") {
      return [jumpstartThemes, jumpstartThemes];
    }

    if (jumpstartRandomScope === "same-set") {
      const firstTheme = jumpstartThemes.find((theme) => theme.id === jumpstartThemeIds[0]);
      const selectedProduct =
        jumpstartFilters[0].product !== "All"
          ? jumpstartFilters[0].product
          : firstTheme?.product ?? jumpstartProducts.find((product) => product !== "All") ?? "All";
      const sameSetFilter = { product: selectedProduct, color: "All" };
      return [filterJumpstartThemesBy(sameSetFilter), filterJumpstartThemesBy(sameSetFilter)];
    }

    return filteredJumpstartThemesBySlot;
  }

  async function importJumpstartDeck() {
    const list = jumpstartDecklist(jumpstartThemeIds);
    setDeckInput(list);
    setSelectedPreconId("");
    setSealedPacks([]);
    setLimitedStatus("Jumpstart decklist is ready in the importer and loading to the table.");
    await importDeckText(list, "Jumpstart deck");
  }

  async function ensureLimitedSets(setCodes: string[]) {
    const uniqueCodes = Array.from(new Set(setCodes.map((code) => code.trim().toLowerCase())));
    const missing = uniqueCodes.filter((code) => !limitedCardsBySet[code]);
    if (missing.length === 0) {
      return limitedCardsBySet;
    }

    const loadedEntries = await Promise.all(
      missing.map(async (code) => [code, await fetchSetCards(code)] as const),
    );
    const next = {
      ...limitedCardsBySet,
      ...Object.fromEntries(loadedEntries),
    };
    setLimitedCardsBySet(next);
    return next;
  }

  async function openSealedPool() {
    const packRequests = sealedPackRequests();
    const packSets = packRequests.map((pack) => pack.setCode);
    if (packSets.some((code) => !code)) {
      setLimitedStatus("Every sealed pack needs a set code.");
      return;
    }

    setIsLimitedLoading(true);
    setLimitedStatus(`Fetching ${Array.from(new Set(packSets)).join(", ").toUpperCase()} cards...`);
    try {
      const bonus = includeBonusRare ? await findBonusRare(packSets) : undefined;
      const cardsBySet = await ensureLimitedSets(packSets);
      const iconBySet = await ensureLimitedSetIcons([
        ...packSets,
        ...(bonus?.setCode ? [bonus.setCode] : []),
      ]);
      const packs = createSealedPacks(cardsBySet, packRequests);
      const packViews: SealedPackView[] = packs.map((pack, index) => ({
        id: `pack-${index}-${pack.setCode}`,
        label: `Pack ${index + 1}`,
        setCode: pack.setCode,
        cards: pack.cards,
        opened: false,
        iconUrl: iconBySet[pack.setCode],
      }));
      if (bonus) {
        packViews.push({
          id: `bonus-${bonus.setCode ?? "random"}`,
          label: "Bonus rare",
          setCode: bonus.setCode ?? "random",
          cards: [bonus],
          opened: false,
          isBonus: true,
          iconUrl: bonus.setCode ? iconBySet[bonus.setCode] : undefined,
        });
      }
      setSealedPacks(packViews);
      setLimitedPool([]);
      setLimitedDeck([]);
      setLimitedLands(Object.fromEntries(basicLandNames.map((name) => [name, 0])));
      setLimitedStatus(
        bonus
          ? `Prepared 6 Play Boosters plus a random ${bonus.rarity ?? "rare"} from ${bonus.setCode?.toUpperCase() ?? "another set"}. Open packs to build your pool.`
          : "Prepared 6 Play Boosters. Open packs to build your pool.",
      );
    } catch (error) {
      setLimitedStatus(error instanceof Error ? error.message : "Could not open sealed pool.");
    } finally {
      setIsLimitedLoading(false);
    }
  }

  async function findBonusRare(packSetCodes: string[]) {
    const options = {
      creaturesOnly: bonusRareCreaturesOnly,
      mythicOnly: bonusRareRarityMode === "mythic",
    };
    const uniquePackCodes = Array.from(new Set(packSetCodes.map((code) => code.toLowerCase())));
    const chosenOtherSet = bonusRareSetCode.trim().toLowerCase();
    const candidates = bonusRareFromOtherSet
      ? chosenOtherSet
        ? [chosenOtherSet]
        : shuffleCards(
            popularLimitedSets
              .map((set) => set.code)
              .filter((code) => !uniquePackCodes.includes(code.toLowerCase())),
          )
      : shuffleCards(uniquePackCodes);

    for (const code of candidates) {
      try {
        const cardsBySet = await ensureLimitedSets([code]);
        const bonus = createBonusRare(cardsBySet[code] ?? [], options);
        if (bonus) {
          return bonus;
        }
      } catch {
        // Some suggested future or supplemental set codes may not exist in Scryfall yet.
      }
    }

    return undefined;
  }

  async function ensureLimitedSetIcons(setCodes: string[]) {
    const uniqueCodes = Array.from(new Set(setCodes.map((code) => code.trim().toLowerCase()).filter(Boolean)));
    const missing = uniqueCodes.filter((code) => !limitedSetIcons[code]);
    if (missing.length === 0) {
      return limitedSetIcons;
    }

    const loadedEntries = await Promise.all(
      missing.map(async (code) => [code, await fetchSetIcon(code)] as const),
    );
    const next = {
      ...limitedSetIcons,
      ...Object.fromEntries(loadedEntries.filter((entry): entry is [string, string] => Boolean(entry[1]))),
    };
    setLimitedSetIcons(next);
    return next;
  }

  function sealedPackRequests(): PackRequest[] {
    return sealedPackSetCodes.map((setCode) => ({
      setCode: setCode.trim().toLowerCase(),
    }));
  }

  function draftPackRequests(): PackRequest[] {
    return draftPackSetCodes.map((setCode) => ({
      setCode: setCode.trim().toLowerCase(),
    }));
  }

  function applySealedSetToAll() {
    const code = limitedSetCode.trim().toLowerCase();
    if (!code) {
      setLimitedStatus("Enter a set code before applying it to every sealed pack.");
      return;
    }
    setLimitedSetCode(code);
    setSealedPackSetCodes(Array.from({ length: 6 }, () => code));
    setLimitedStatus(`All sealed packs set to ${code.toUpperCase()}.`);
  }

  function openSealedPack(packId: string) {
    const pack = sealedPacks.find((item) => item.id === packId);
    if (!pack || pack.opened) {
      return;
    }

    setSealedPacks((current) =>
      current.map((item) => (item.id === packId ? { ...item, opened: true } : item)),
    );
    setLimitedPool((current) => [...current, ...pack.cards]);
    setLimitedStatus(
      `${pack.label} opened: ${pack.cards.length} card${pack.cards.length === 1 ? "" : "s"} added to your pool.`,
    );
  }

  function openAllSealedPacks() {
    const unopened = sealedPacks.filter((pack) => !pack.opened);
    if (unopened.length === 0) {
      return;
    }

    setSealedPacks((current) => current.map((pack) => ({ ...pack, opened: true })));
    setLimitedPool((current) => [...current, ...unopened.flatMap((pack) => pack.cards)]);
    setLimitedStatus(
      `Opened ${unopened.length} pack${unopened.length === 1 ? "" : "s"} and added ${unopened.reduce(
        (sum, pack) => sum + pack.cards.length,
        0,
      )} cards to your pool.`,
    );
  }

  async function startDraft() {
    if (!canUseDraftMode) {
      setLimitedStatus("Draft needs a lobby with at least two connected players.");
      return;
    }

    const packRequests = draftPackRequests();
    const packSets = packRequests.map((pack) => pack.setCode);
    const seatCount = Math.max(2, Math.min(8, draftPlayers));
    setIsLimitedLoading(true);
    setLimitedStatus(`Preparing ${seatCount}-seat draft...`);
    try {
      const cardsBySet = await ensureLimitedSets(packSets);
      const firstRoundPacks = Array.from({ length: seatCount }, () =>
        createBooster(cardsBySet[packRequests[0].setCode] ?? []),
      );
      setDraftSeats(Array.from({ length: seatCount }, () => []));
      setDraftPacks(firstRoundPacks);
      setDraftRound(0);
      setLimitedPool([]);
      setLimitedDeck([]);
      setSealedPacks([]);
      setLimitedStatus(
        `${seatCount}-seat draft started. You are Seat 1; other seats auto-pick when you take a card.`,
      );
    } catch (error) {
      setLimitedStatus(error instanceof Error ? error.message : "Could not start draft.");
    } finally {
      setIsLimitedLoading(false);
    }
  }

  function draftPick(cardIndex: number) {
    setDraftPacks((currentPacks) => {
      if (!currentPacks[0]?.[cardIndex]) {
        return currentPacks;
      }

      let packs = currentPacks.map((pack) => [...pack]);
      const picked = packs[0].splice(cardIndex, 1)[0];
      const nextSeats = draftSeats.map((seat) => [...seat]);
      nextSeats[0].push(picked);

      for (let seat = 1; seat < packs.length; seat += 1) {
        const botPick = chooseBotDraftIndex(packs[seat]);
        if (botPick >= 0) {
          nextSeats[seat].push(packs[seat].splice(botPick, 1)[0]);
        }
      }

      if (packs.every((pack) => pack.length === 0)) {
        const nextRound = draftRound + 1;
        const packRequests = draftPackRequests();
        if (nextRound >= 3) {
          setDraftSeats(nextSeats);
          setLimitedPool(nextSeats[0]);
          setLimitedDeck([]);
          setDraftRound(nextRound);
          setLimitedStatus("Draft complete. Build your 40-card deck from your picks.");
          return packs;
        }

        const nextPacks = Array.from({ length: packs.length }, () =>
          createBooster(limitedCardsBySet[packRequests[nextRound].setCode] ?? []),
        );
        setDraftSeats(nextSeats);
        setDraftRound(nextRound);
        setLimitedStatus(`Pack ${nextRound + 1} opened. Passing ${nextRound === 1 ? "right" : "left"}.`);
        return nextPacks;
      }

      const direction = draftRound === 1 ? -1 : 1;
      packs = rotateDraftPacks(packs, direction);
      setDraftSeats(nextSeats);
      setLimitedSelection({ card: picked, source: "draft" });
      setLimitedStatus(
        `Picked ${picked.name}. ${packs[0]?.length ?? 0} cards in the current pack.`,
      );
      return packs;
    });
  }

  async function importLimitedDeck() {
    const total = limitedDeck.length + Object.values(limitedLands).reduce((sum, qty) => sum + qty, 0);
    if (total < 40) {
      setLimitedStatus(`Limited decks need at least 40 cards. Current build has ${total}.`);
      return;
    }

    const list = cardPoolToDecklist(limitedDeck, limitedLands);
    setDeckInput(list);
    setSelectedPreconId("");
    setLimitedStatus("Limited decklist is ready in the importer and loading to the table.");
    await importDeckText(list, `${limitedMode === "draft" ? "Draft" : "Sealed"} deck`);
  }

  function toggleLimitedCard(card: CardData, destination: "deck" | "pool") {
    if (destination === "deck") {
      setLimitedPool((current) => removeOneCard(current, card.id));
      setLimitedDeck((current) => [...current, card]);
      setLimitedSelection({ card, source: "deck" });
      return;
    }

    setLimitedDeck((current) => removeOneCard(current, card.id));
    setLimitedPool((current) => [...current, card]);
    setLimitedSelection({ card, source: "pool" });
  }

  function updateLimitedLand(name: string, delta: number) {
    setLimitedLands((current) => ({
      ...current,
      [name]: Math.max(0, (current[name] ?? 0) + delta),
    }));
  }

  async function importUrlToTextbox() {
    if (!deckUrl.trim()) {
      setStatus("Paste an Archidekt or Moxfield URL first.");
      return;
    }

    setIsUrlLoading(true);
    setStatus("Fetching deck URL...");
    try {
      const imported = await importDeckFromUrl(deckUrl);
      setDeckInput(imported.decklist);
      setSelectedPreconId("");
      setStatus(`${imported.name} loaded into the textbox.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Deck URL import failed.");
    } finally {
      setIsUrlLoading(false);
    }
  }

  function sanitizeCount(value: number, fallback = 1) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
  }

  function draw(count = 1) {
    setLibraryView("hidden");
    setScryCount(0);
    setGame((current) => {
      const library = orderedZoneCards(
        current.instances.filter((card) => card.zone === "library"),
        "library",
      );
      const toDraw = library.slice(0, count).map((card) => card.instanceId);

      if (toDraw.length === 0) {
        return current;
      }

      return moveCardsToZone(current, toDraw, "hand", `Drew ${toDraw.length}.`);
    });
  }

  function mill(count = 1) {
    setLibraryView("hidden");
    setScryCount(0);
    setGame((current) => {
      const library = orderedZoneCards(
        current.instances.filter((card) => card.zone === "library"),
        "library",
      );
      const toMill = library.slice(0, count).map((card) => card.instanceId);

      if (toMill.length === 0) {
        return current;
      }

      return moveCardsToZone(current, toMill, "graveyard", `Milled ${toMill.length}.`);
    });
  }

  function mulligan(mode: "casual" | "penalty") {
    setGame((current) => {
      const allOwnedCards = current.instances.map((card) =>
        card.zone === "hand" || card.zone === "library"
          ? { ...card, zone: "library" as const, tapped: false, counters: {} }
          : card,
      );
      const resetCards = allOwnedCards;
      const shuffled = shuffleCards(resetCards);
      const library = shuffled.filter((card) => card.zone === "library");
      const drawIds = library.slice(0, 7).map((card) => card.instanceId);
      const drawIdSet = new Set(drawIds);
      const orderCounters = createZoneOrderCounters();
      const penalty = mode === "penalty" ? mulliganPenalty + 1 : mulliganPenalty;

      return {
        ...current,
        instances: shuffled.map((card) => {
          const zone = drawIdSet.has(card.instanceId) ? "hand" : card.zone;
          return {
            ...card,
            zone,
            zoneOrder: nextOrderForZone(orderCounters, zone),
          };
        }),
        actions: [
          createAction(
            mode === "penalty"
              ? `Mulliganed to 7. Put ${penalty} card${penalty === 1 ? "" : "s"} on bottom after choosing.`
              : "Casual mulliganed and drew 7.",
          ),
          ...current.actions,
        ],
      };
    });
    if (mode === "penalty") {
      setMulliganPenalty((current) => current + 1);
    }
    setLibraryView("hidden");
    setScryCount(0);
  }

  function scry(count: number) {
    setLibraryView("scry");
    setScryCount(count);
    setGame((current) => ({
      ...current,
      activeZone: "library",
      selectedId:
        orderedZoneCards(
          current.instances.filter((card) => card.zone === "library"),
          "library",
        )[0]?.instanceId ??
        current.selectedId,
      actions: [createAction(`Scry ${count}: check the top ${count}.`), ...current.actions],
    }));
  }

  function closeLibraryReveal() {
    setLibraryView("hidden");
    setScryCount(0);
    setGame((current) => ({
      ...current,
      selectedId:
        current.instances.find((card) => card.instanceId === current.selectedId)?.zone ===
        "library"
          ? undefined
          : current.selectedId,
      actions: [createAction("Closed library reveal."), ...current.actions],
    }));
  }

  function shuffleLibrary() {
    setLibraryView("hidden");
    setScryCount(0);
    setGame((current) => {
      const library = shuffleCards(current.instances.filter((card) => card.zone === "library")).map(
        (card, index) => ({ ...card, zoneOrder: index }),
      );
      const others = current.instances.filter((card) => card.zone !== "library");
      return {
        ...current,
        instances: [...library, ...others],
        actions: [createAction("Shuffled library."), ...current.actions],
      };
    });
  }

  function moveCard(cardId: string, zone: ZoneId, lane?: BattlefieldLane) {
    setGame((current) => {
      const source = current.instances.find((card) => card.instanceId === cardId);
      if (!source) {
        return current;
      }

      if (source.zone === "tokenBank" && zone !== "tokenBank") {
        const data = current.cardsById[source.cardId];
        const resolvedLane =
          zone === "battlefield" ? lane ?? inferLaneFromCardData(data) : source.battlefieldLane;
        const order =
          zone === "battlefield"
            ? nextBattlefieldOrder(current, resolvedLane)
            : nextZoneOrder(current, zone);
        const battlefieldCount = current.instances.filter(
          (card) => card.zone === "battlefield",
        ).length;
        const tokenCopy: CardInstance = {
          ...source,
          instanceId: crypto.randomUUID(),
          zone,
          tapped: false,
          counters: {},
          faceDown: false,
          displayBack: false,
          originalZone: undefined,
          battlefieldLane: resolvedLane,
          battlefieldOrder: zone === "battlefield" ? order : undefined,
          zoneOrder: zone === "battlefield" ? undefined : order,
          battlefieldPosition:
            zone === "battlefield"
              ? defaultFreePosition(battlefieldCount)
              : source.battlefieldPosition,
        };

        return {
          ...current,
          instances: [tokenCopy, ...current.instances],
          selectedId: tokenCopy.instanceId,
          activeZone: zone,
          actions: [
            createAction(`Created ${source.name} from token bank in ${zone}.`),
            ...current.actions,
          ],
        };
      }

      return updateCards(
        current,
        [cardId],
        {
          zone,
          tapped: zone === "battlefield" ? undefined : false,
          battlefieldLane:
            zone === "battlefield"
              ? lane ?? inferBattlefieldLane(current, cardId)
              : undefined,
          battlefieldOrder:
            zone === "battlefield"
              ? nextBattlefieldOrder(
                  current,
                  lane ?? inferBattlefieldLane(current, cardId),
                  cardId,
                )
              : undefined,
          zoneOrder:
            zone !== "battlefield"
              ? nextZoneOrder(current, zone, cardId)
              : undefined,
          battlefieldPosition:
            zone === "battlefield"
              ? defaultFreePosition(current.instances.filter((card) => card.zone === "battlefield").length)
              : undefined,
        },
        `Moved ${cardName(current, cardId)} to ${zone}.`,
      );
    });
  }

  function moveSelected(zone: ZoneId, lane?: BattlefieldLane) {
    if (selected) {
      moveCard(selected.instanceId, zone, lane);
    }
  }

  function moveSelectedByTouch(zone: ZoneId, lane?: BattlefieldLane) {
    if (!isCompactViewport() || !selected || selectedRemote) {
      return;
    }

    if (selected.zone === zone && selected.battlefieldLane === lane) {
      setGame((current) => ({ ...current, selectedId: undefined }));
      return;
    }

    moveCard(selected.instanceId, zone, lane);
    setGame((current) => ({ ...current, selectedId: undefined }));
  }

  function moveSelectedToFreePoint(event: MouseEvent<HTMLElement>) {
    if (!isCompactViewport() || !selected || selectedRemote) {
      return;
    }

    const board = event.currentTarget.getBoundingClientRect();
    const cardWidth = 70 * cardScale;
    const cardHeight = cardWidth / 0.714;
    const x = ((event.clientX - board.left - cardWidth / 2) / board.width) * 100;
    const y = ((event.clientY - board.top - cardHeight / 2) / board.height) * 100;

    if (selected.zone === "tokenBank") {
      setGame((current) => {
        const source = current.instances.find((card) => card.instanceId === selected.instanceId);
        if (!source) {
          return current;
        }

        const data = current.cardsById[source.cardId];
        const lane = inferLaneFromCardData(data);
        const tokenCopy: CardInstance = {
          ...source,
          instanceId: crypto.randomUUID(),
          zone: "battlefield",
          tapped: false,
          counters: {},
          faceDown: false,
          displayBack: false,
          originalZone: undefined,
          battlefieldLane: lane,
          battlefieldOrder: nextBattlefieldOrder(current, lane),
          zoneOrder: undefined,
          battlefieldPosition: {
            x: clamp(x, 0, 92),
            y: clamp(y, 0, 86),
          },
        };

        return {
          ...current,
          instances: [tokenCopy, ...current.instances],
          selectedId: undefined,
          activeZone: "battlefield",
          actions: [
            createAction(`Created ${source.name} from token bank in battlefield.`),
            ...current.actions,
          ],
        };
      });
      return;
    }

    if (selected.zone !== "battlefield") {
      moveCard(selected.instanceId, "battlefield");
    }

    moveFreeBattlefieldCard(selected.instanceId, x, y);
    setGame((current) => ({ ...current, selectedId: undefined }));
  }

  function selectOrReorderCard(card: CardInstance, zone: ZoneId, lane?: BattlefieldLane) {
    if (
      isCompactViewport() &&
      selected &&
      !selectedRemote &&
      selected.instanceId !== card.instanceId
    ) {
      moveCardBeforeInZone(selected.instanceId, zone, card.instanceId, lane);
      setGame((current) => ({ ...current, selectedId: undefined }));
      return;
    }

    setSelectedRemote(undefined);
    setLimitedSelection(undefined);
    setGame((current) => ({
      ...current,
      selectedId: card.instanceId,
      activeZone: zone,
    }));
  }

  function clearTouchSelection() {
    if (!isCompactViewport()) {
      return;
    }

    setGame((current) => ({ ...current, selectedId: undefined }));
  }

  function changeCounter(type: CounterType, delta: number) {
    if (!selected) {
      return;
    }

    const nextValue = Math.max(0, (selected.counters[type] ?? 0) + delta);
    const nextCounters = { ...selected.counters, [type]: nextValue };
    if (nextValue === 0) {
      delete nextCounters[type];
    }

    updateSelected(
      { counters: nextCounters },
      `${delta > 0 ? "Added" : "Removed"} ${type} counter on ${selected.name}.`,
    );
  }

  function resetSelectedCounters() {
    if (!selected) {
      return;
    }

    if (visibleCounters(selected.counters).length === 0) {
      return;
    }

    updateSelected({ counters: {} }, `Reset counters on ${selected.name}.`);
  }

  function updateSelected(update: Partial<CardInstance>, action: string) {
    if (!selected) {
      return;
    }

    setGame((current) => updateCards(current, [selected.instanceId], update, action));
  }

  function toggleTapped(cardId: string) {
    setGame((current) => {
      const target = current.instances.find((card) => card.instanceId === cardId);
      if (!target || target.zone !== "battlefield") {
        return current;
      }

      const next = updateCards(
        current,
        [cardId],
        { tapped: !target.tapped },
        `${target.tapped ? "Untapped" : "Tapped"} ${target.name}.`,
      );
      return isCompactViewport() ? { ...next, selectedId: undefined } : next;
    });
  }

  function untapAllBattlefield() {
    setGame((current) => {
      const tappedCards = current.instances.filter(
        (card) => card.zone === "battlefield" && card.tapped,
      );

      if (tappedCards.length === 0) {
        return {
          ...current,
          actions: [createAction("Untap step: no tapped permanents."), ...current.actions],
        };
      }

      return updateCards(
        current,
        tappedCards.map((card) => card.instanceId),
        { tapped: false },
        `Untapped ${tappedCards.length} permanent${tappedCards.length === 1 ? "" : "s"}.`,
      );
    });
  }

  function createToken() {
    createTokenInstances("battlefield");
  }

  function createTokenInBank() {
    createTokenInstances("tokenBank");
  }

  function createTokenInstances(zone: ZoneId) {
    const preset =
      tokenPresets.find((token) => token.name === tokenName) ?? tokenPresets.at(-1)!;
    const tokenCard: CardData = {
      id: `token-${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: preset.name,
      typeLine: preset.typeLine,
      oracleText: preset.oracleText,
      cmc: 0,
    };
    const quantity = Math.max(1, sanitizeCount(tokenQuantity));
    const existingBattlefieldCount = game.instances.filter((card) => card.zone === "battlefield").length;
    const instances = Array.from({ length: quantity }, (_, index) => ({
      instanceId: crypto.randomUUID(),
      cardId: tokenCard.id,
      name: tokenCard.name,
      zone,
      owner: "you" as const,
      tapped: false,
      counters: {},
      faceDown: false,
      displayBack: false,
      isToken: true,
      isGenerated: true,
      originalZone: zone === "tokenBank" ? ("tokenBank" as const) : undefined,
      battlefieldLane: inferTokenLane(tokenCard),
      battlefieldOrder:
        zone === "battlefield"
          ? existingBattlefieldCount + index
          : undefined,
      battlefieldPosition: defaultFreePosition(existingBattlefieldCount + index),
    }));

    setGame((current) => ({
      ...current,
      cardsById: { ...current.cardsById, [tokenCard.id]: tokenCard },
      instances: [...instances, ...current.instances],
      selectedId: instances[0]?.instanceId,
      activeZone: zone,
      actions: [
        createAction(`Created ${quantity} ${preset.name}${quantity === 1 ? "" : "s"} in ${zone === "tokenBank" ? "token bank" : "battlefield"}.`),
        ...current.actions,
      ],
    }));
  }

  function removeSelectedToken() {
    if (!selected?.isToken && !selected?.isGenerated) {
      return;
    }

    setGame((current) => ({
      ...current,
      instances: current.instances.filter((card) => card.instanceId !== selected.instanceId),
      selectedId: undefined,
      actions: [createAction(`Removed ${selected.name}.`), ...current.actions],
    }));
  }

  async function spawnCardToHand() {
    await spawnCard("hand");
  }

  async function spawnCardToBattlefield() {
    await spawnCard("battlefield");
  }

  async function spawnCard(zone: ZoneId) {
    setIsSpawnLoading(true);
    setStatus("Fetching card from Scryfall...");
    try {
      const card = await fetchCardFromScryfallInput(spawnInput);
      const instance: CardInstance = {
        instanceId: crypto.randomUUID(),
        cardId: card.id,
        name: card.name,
        zone,
        owner: "you",
        tapped: false,
        counters: {},
        faceDown: false,
        displayBack: false,
        isToken: false,
        isGenerated: true,
        originalZone: undefined,
        battlefieldLane: zone === "battlefield" ? inferLaneFromCardData(card) : "noncreatures",
        battlefieldOrder:
          zone === "battlefield"
            ? gameRef.current.instances.filter((item) => item.zone === "battlefield").length
            : undefined,
        battlefieldPosition: defaultFreePosition(
          gameRef.current.instances.filter((item) => item.zone === "battlefield").length,
        ),
      };

      setGame((current) => ({
        ...current,
        cardsById: { ...current.cardsById, [card.id]: card },
        instances: [instance, ...current.instances],
        selectedId: instance.instanceId,
        activeZone: zone,
        actions: [createAction(`Pulled up ${card.name} to ${zone}.`), ...current.actions],
      }));
      setStatus(`${card.name} added.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not fetch that card.");
    } finally {
      setIsSpawnLoading(false);
    }
  }

  function moveSelectedInLibrary(position: "top" | "bottom") {
    if (!selected || selected.zone !== "library") {
      return;
    }

    setGame((current) => {
      const target = current.instances.find((card) => card.instanceId === selected.instanceId);
      if (!target) {
        return current;
      }

      const library = orderedZoneCards(
        current.instances.filter(
          (card) => card.zone === "library" && card.instanceId !== selected.instanceId,
        ),
        "library",
      );
      const others = current.instances.filter((card) => card.zone !== "library");
      const nextLibrary = (position === "top" ? [target, ...library] : [...library, target]).map(
        (card, index) => ({ ...card, zoneOrder: index }),
      );
      const remainingScryCards = Math.max(0, scryCount - 1);

      return {
        ...current,
        instances: [...nextLibrary, ...others],
        selectedId:
          position === "bottom" && libraryView === "scry"
            ? remainingScryCards > 0
              ? library[0]?.instanceId
              : undefined
            : target.instanceId,
        actions: [createAction(`Put ${target.name} on ${position} of library.`), ...current.actions],
      };
    });
    if (position === "bottom" && libraryView === "scry") {
      setScryCount((current) => Math.max(0, current - 1));
    }
  }

  function showCardPreview(
    card: CardInstance,
    data: CardData | undefined,
    event: MouseEvent<HTMLElement>,
  ) {
    showPreview(data, card, event);
  }

  function showRemoteCardPreview(
    card: PublicCard,
    data: CardData | undefined,
    event: MouseEvent<HTMLElement>,
  ) {
    showPreview(data, card, event);
  }

  function showLimitedCardPreview(card: CardData, event: MouseEvent<HTMLElement>) {
    showPreview(card, { faceDown: false, displayBack: false }, event);
  }

  function selectLimitedCard(selection: LimitedSelection) {
    setLimitedSelection(selection);
    setSelectedRemote(undefined);
    setGame((current) => ({ ...current, selectedId: undefined }));
    openRightTool("card");
  }

  function showPreview(
    data: CardData | undefined,
    card: Pick<CardInstance, "faceDown" | "displayBack">,
    event: MouseEvent<HTMLElement>,
  ) {
    if (!data || !canUseHoverPreview()) {
      return;
    }

    const previewWidth = Math.min(260, window.innerWidth - 24);
    const previewHeight = previewWidth / 0.714;
    const gap = 18;
    const x =
      event.clientX + gap + previewWidth <= window.innerWidth
        ? event.clientX + gap
        : event.clientX - previewWidth - gap;
    const y =
      event.clientY + gap + previewHeight <= window.innerHeight
        ? event.clientY + gap
        : event.clientY - previewHeight - gap;

    setHoverPreview({
      card: data,
      imageUrl: cardDisplayImage(data, card),
      x: clamp(x, 8, Math.max(8, window.innerWidth - previewWidth - 8)),
      y: clamp(y, 8, Math.max(8, window.innerHeight - previewHeight - 8)),
      faceDown: card.faceDown,
    });
  }

  function changeCommanderDamage(source: string, delta: number) {
    setGame((current) => ({
      ...current,
      commanderDamage: {
        ...current.commanderDamage,
        [source]: Math.max(0, (current.commanderDamage[source] ?? 0) + delta),
      },
    }));
  }

  function setBattlefieldLayout(layout: BattlefieldLayout) {
    setGame((current) => ({
      ...current,
      battlefieldLayout: layout,
      actions: [createAction(`Switched battlefield to ${layout === "lanes" ? "snap lanes" : "free move"} mode.`), ...current.actions],
    }));
  }

  function moveFreeBattlefieldCard(cardId: string, x: number, y: number) {
    setGame((current) => ({
      ...current,
      instances: current.instances.map((card) =>
        card.instanceId === cardId
          ? {
              ...card,
              battlefieldPosition: {
                x: clamp(x, 0, 92),
                y: clamp(y, 0, 86),
              },
            }
          : card,
      ),
    }));
  }

  function rollDie(sides: number) {
    const cleanSides = Math.max(2, sanitizeCount(sides, 20));
    const result = Math.floor(Math.random() * cleanSides) + 1;
    const action = createAction(`Rolled d${cleanSides}: ${result}.`);
    setDiceSides(cleanSides);
    setLatestRoll({ sides: cleanSides, result });
    setGame((current) => ({
      ...current,
      actions: [action, ...current.actions],
    }));
  }

  function changeCommanderTax(delta: number) {
    setGame((current) => ({
      ...current,
      commanderTax: Math.max(0, current.commanderTax + delta),
      actions: [
        createAction(`Commander tax is now +${Math.max(0, current.commanderTax + delta)}.`),
        ...current.actions,
      ],
    }));
  }

  function resetBoardPositions() {
    setLibraryView("hidden");
    setScryCount(0);
    setMulliganPenalty(0);
    setGame((current) => {
      const resetCards = current.instances.flatMap((card) => {
        const originalZone = getOriginalZone(card);
        if (!originalZone) {
          return [];
        }

        const data = current.cardsById[card.cardId];
        return [
          {
            ...card,
            zone: originalZone,
            tapped: false,
            counters: {},
            faceDown: false,
            displayBack: false,
            zoneOrder: undefined,
            battlefieldLane: data ? inferLaneFromCardData(data) : card.battlefieldLane,
            battlefieldOrder: undefined,
            battlefieldPosition: defaultFreePosition(0),
          },
        ];
      });
      let boardIndex = 0;
      const positionedCards = resetCards.map((card) => {
        if (card.zone !== "battlefield") {
          return card;
        }

        const position = defaultFreePosition(boardIndex);
        const order = boardIndex;
        boardIndex += 1;
        return { ...card, battlefieldOrder: order, battlefieldPosition: position };
      });
      const library = shuffleCards(positionedCards.filter((card) => card.zone === "library")).map(
        (card, index) => ({ ...card, zoneOrder: index }),
      );
      const others = positionedCards.filter((card) => card.zone !== "library");

      return {
        ...current,
        instances: [...library, ...others],
        life: 40,
        poison: 0,
        energy: 0,
        turn: 1,
        activeZone: "hand",
        selectedId: undefined,
        commanderDamage: {},
        commanderTax: 0,
        actions: [createAction("Reset game: deck returned to starting zones."), ...current.actions],
      };
    });
  }

  function onDrop(event: DragEvent<HTMLElement>, zone: ZoneId, lane?: BattlefieldLane) {
    event.preventDefault();
    event.stopPropagation();
    const cardId = event.dataTransfer.getData("text/plain") || draggedId;
    if (cardId) {
      moveCard(cardId, zone, lane);
    }
    setDraggedId(undefined);
  }

  function onDropBeforeCard(
    event: DragEvent<HTMLElement>,
    zone: ZoneId,
    targetId: string,
    lane?: BattlefieldLane,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const cardId = event.dataTransfer.getData("text/plain") || draggedId;
    if (cardId && cardId !== targetId) {
      moveCardBeforeInZone(cardId, zone, targetId, lane);
    }
    setDraggedId(undefined);
  }

  function moveCardBeforeInZone(
    cardId: string,
    zone: ZoneId,
    targetId: string,
    lane?: BattlefieldLane,
  ) {
    setGame((current) => {
      const moving = current.instances.find((card) => card.instanceId === cardId);
      if (!moving) {
        return current;
      }

      if (moving.zone === "tokenBank" && zone !== "tokenBank") {
        const data = current.cardsById[moving.cardId];
        const newId = crypto.randomUUID();
        const resolvedLane =
          zone === "battlefield" ? lane ?? inferLaneFromCardData(data) : moving.battlefieldLane;
        const zoneCards =
          zone === "battlefield" && lane
            ? orderedBattlefieldCards(
                current.instances.filter(
                  (card) => card.zone === "battlefield" && card.battlefieldLane === lane,
                ),
              )
            : orderedZoneCards(
                current.instances.filter((card) => card.zone === zone),
                zone,
              );
        const targetIndex = Math.max(
          0,
          zoneCards.findIndex((card) => card.instanceId === targetId),
        );
        const orderedIds = [
          ...zoneCards.slice(0, targetIndex).map((card) => card.instanceId),
          newId,
          ...zoneCards.slice(targetIndex).map((card) => card.instanceId),
        ];
        const orderById = new Map(orderedIds.map((id, index) => [id, index]));
        const tokenCopy: CardInstance = {
          ...moving,
          instanceId: newId,
          zone,
          tapped: false,
          counters: {},
          faceDown: false,
          displayBack: false,
          originalZone: undefined,
          battlefieldLane: resolvedLane,
          battlefieldOrder: zone === "battlefield" ? orderById.get(newId) ?? 0 : undefined,
          zoneOrder: zone === "battlefield" ? undefined : orderById.get(newId) ?? 0,
          battlefieldPosition:
            zone === "battlefield"
              ? defaultFreePosition(current.instances.filter((card) => card.zone === "battlefield").length)
              : moving.battlefieldPosition,
        };

        return {
          ...current,
          activeZone: zone,
          selectedId: newId,
          instances: [
            tokenCopy,
            ...current.instances.map((card) => {
              const nextOrder = orderById.get(card.instanceId);
              if (nextOrder === undefined) {
                return card;
              }

              return zone === "battlefield"
                ? { ...card, battlefieldOrder: nextOrder }
                : { ...card, zoneOrder: nextOrder };
            }),
          ],
          actions: [
            createAction(`Created ${moving.name} from token bank in ${zone}.`),
            ...current.actions,
          ],
        };
      }

      if (zone === "battlefield" && lane) {
        const laneCards = orderedBattlefieldCards(
          current.instances.filter(
            (card) =>
              card.zone === "battlefield" &&
              (card.battlefieldLane === lane || card.instanceId === cardId) &&
              card.instanceId !== cardId,
          ),
        );
        const targetIndex = Math.max(
          0,
          laneCards.findIndex((card) => card.instanceId === targetId),
        );
        const orderedIds = [
          ...laneCards.slice(0, targetIndex).map((card) => card.instanceId),
          cardId,
          ...laneCards.slice(targetIndex).map((card) => card.instanceId),
        ];
        const orderById = new Map(orderedIds.map((id, index) => [id, index]));

        return {
          ...current,
          activeZone: "battlefield",
          selectedId: cardId,
          instances: current.instances.map((card) => {
            const nextOrder = orderById.get(card.instanceId);
            if (card.instanceId === cardId) {
              return {
                ...card,
                zone: "battlefield",
                battlefieldLane: lane,
                battlefieldOrder: nextOrder ?? 0,
              };
            }

            return nextOrder === undefined ? card : { ...card, battlefieldOrder: nextOrder };
          }),
          actions: [createAction(`Reordered ${moving.name} in ${lane}.`), ...current.actions],
        };
      }

      const zoneCards = orderedZoneCards(
        current.instances.filter(
          (card) =>
            (card.zone === zone || card.instanceId === cardId) &&
            card.instanceId !== cardId,
        ),
        zone,
      );
      const targetIndex = Math.max(
        0,
        zoneCards.findIndex((card) => card.instanceId === targetId),
      );
      const orderedIds = [
        ...zoneCards.slice(0, targetIndex).map((card) => card.instanceId),
        cardId,
        ...zoneCards.slice(targetIndex).map((card) => card.instanceId),
      ];
      const orderById = new Map(orderedIds.map((id, index) => [id, index]));

      return {
        ...current,
        activeZone: zone,
        selectedId: cardId,
        instances: current.instances.map((card) => {
          const nextOrder = orderById.get(card.instanceId);
          if (card.instanceId === cardId) {
            return {
              ...card,
              zone,
              tapped: zone === "battlefield" ? card.tapped : false,
              zoneOrder: nextOrder ?? 0,
              battlefieldLane: card.battlefieldLane,
              battlefieldOrder: zone === "battlefield" ? card.battlefieldOrder : undefined,
            };
          }

          return nextOrder === undefined ? card : { ...card, zoneOrder: nextOrder };
        }),
        actions: [createAction(`Reordered ${moving.name} in ${zone}.`), ...current.actions],
      };
    });
  }

  function startSolo() {
    setMode("solo");
    setIsConnected(false);
    setPeersById({});
    setPassDeviceSeatId(undefined);
    setIsPrivateHidden(false);
    setStatus("Goldfish mode stays local and private.");
  }

  function startPassPlay() {
    setIsConnected(false);
    setPeersById({});
    setPassDeviceSeatId(undefined);
    setIsPrivateHidden(false);
    setPassSeats((current) =>
      current.map((seat) =>
        seat.id === activePassSeatId ? { ...seat, game: gameRef.current } : seat,
      ),
    );
    setMode("pass");
    setStatus("Pass-and-play ready. Each seat keeps its own hand and library.");
  }

  function joinLobby() {
    setRoomCode(roomCode.trim().toUpperCase() || createRoomCode());
    saveRelayUrl(relayUrl);
    setMode("multiplayer");
    setPassDeviceSeatId(undefined);
    setIsPrivateHidden(false);
    setIsConnected(true);
    setStatus(
      relayUrl.trim()
        ? "Lobby joined. Use this room code on another device connected to the same relay."
        : "Lobby joined locally. Add a relay URL for cross-device play.",
    );
  }

  function leaveLobby() {
    setIsConnected(false);
    setPeersById({});
    setMode("solo");
    setStatus("Back in goldfish mode.");
  }

  function updatePassSeatName(seatId: string, name: string) {
    setPassSeats((current) =>
      current.map((seat) => (seat.id === seatId ? { ...seat, name } : seat)),
    );
  }

  function addPassSeat() {
    if (passSeats.length >= maxPassSeats) {
      return;
    }

    const usedNumbers = new Set(
      passSeats
        .map((seat) => Number(seat.name.match(/^Player (\d+)$/)?.[1]))
        .filter((number) => Number.isFinite(number)),
    );
    const nextNumber =
      Array.from({ length: maxPassSeats }, (_, index) => index + 1).find(
        (number) => !usedNumbers.has(number),
      ) ?? passSeats.length + 1;
    const nextSeat = {
      id: `local-player-${crypto.randomUUID()}`,
      name: `Player ${nextNumber}`,
      game: initialState,
    };

    setPassSeats((current) => [...current, nextSeat]);
    setSelectedPassSeatId(nextSeat.id);
    setStatus("Added a local pass-and-play seat.");
  }

  function removePassSeat(seatId: string) {
    const seat = passSeats.find((item) => item.id === seatId);
    if (!seat || seat.id === activePassSeatId || passSeats.length <= 2) {
      return;
    }

    const nextSeats = passSeats.filter((item) => item.id !== seatId);
    setPassSeats(nextSeats);
    if (selectedPassSeatId === seatId) {
      setSelectedPassSeatId(
        nextSeats.find((item) => item.id !== activePassSeatId)?.id ?? "",
      );
    }
    if (passDeviceSeatId === seatId) {
      setPassDeviceSeatId(undefined);
    }
    setStatus(`${seat.name} removed from pass-and-play.`);
  }

  function beginPassDevice(seatId: string) {
    setPassSeats((current) =>
      current.map((seat) =>
        seat.id === activePassSeatId ? { ...seat, game: gameRef.current } : seat,
      ),
    );
    setPassDeviceSeatId(seatId);
    setIsPrivateHidden(true);
    setHoverPreview(undefined);
  }

  function confirmPassDevice() {
    if (!passDeviceSeat) {
      return;
    }

    setActivePassSeatId(passDeviceSeat.id);
    setGame(passDeviceSeat.game);
    setLibraryView("hidden");
    setScryCount(0);
    setSelectedRemote(undefined);
    setLimitedSelection(undefined);
    setPassDeviceSeatId(undefined);
    setIsPrivateHidden(false);
    setStatus(`${passDeviceSeat.name} is now active.`);
  }

  function cancelPassDevice() {
    setPassDeviceSeatId(undefined);
    setIsPrivateHidden(false);
  }

  function loadSelectedPassSeat() {
    if (!selectedPassSeat) {
      return;
    }

    beginPassDevice(selectedPassSeat.id);
  }

  function forgetAutosavedBoard() {
    if (autosaveTimeoutRef.current !== undefined) {
      window.clearTimeout(autosaveTimeoutRef.current);
      autosaveTimeoutRef.current = undefined;
    }
    clearAutosavedSession();
    setAutosavedSession(undefined);
    setStatus("Autosaved board forgotten. Your current table stays open.");
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text || !isConnected) {
      return;
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      playerId,
      playerName,
      text,
      at: formatTime(),
    };

    setChatMessages((current) => [...current, message].slice(-60));
    postLobbyMessage({ type: "chat", playerId, message });
    setChatInput("");
  }

  function choosePrecon(preconId: string) {
    const precon = preconDecks.find((deck) => deck.id === preconId);
    if (!precon) {
      return;
    }

    setSelectedPreconId(precon.id);
    setDeckInput(precon.decklist);
    setStatus(`${precon.name} loaded into the textbox.`);
  }

  function chooseRandomPrecon() {
    const next = randomPrecon();
    choosePrecon(next.id);
  }

  function chooseCatalogDeck(url: string) {
    setSelectedCatalogUrl(url);
    setDeckUrl(url);
    const deck = archidektCatalog.decks.find((item) => item.url === url);
    if (deck) {
      setStatus(`${deck.name} selected from Archidekt catalog.`);
    }
  }

  function openLeftTool(tool: LeftTool) {
    if (isCompactViewport() && leftPanelOpen && leftTool === tool) {
      setLeftPanelOpen(false);
      return;
    }

    setLeftTool(tool);
    setLeftPanelOpen(true);
    if (isCompactViewport()) {
      setRightPanelOpen(false);
    }
  }

  function openRightTool(tool: RightTool) {
    if (isCompactViewport() && rightPanelOpen && rightTool === tool) {
      setRightPanelOpen(false);
      return;
    }

    setRightTool(tool);
    setRightPanelOpen(true);
    if (isCompactViewport()) {
      setLeftPanelOpen(false);
    }
  }

  function selectTabletopCard(tablePlayerId: string, cardId: string) {
    setLimitedSelection(undefined);

    if (tablePlayerId === localTablePlayer.playerId) {
      setSelectedRemote(undefined);
      setGame((current) => {
        const card = current.instances.find((item) => item.instanceId === cardId);
        return card
          ? { ...current, selectedId: card.instanceId, activeZone: card.zone }
          : current;
      });
      return;
    }

    setSelectedRemote({ playerId: tablePlayerId, cardId });
    setGame((current) => ({ ...current, selectedId: undefined }));
  }

  function showTabletopCardPreview(
    tablePlayer: PublicPlayerState,
    card: PublicCard,
    event: MouseEvent<HTMLElement>,
  ) {
    if (tablePlayer.playerId === localTablePlayer.playerId) {
      const localCard = gameRef.current.instances.find(
        (item) => item.instanceId === card.instanceId,
      );

      if (localCard) {
        showCardPreview(localCard, gameRef.current.cardsById[localCard.cardId], event);
      }
      return;
    }

    showRemoteCardPreview(card, tablePlayer.cardsById[card.cardId], event);
  }

  function toggleTabletopMode() {
    setIsTabletopMode((current) => {
      const next = !current;

      if (next && !isCompactViewport()) {
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
      }

      return next;
    });
  }

  return (
    <main
      className={`app-shell ${leftPanelOpen ? "" : "is-left-collapsed"} ${
        rightPanelOpen ? "" : "is-right-collapsed"
      } ${isTabletopView ? "is-tabletop-view" : ""}`}
      style={{ "--zone-scale": layoutScale * 1.35 } as CSSProperties}
      onMouseLeave={() => setHoverPreview(undefined)}
    >
      <button
        className="panel-tab panel-tab-left"
        onClick={() => {
          if (leftPanelOpen) {
            setLeftPanelOpen(false);
          } else {
            openLeftTool(leftTool);
          }
        }}
      >
        {leftPanelOpen ? "Hide tools" : "Tools"}
      </button>
      <button
        className="panel-tab panel-tab-right"
        onClick={() => {
          if (rightPanelOpen) {
            setRightPanelOpen(false);
          } else {
            openRightTool(rightTool);
          }
        }}
      >
        {rightPanelOpen ? "Hide info" : "Info"}
      </button>

      {leftPanelOpen && <aside className="sidebar">
        <div className="panel-titlebar">
          <div>
            <span>Table tools</span>
            <small>Room, deck, limited, actions</small>
          </div>
          <button onClick={() => setLeftPanelOpen(false)}>Close</button>
        </div>

        <div className="tool-tabs" role="tablist" aria-label="Table tools">
          <button
            className={leftTool === "room" ? "is-active" : ""}
            onClick={() => setLeftTool("room")}
          >
            Room
          </button>
          <button
            className={leftTool === "deck" ? "is-active" : ""}
            onClick={() => setLeftTool("deck")}
          >
            Deck
          </button>
          <button
            className={leftTool === "limited" ? "is-active" : ""}
            onClick={() => setLeftTool("limited")}
          >
            Limited
          </button>
          <button
            className={leftTool === "actions" ? "is-active" : ""}
            onClick={() => setLeftTool("actions")}
          >
            Actions
          </button>
        </div>

        <div className="panel-body">
          {leftTool === "room" && (
            <>
              <div className="brand-block">
                <p className="eyebrow">MTG Duels</p>
                <h1>Sandbox table</h1>
                <p>Goldfish lines, test pods, and tune lists before buying.</p>
              </div>

              <section className="room-panel" aria-label="Room mode">
                <p className="eyebrow">Play mode</p>
                <div className="mode-switch">
                  <button className={mode === "solo" ? "is-active" : ""} onClick={startSolo}>
                    Goldfish
                  </button>
                  <button className={mode === "pass" ? "is-active" : ""} onClick={startPassPlay}>
                    PnP
                  </button>
                  <button
                    className={mode === "multiplayer" ? "is-active" : ""}
                    onClick={() => setMode("multiplayer")}
                  >
                    Lobby
                  </button>
                </div>

                {mode === "multiplayer" ? (
                  <div className="room-fields">
                    <label htmlFor="player-name">Name</label>
                    <input
                      id="player-name"
                      value={playerName}
                      onChange={(event) => setPlayerName(event.target.value)}
                    />
                    <label htmlFor="room-code">Room code</label>
                    <input
                      id="room-code"
                      value={roomCode}
                      onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                    />
                    {hasConfiguredRelay ? (
                      <p className="status-line">Cross-device relay is ready.</p>
                    ) : (
                      <>
                        <button
                          className="relay-toggle"
                          type="button"
                          onClick={() => setIsRelaySettingsOpen((current) => !current)}
                        >
                          {isRelaySettingsOpen ? "Hide relay settings" : "Relay settings"}
                        </button>
                        {canEditRelayUrl && (
                          <>
                            <label htmlFor="relay-url">Relay URL</label>
                            <input
                              id="relay-url"
                              value={relayUrl}
                              onChange={(event) => setRelayUrl(event.target.value)}
                              placeholder="wss://relay.example.com"
                            />
                          </>
                        )}
                      </>
                    )}
                    <div className="room-actions">
                      {isConnected ? (
                        <button onClick={leaveLobby}>Leave lobby</button>
                      ) : (
                        <button onClick={joinLobby}>Join lobby</button>
                      )}
                      <button onClick={() => setRoomCode(createRoomCode())}>New code</button>
                    </div>
                    <p className="status-line">
                      {isConnected
                        ? `${peers.length + 1} player${peers.length ? "s" : ""} in ${roomCode.toUpperCase()} via ${transportStatusLabel}.`
                        : `${transportLabel}. Add a WebSocket relay URL to play across devices.`}
                    </p>
                  </div>
                ) : mode === "pass" ? (
                  <div className="pass-play-panel">
                    <p className="status-line">
                      Active seat: <strong>{activePassSeat.name}</strong>. Private zones stay local to that seat.
                    </p>
                    <div className="pass-seat-count">
                      <span>
                        {passSeats.length} / {maxPassSeats} players
                      </span>
                      <button
                        type="button"
                        onClick={addPassSeat}
                        disabled={passSeats.length >= maxPassSeats}
                      >
                        Add player
                      </button>
                    </div>
                    <div className="pass-seat-list">
                      {passSeats.map((seat) => (
                        <div
                          className={`pass-seat-row ${seat.id === activePassSeatId ? "is-active" : ""}`}
                          key={seat.id}
                        >
                          <input
                            value={seat.name}
                            onChange={(event) => updatePassSeatName(seat.id, event.target.value)}
                            aria-label={`${seat.name} name`}
                          />
                          {seat.id === activePassSeatId ? (
                            <span>Active</span>
                          ) : (
                            <div className="pass-seat-actions">
                              <button
                                type="button"
                                className={seat.id === selectedPassSeat?.id ? "is-selected" : ""}
                                onClick={() => setSelectedPassSeatId(seat.id)}
                              >
                                {seat.id === selectedPassSeat?.id ? "Selected" : "Select"}
                              </button>
                              {passSeats.length > 2 && (
                                <button
                                  type="button"
                                  className="danger-action"
                                  onClick={() => removePassSeat(seat.id)}
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="pass-target-row">
                      <label htmlFor="pass-target">Pass to</label>
                      <select
                        id="pass-target"
                        value={selectedPassSeat?.id ?? ""}
                        onChange={(event) => setSelectedPassSeatId(event.target.value)}
                      >
                        {passTargets.map((seat) => (
                          <option key={seat.id} value={seat.id}>
                            {seat.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={loadSelectedPassSeat}
                        disabled={!selectedPassSeat}
                      >
                        Pass device
                      </button>
                    </div>
                    <div className="room-actions">
                      <button
                        type="button"
                        className={isPrivateHidden ? "is-active" : ""}
                        onClick={() => setIsPrivateHidden((current) => !current)}
                      >
                        {isPrivateHidden ? "Show private info" : "Hide private info"}
                      </button>
                    </div>
                    <p className="status-line">
                      Hide private info lets the active player share the board during their turn. Pass device fully covers the table before another seat takes over.
                    </p>
                  </div>
                ) : (
                  <p className="status-line">Goldfish mode stays local and private.</p>
                )}
                {autosavedSession && (
                  <div className="autosave-row">
                    <p className="status-line">
                      Board autosaved {formatSavedAt(autosavedSession.savedAt)}.
                    </p>
                    <button type="button" onClick={forgetAutosavedBoard}>
                      Forget save
                    </button>
                  </div>
                )}
              </section>
            </>
          )}

          {leftTool === "deck" && (
            <section className="importer" aria-label="Deck importer">
              <p className="eyebrow">Deck setup</p>
              <div className="precon-picker">
                <label htmlFor="precon">Local precon</label>
                <select
                  id="precon"
                  value={selectedPreconId}
                  onChange={(event) => choosePrecon(event.target.value)}
                >
                  <option value="">Custom / imported deck</option>
                  {preconDecks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} - {deck.commander}
                    </option>
                  ))}
                </select>
                <button onClick={chooseRandomPrecon}>Random precon</button>
              </div>
              <div className="url-importer">
                <label htmlFor="deck-url">Archidekt or Moxfield URL</label>
                <select
                  id="archidekt-catalog"
                  value={selectedCatalogUrl}
                  onChange={(event) => chooseCatalogDeck(event.target.value)}
                >
                  {archidektCatalog.decks.map((deck) => (
                    <option key={deck.id} value={deck.url}>
                      {deck.name}
                    </option>
                  ))}
                </select>
                <input
                  id="deck-url"
                  value={deckUrl}
                  onChange={(event) => setDeckUrl(event.target.value)}
                  placeholder="https://archidekt.com/decks/..."
                />
                <button onClick={importUrlToTextbox} disabled={isUrlLoading}>
                  {isUrlLoading ? "Fetching..." : "Load URL"}
                </button>
              </div>
              <label htmlFor="decklist">Decklist</label>
              <textarea
                id="decklist"
                value={deckInput}
                onChange={(event) => setDeckInput(event.target.value)}
                spellCheck={false}
              />
              <button className="primary-action" onClick={importDeck} disabled={isLoading}>
                {isLoading ? "Importing..." : "Import from Scryfall"}
              </button>
              <p className="status-line">{status}</p>
              <DeckStatsPanel stats={deckStats} compact />
            </section>
          )}

          {leftTool === "limited" && (
            <section className="limited-panel" aria-label="Limited formats">
              <p className="eyebrow">Limited setup</p>
              <div className="mode-switch">
                <button
                  className={limitedMode === "jumpstart" ? "is-active" : ""}
                  onClick={() => setLimitedMode("jumpstart")}
                >
                  Jumpstart
                </button>
                <button
                  className={limitedMode === "sealed" ? "is-active" : ""}
                  onClick={() => setLimitedMode("sealed")}
                >
                  Sealed
                </button>
                <button
                  className={limitedMode === "draft" ? "is-active" : ""}
                  disabled={!canUseDraftMode}
                  onClick={() => setLimitedMode("draft")}
                  title={
                    canUseDraftMode
                      ? "Draft in this lobby"
                      : "Join a lobby with at least two players to draft"
                  }
                >
                  Draft
                </button>
              </div>

              {limitedMode === "jumpstart" && (
                <div className="limited-section">
                  <p className="status-line">
                    Choose from {jumpstartThemes.length} local half-decks or roll randomly.
                    The merged 40-card list imports straight to the table.
                  </p>
                  <JumpstartFilterControls
                    label="Theme 1 filters"
                    filter={jumpstartFilters[0]}
                    products={jumpstartProducts}
                    onChange={(update) => updateJumpstartFilter(0, update)}
                  />
                  <JumpstartThemeSelect
                    label="Theme 1"
                    value={jumpstartThemeIds[0]}
                    themes={filteredJumpstartThemesBySlot[0]}
                    onChange={(themeId) => chooseJumpstartTheme(0, themeId)}
                  />
                  <JumpstartFilterControls
                    label="Theme 2 filters"
                    filter={jumpstartFilters[1]}
                    products={jumpstartProducts}
                    onChange={(update) => updateJumpstartFilter(1, update)}
                  />
                  <JumpstartThemeSelect
                    label="Theme 2"
                    value={jumpstartThemeIds[1]}
                    themes={filteredJumpstartThemesBySlot[1]}
                    onChange={(themeId) => chooseJumpstartTheme(1, themeId)}
                  />
                  <label className="limited-field">
                    Random source
                    <select
                      value={jumpstartRandomScope}
                      onChange={(event) =>
                        setJumpstartRandomScope(event.target.value as JumpstartRandomScope)
                      }
                    >
                      <option value="selected">Selected filters</option>
                      <option value="same-set">Same set</option>
                      <option value="all">All sets</option>
                    </select>
                  </label>
                  <div className="limited-actions">
                    <button onClick={randomizeJumpstart}>Random themes</button>
                    <button className="primary-action" onClick={importJumpstartDeck} disabled={isLoading}>
                      Import Jumpstart
                    </button>
                  </div>
                  <div className="jumpstart-theme-readout">
                    {jumpstartThemeIds.map((id) => {
                      const theme = jumpstartThemes.find((item) => item.id === id);
                      return theme ? <JumpstartThemeCard key={id} theme={theme} /> : null;
                    })}
                  </div>
                </div>
              )}

              {limitedMode === "sealed" && (
                <div className="limited-section">
                  <div className="pack-shortcuts">
                    <label htmlFor="sealed-set">
                      Set code for all packs
                      <input
                        id="sealed-set"
                        list="limited-set-options"
                        value={limitedSetCode}
                        onChange={(event) => setLimitedSetCode(event.target.value)}
                        placeholder="fdn"
                      />
                    </label>
                    <button className="compact-action" onClick={applySealedSetToAll}>
                      Use for all packs
                    </button>
                  </div>
                  <datalist id="limited-set-options">
                    {popularLimitedSets.map((set) => (
                      <option key={set.code} value={set.code}>
                        {set.name}
                      </option>
                    ))}
                  </datalist>
                  <div className="pack-grid">
                    {sealedPackSetCodes.map((code, index) => (
                      <div className="pack-config" key={index}>
                        <label>
                          Pack {index + 1}
                          <input
                            value={code}
                            onChange={(event) =>
                              setSealedPackSetCodes((current) =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index ? event.target.value : item,
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <label className="bonus-rare-toggle">
                    <input
                      type="checkbox"
                      checked={includeBonusRare}
                      onChange={(event) => setIncludeBonusRare(event.target.checked)}
                    />
                    Add a bonus rare/mythic
                  </label>
                  {includeBonusRare && (
                    <div className="bonus-rare-options">
                      <label>
                        Rarity
                        <select
                          value={bonusRareRarityMode}
                          onChange={(event) =>
                            setBonusRareRarityMode(event.target.value as BonusRareRarityMode)
                          }
                        >
                          <option value="rare-mythic">Rare or mythic</option>
                          <option value="mythic">Mythic only</option>
                        </select>
                      </label>
                      <label className="checkbox-line">
                        <input
                          type="checkbox"
                          checked={bonusRareCreaturesOnly}
                          onChange={(event) => setBonusRareCreaturesOnly(event.target.checked)}
                        />
                        Creatures only
                      </label>
                      <label className="checkbox-line">
                        <input
                          type="checkbox"
                          checked={bonusRareFromOtherSet}
                          onChange={(event) => setBonusRareFromOtherSet(event.target.checked)}
                        />
                        Pull from another set
                      </label>
                      {bonusRareFromOtherSet && (
                        <label>
                          Bonus set code
                          <input
                            list="limited-set-options"
                            value={bonusRareSetCode}
                            onChange={(event) => setBonusRareSetCode(event.target.value)}
                            placeholder="random if blank"
                          />
                        </label>
                      )}
                    </div>
                  )}
                  <button className="primary-action" onClick={openSealedPool} disabled={isLimitedLoading}>
                    {isLimitedLoading ? "Opening..." : "Open 6 Play Boosters"}
                  </button>
                </div>
              )}

              {limitedMode === "draft" && (
                <div className="limited-section">
                  <p className="status-line">
                    Seat 1 is you. Draft unlocks in lobby with at least two connected players;
                    empty seats are auto-picked for now.
                  </p>
                  <label htmlFor="draft-players">Seats</label>
                  <input
                    id="draft-players"
                    type="number"
                    min="2"
                    max="8"
                    value={draftPlayers}
                    onChange={(event) => setDraftPlayers(sanitizeCount(Number(event.target.value), 4))}
                  />
                  <div className="pack-grid pack-grid-compact">
                    {draftPackSetCodes.map((code, index) => (
                      <div className="pack-config" key={index}>
                        <label>
                          Pack {index + 1}
                          <input
                            value={code}
                            onChange={(event) =>
                              setDraftPackSetCodes((current) =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index ? event.target.value : item,
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <button className="primary-action" onClick={startDraft} disabled={isLimitedLoading || !canUseDraftMode}>
                    {isLimitedLoading ? "Preparing..." : "Start draft"}
                  </button>
                </div>
              )}

              <p className="status-line">{limitedStatus}</p>
            </section>
          )}

          {leftTool === "actions" && (
            <>
              <section className="quick-controls" aria-label="Game controls">
                <p className="eyebrow">Table actions</p>
                <button onClick={() => draw(1)}>Draw 1</button>
                <button onClick={() => mill(1)}>Mill 1</button>
                <button onClick={() => draw(7)}>Draw 7</button>
                <button onClick={untapAllBattlefield}>Untap all</button>
                <button onClick={() => scry(1)}>Scry 1</button>
                <button onClick={() => scry(2)}>Scry 2</button>
                {libraryView !== "hidden" && <button onClick={closeLibraryReveal}>Done looking</button>}
                <button
                  onClick={() => {
                    setLibraryView((current) => (current === "search" ? "hidden" : "search"));
                    setScryCount(0);
                    setGame((current) => ({ ...current, activeZone: "library" }));
                  }}
                >
                  {libraryView === "search" ? "Hide library" : "Search library"}
                </button>
                <button onClick={shuffleLibrary}>Shuffle</button>
              </section>

              <section className="flex-actions" aria-label="Flexible actions">
                <p className="eyebrow">Flexible actions</p>
                <div className="x-controls">
                  <label htmlFor="x-value">X</label>
                  <input
                    id="x-value"
                    type="number"
                    min="0"
                    value={xValue}
                    onChange={(event) => setXValue(sanitizeCount(Number(event.target.value), 1))}
                  />
                  <button onClick={() => draw(xValue)}>Draw X</button>
                  <button onClick={() => scry(xValue)}>Scry X</button>
                  <button onClick={() => mill(xValue)}>Mill X</button>
                </div>
                <div className="dice-controls" aria-label="Dice roller">
                  <span>Roll</span>
                  <button onClick={() => rollDie(6)}>d6</button>
                  <button onClick={() => rollDie(20)}>d20</button>
                  <input
                    type="number"
                    min="2"
                    value={diceSides}
                    onChange={(event) => setDiceSides(sanitizeCount(Number(event.target.value), 20))}
                    aria-label="Custom die sides"
                  />
                  <button onClick={() => rollDie(diceSides)}>Roll custom</button>
                  <strong>{latestRoll ? `d${latestRoll.sides}: ${latestRoll.result}` : "No roll yet"}</strong>
                </div>
                <div className="mulligan-controls">
                  <button onClick={() => mulligan("casual")}>Casual mulligan</button>
                  <button onClick={() => mulligan("penalty")}>Penalty mulligan</button>
                  <span>Penalty: {mulliganPenalty}</span>
                  <button onClick={() => setMulliganPenalty(0)}>Reset penalty</button>
                </div>
                <div className="token-controls">
                  <label htmlFor="token-select">Token</label>
                  <select
                    id="token-select"
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                  >
                    {tokenPresets.map((token) => (
                      <option key={token.name} value={token.name}>
                        {token.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    value={tokenQuantity}
                    onChange={(event) => setTokenQuantity(Math.max(1, sanitizeCount(Number(event.target.value), 1)))}
                    aria-label="Token quantity"
                  />
                  <button onClick={createToken}>To board</button>
                  <button onClick={createTokenInBank}>To bank</button>
                </div>
                <div className="spawn-controls">
                  <label htmlFor="spawn-card">Pull up card</label>
                  <input
                    id="spawn-card"
                    value={spawnInput}
                    onChange={(event) => setSpawnInput(event.target.value)}
                    placeholder="Card name or Scryfall URL"
                  />
                  <button onClick={spawnCardToHand} disabled={isSpawnLoading}>
                    To hand
                  </button>
                  <button onClick={spawnCardToBattlefield} disabled={isSpawnLoading}>
                    To board
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </aside>}

      <nav className="mobile-dock" aria-label="Mobile tools">
        <button
          className={leftPanelOpen && leftTool === "deck" ? "is-active" : ""}
          onClick={() => openLeftTool("deck")}
        >
          Deck
        </button>
        <button
          className={leftPanelOpen && leftTool === "actions" ? "is-active" : ""}
          onClick={() => openLeftTool("actions")}
        >
          Actions
        </button>
        <button
          className={rightPanelOpen && rightTool === "card" ? "is-active" : ""}
          onClick={() => openRightTool("card")}
        >
          Card
        </button>
        <button
          className={rightPanelOpen && rightTool === "damage" ? "is-active" : ""}
          onClick={() => openRightTool("damage")}
        >
          Damage
        </button>
        <button
          className={rightPanelOpen && rightTool === "chat" ? "is-active" : ""}
          onClick={() => openRightTool("chat")}
        >
          Chat
        </button>
      </nav>

      <section className="tabletop" aria-label="Play table">
        <header className="table-header">
          <div>
            <p className="eyebrow">{connectedRoomLabel}</p>
            <h2>
              {mode === "multiplayer"
                ? "Lobby table"
                : mode === "pass"
                  ? "Pass-and-play"
                  : "Goldfish mode"}
            </h2>
          </div>
          {mode === "pass" && (
            <div className="pass-table-actions">
              <button
                type="button"
                className={isPrivateHidden ? "is-active" : ""}
                onClick={() => setIsPrivateHidden((current) => !current)}
              >
                {isPrivateHidden ? "Show private info" : "Hide private info"}
              </button>
              <select
                value={selectedPassSeat?.id ?? ""}
                onChange={(event) => setSelectedPassSeatId(event.target.value)}
                aria-label="Pass device target"
              >
                {passTargets.map((seat) => (
                  <option key={seat.id} value={seat.id}>
                    {seat.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={loadSelectedPassSeat} disabled={!selectedPassSeat}>
                Pass device
              </button>
            </div>
          )}
          <div className="trackers">
            <Tracker
              label="Life"
              value={game.life}
              onChange={(value) => setGame((current) => ({ ...current, life: value }))}
            />
            <Tracker
              label="Poison"
              value={game.poison}
              onChange={(value) => setGame((current) => ({ ...current, poison: value }))}
            />
            <Tracker
              label="Energy"
              value={game.energy}
              onChange={(value) => setGame((current) => ({ ...current, energy: value }))}
            />
            <Tracker
              label="Turn"
              value={game.turn}
              onChange={(value) => setGame((current) => ({ ...current, turn: value }))}
            />
          </div>
        </header>

        <section className="layout-controls" aria-label="Layout controls">
          <label htmlFor="zone-size">Box size</label>
          <input
            id="zone-size"
            type="range"
            min="0.6"
            max="1.15"
            step="0.05"
            value={layoutScale}
            onChange={(event) => setLayoutScale(Number(event.target.value))}
          />
          <span>{Math.round(layoutScale * 100)}%</span>
          <label htmlFor="card-size">Card size</label>
          <input
            id="card-size"
            type="range"
            min="0.7"
            max="1.5"
            step="0.05"
            value={cardScale}
            onChange={(event) => setCardScale(Number(event.target.value))}
          />
          <span>{Math.round(cardScale * 100)}%</span>
          <div className="battlefield-mode-toggle" aria-label="Battlefield layout mode">
            <button
              className={game.battlefieldLayout === "lanes" ? "is-active" : ""}
              onClick={() => setBattlefieldLayout("lanes")}
            >
              Snap lanes
            </button>
            <button
              className={game.battlefieldLayout === "free" ? "is-active" : ""}
              onClick={() => setBattlefieldLayout("free")}
            >
              Free move
            </button>
          </div>
          {canUseTabletopMode && (
            <button
              className={`desktop-tabletop-button ${isTabletopMode ? "is-active" : ""}`}
              type="button"
              disabled={showLimitedWorkspace}
              title={
                showLimitedWorkspace
                  ? "Finish or close the limited workspace first"
                  : isTabletopMode
                    ? "Return to the full board"
                    : "Show every player around one table"
              }
              onClick={toggleTabletopMode}
            >
              {isTabletopMode ? "Board view" : "Pod table"}
            </button>
          )}
          <button className="reset-board-button" onClick={resetBoardPositions}>
            Reset game
          </button>
        </section>

        {isTabletopView ? (
          <TabletopPodView
            players={tabletopPlayers}
            localPlayerId={localTablePlayer.playerId}
            roomLabel={mode === "pass" ? "Pass-and-play" : roomCode.toUpperCase()}
            selectedRemote={selectedRemote}
            selectedLocalId={selected?.instanceId}
            onSelectCard={selectTabletopCard}
            onHoverCard={showTabletopCardPreview}
            onLeaveCard={() => setHoverPreview(undefined)}
          />
        ) : (
          <>
        {(mode === "multiplayer" || mode === "pass") && (
          <section className="opponents-panel" aria-label="Other players">
            {visibleOpponents.length ? (
              visibleOpponents.map((peer) => (
                <OpponentBoard
                  key={peer.playerId}
                  peer={peer}
                  selectedRemoteId={
                    selectedRemote?.playerId === peer.playerId
                      ? selectedRemote.cardId
                      : undefined
                  }
                  onSelectCard={(cardId) => {
                    setSelectedRemote({ playerId: peer.playerId, cardId });
                    setLimitedSelection(undefined);
                    setGame((current) => ({ ...current, selectedId: undefined }));
                  }}
                  onHoverCard={(card, event) =>
                    showRemoteCardPreview(card, peer.cardsById[card.cardId], event)
                  }
                  onLeaveCard={() => setHoverPreview(undefined)}
                />
              ))
            ) : (
              <p className="empty-note">
                {mode === "pass"
                  ? "No other local seats are configured."
                  : `No one else is in this room yet. Join ${roomCode.toUpperCase()} from another ${relayEnabled ? "device using the same relay" : "tab in this browser"}.`}
              </p>
            )}
          </section>
        )}

        {showLimitedWorkspace ? (
          <LimitedWorkspace
            mode={limitedMode}
            sealedPacks={sealedPacks}
            pool={limitedPool}
            deck={limitedDeck}
            lands={limitedLands}
            draftPack={draftRound < 3 ? draftPacks[0] ?? [] : []}
            draftRound={draftRound}
            status={limitedStatus}
            onOpenSealedPack={openSealedPack}
            onOpenAllSealedPacks={openAllSealedPacks}
            onDraftPick={draftPick}
            onSelectCard={selectLimitedCard}
            onHoverCard={showLimitedCardPreview}
            onLeaveCard={() => setHoverPreview(undefined)}
            onMoveCard={(card, destination) => toggleLimitedCard(card, destination)}
            onLandChange={updateLimitedLand}
            onImport={importLimitedDeck}
            isImporting={isLoading}
          />
        ) : (
        <div className="zones-grid">
          <p className="touch-hint">
            Touch: tap a card, then tap a zone to move it. In free move, tap the board spot.
            Tap another card to place before it. Double-tap battlefield cards to tap.
          </p>
          {visibleZones.map((zone) => (
            <section
              key={zone.id}
              className={`zone zone-${zone.id} ${
                game.activeZone === zone.id ? "is-active" : ""
              } ${zone.id === "battlefield" && game.battlefieldLayout === "free" ? "is-free-mode" : ""} ${
                zone.id === "battlefield" && game.battlefieldLayout === "free" && freeBattlefieldExpanded
                  ? "is-free-expanded"
                  : ""
              }`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, zone.id)}
              onClick={() => {
                setGame((current) => ({ ...current, activeZone: zone.id }));
                moveSelectedByTouch(zone.id);
              }}
            >
              {zone.id === "battlefield" ? (
                <div className="zone-heading battlefield-heading">
                  <button
                    className="battlefield-heading-title"
                    onClick={(event) => {
                      event.stopPropagation();
                      setGame((current) => ({ ...current, activeZone: zone.id }))
                      moveSelectedByTouch(zone.id);
                    }}
                  >
                    <span>
                      <strong>{zone.label}</strong>
                      <small>{game.battlefieldLayout === "free" ? "Free move board" : zone.helper}</small>
                    </span>
                  </button>
                  <div className="battlefield-heading-tools">
                    {game.battlefieldLayout === "free" && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setFreeBattlefieldExpanded((current) => !current);
                        }}
                      >
                        {freeBattlefieldExpanded ? "Fit" : "Expand"}
                      </button>
                    )}
                    <b>{zone.cards.length}</b>
                  </div>
                </div>
              ) : zone.id === "command" ? (
                <div className="zone-heading command-heading">
                  <button
                    className="command-heading-title"
                    onClick={(event) => {
                      event.stopPropagation();
                      setGame((current) => ({ ...current, activeZone: zone.id }))
                      moveSelectedByTouch(zone.id);
                    }}
                  >
                    <span>
                      <strong>{zone.label}</strong>
                      <small>{zone.helper}</small>
                    </span>
                  </button>
                  <div className="commander-tax-controls" aria-label="Commander tax">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        changeCommanderTax(-2);
                      }}
                    >
                      -
                    </button>
                    <b title={`Commander tax is +2 for each previous cast from command. ${zone.cards.length} card${zone.cards.length === 1 ? "" : "s"} in command zone.`}>
                      +{game.commanderTax}
                    </b>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        changeCommanderTax(2);
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="zone-heading"
                  onClick={(event) => {
                    event.stopPropagation();
                    setGame((current) => ({ ...current, activeZone: zone.id }))
                    moveSelectedByTouch(zone.id);
                  }}
                >
                  <span>
                    <strong>{zone.label}</strong>
                    <small>{zone.helper}</small>
                  </span>
                  <b>{zone.cards.length}</b>
                </button>
              )}

              {zone.id === "battlefield" ? (
                <BattlefieldZone
                  cards={zone.cards}
                  cardsById={game.cardsById}
                  selectedId={selected?.instanceId}
                  layout={game.battlefieldLayout}
                  cardScale={cardScale}
                  onHoverCard={(card, event) => showCardPreview(card, game.cardsById[card.cardId], event)}
                  onLeaveCard={() => setHoverPreview(undefined)}
                  onDrop={onDrop}
                  onDropBeforeCard={onDropBeforeCard}
                  onFreeMove={moveFreeBattlefieldCard}
                  onFinishFreeMove={clearTouchSelection}
                  onDoubleClickCard={toggleTapped}
                  onTapZone={(lane) => moveSelectedByTouch("battlefield", lane)}
                  onTapFreeBoard={moveSelectedToFreePoint}
                  onSelect={(card, lane) => selectOrReorderCard(card, zone.id, lane)}
                  onDragStart={(event, card) => {
                    setDraggedId(card.instanceId);
                    event.dataTransfer.effectAllowed =
                      card.zone === "tokenBank" ? "copy" : "move";
                    event.dataTransfer.setData("text/plain", card.instanceId);
                  }}
                />
              ) : (
                <ZoneStack
                  zoneId={zone.id}
                  cards={zone.cards}
                  cardsById={game.cardsById}
                  selectedId={selected?.instanceId}
                  libraryView={libraryView}
                  scryCount={scryCount}
                  hidePrivate={isPrivateHidden}
                  cardScale={cardScale}
                  onHoverCard={(card, event) => showCardPreview(card, game.cardsById[card.cardId], event)}
                  onLeaveCard={() => setHoverPreview(undefined)}
                  onSelect={(card) => selectOrReorderCard(card, zone.id)}
                  onDropBeforeCard={(event, targetId) =>
                    onDropBeforeCard(event, zone.id, targetId)
                  }
                  onDragStart={(event, card) => {
                    setDraggedId(card.instanceId);
                    event.dataTransfer.effectAllowed =
                      card.zone === "tokenBank" ? "copy" : "move";
                    event.dataTransfer.setData("text/plain", card.instanceId);
                  }}
                />
              )}
            </section>
          ))}
        </div>
        )}
          </>
        )}
      </section>

      {rightPanelOpen && <aside className={`inspector inspector-${rightTool}`}>
        <div className="panel-titlebar">
          <div>
            <span>Table info</span>
            <small>Card, damage, log, chat</small>
          </div>
          <button onClick={() => setRightPanelOpen(false)}>Close</button>
        </div>

        <div className="tool-tabs" role="tablist" aria-label="Table info">
          <button
            className={rightTool === "card" ? "is-active" : ""}
            onClick={() => setRightTool("card")}
          >
            Card
          </button>
          <button
            className={rightTool === "damage" ? "is-active" : ""}
            onClick={() => setRightTool("damage")}
          >
            Damage
          </button>
          <button
            className={rightTool === "log" ? "is-active" : ""}
            onClick={() => setRightTool("log")}
          >
            Log
          </button>
          <button
            className={rightTool === "chat" ? "is-active" : ""}
            onClick={() => setRightTool("chat")}
          >
            Chat
          </button>
        </div>

        <div className="panel-body">
        <section className="selected-panel" aria-label="Selected card">
          <p className="eyebrow">Selected</p>
          {selectedRemoteCard && selectedRemoteData && selectedRemotePlayer ? (
            <>
              <div className="selected-preview">
                {cardDisplayImage(selectedRemoteData, selectedRemoteCard) ? (
                  <img src={cardDisplayImage(selectedRemoteData, selectedRemoteCard)} alt={selectedRemoteData.name} />
                ) : (
                  <div className="card-back">MTG</div>
                )}
              </div>
              <p className="eyebrow">Opponent card</p>
              <h2>{selectedRemoteData.name}</h2>
              <p>
                {selectedRemotePlayer.playerName} · {selectedRemoteCard.zone}
              </p>
              <p>{selectedRemoteData.typeLine}</p>
              {selectedRemoteData.oracleText && <pre>{selectedRemoteData.oracleText}</pre>}
              {visibleCounters(selectedRemoteCard.counters).length > 0 && (
                <div className="remote-counter-readout">
                  {visibleCounters(selectedRemoteCard.counters).map(([type, value]) => (
                    <span key={type}>
                      {type}: {value}
                    </span>
                  ))}
                </div>
              )}
              <p className="empty-note">Opponent cards are read-only.</p>
            </>
          ) : limitedSelection ? (
            <>
              <div className="selected-preview">
                {cardDisplayImage(limitedSelection.card, {
                  faceDown: false,
                  displayBack: limitedSelection.displayBack,
                }) ? (
                  <img
                    src={cardDisplayImage(limitedSelection.card, {
                      faceDown: false,
                      displayBack: limitedSelection.displayBack,
                    })}
                    alt={limitedSelection.card.name}
                  />
                ) : (
                  <div className="card-back">MTG</div>
                )}
              </div>
              <p className="eyebrow">Limited card</p>
              <h2>{limitedSelection.card.name}</h2>
              <p>{limitedSelection.card.typeLine}</p>
              {limitedSelection.card.oracleText && <pre>{limitedSelection.card.oracleText}</pre>}
              <div className="card-actions">
                {limitedSelection.card.backImageUrl && (
                  <button
                    onClick={() =>
                      setLimitedSelection((current) =>
                        current
                          ? { ...current, displayBack: !current.displayBack }
                          : current,
                      )
                    }
                  >
                    {limitedSelection.displayBack ? "Front side" : "Other side"}
                  </button>
                )}
                {limitedSelection.source === "pool" && (
                  <button onClick={() => toggleLimitedCard(limitedSelection.card, "deck")}>
                    Add to deck
                  </button>
                )}
                {limitedSelection.source === "deck" && (
                  <button onClick={() => toggleLimitedCard(limitedSelection.card, "pool")}>
                    Return to pool
                  </button>
                )}
                {limitedSelection.source === "draft" && limitedSelection.draftIndex !== undefined && (
                  <button onClick={() => draftPick(limitedSelection.draftIndex ?? 0)}>
                    Draft this card
                  </button>
                )}
              </div>
            </>
          ) : selected && selectedData ? (
            <>
              <div className="selected-preview">
                {cardDisplayImage(selectedData, selected) ? (
                  <img src={cardDisplayImage(selectedData, selected)} alt={selectedData.name} />
                ) : (
                  <div className="card-back">MTG</div>
                )}
              </div>
              <h2>{selectedData.name}</h2>
              <p>{selectedData.typeLine}</p>
              {selectedData.oracleText && <pre>{selectedData.oracleText}</pre>}

              <div className="card-actions">
                <button
                  onClick={() =>
                    updateSelected(
                      { tapped: !selected.tapped },
                      `${selected.tapped ? "Untapped" : "Tapped"} ${selected.name}.`,
                    )
                  }
                >
                  {selected.tapped ? "Untap" : "Tap"}
                </button>
                <button
                  onClick={() => moveSelected("battlefield", "creatures")}
                >
                  To creatures
                </button>
                <button
                  onClick={() => moveSelected("battlefield", "noncreatures")}
                >
                  To engines
                </button>
                <button onClick={() => moveSelected("battlefield", "lands")}>To lands</button>
                <button
                  onClick={() =>
                    updateSelected(
                      { faceDown: !selected.faceDown, displayBack: false },
                      `${selected.faceDown ? "Revealed" : "Turned face down"} ${selected.name}.`,
                    )
                  }
                >
                  {selected.faceDown ? "Reveal" : "Face down"}
                </button>
                {selectedData.backImageUrl && (
                  <button
                    onClick={() =>
                      updateSelected(
                        { displayBack: !selected.displayBack, faceDown: false },
                        `${selected.displayBack ? "Showed front of" : "Showed other side of"} ${selected.name}.`,
                      )
                    }
                  >
                    {selected.displayBack ? "Front side" : "Other side"}
                  </button>
                )}
                {(selected.isToken || selected.isGenerated) && (
                  <button className="danger-action" onClick={removeSelectedToken}>
                    Remove card
                  </button>
                )}
              </div>

              {selected.zone === "library" && (
                <div className="library-actions">
                  <button onClick={() => moveSelectedInLibrary("top")}>Keep on top</button>
                  <button onClick={() => moveSelectedInLibrary("bottom")}>Put on bottom</button>
                </div>
              )}

              <div className="counter-controls">
                {counterTypes.map((type) => (
                  <div key={type}>
                    <span className="counter-label">
                      <span>{type}</span>
                      <b>{selected.counters[type] ?? 0}</b>
                    </span>
                    <button onClick={() => changeCounter(type, -1)}>-</button>
                    <button onClick={() => changeCounter(type, 1)}>+</button>
                  </div>
                ))}
                <button
                  className="reset-counters-action"
                  onClick={resetSelectedCounters}
                  disabled={visibleCounters(selected.counters).length === 0}
                >
                  Reset this card
                </button>
              </div>

              <div className="move-list">
                {zones.map((zone) => (
                  <button key={zone.id} onClick={() => moveSelected(zone.id)}>
                    To {zone.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="empty-note">Select a card to inspect it.</p>
          )}
        </section>

        <section className="commander-damage-panel" aria-label="Commander damage">
          <p className="eyebrow">Commander damage</p>
          {commanderDamageSources.map((source) => (
            <CommanderDamageTracker
              key={source.key}
              label={source.label}
              value={game.commanderDamage[source.key] ?? 0}
              onChange={(delta) => changeCommanderDamage(source.key, delta)}
            />
          ))}
        </section>

        <section className="log-panel" aria-label="Action log">
          <p className="eyebrow">Action log</p>
          <div className="log-list">
            {game.actions.length ? (
              game.actions.slice(0, 12).map((action) => (
                <p key={action.id}>
                  <time>{action.at}</time>
                  {action.text}
                </p>
              ))
            ) : (
              <p className="empty-note">No actions yet.</p>
            )}
          </div>
        </section>

        <section className="reference-panel" aria-label="Keyword reference">
          <button
            className="reference-toggle"
            onClick={() => setIsReferenceOpen((current) => !current)}
          >
            {isReferenceOpen ? "Hide keywords" : "Keyword reference"}
          </button>
          {isReferenceOpen && (
            <div className="keyword-list">
              {keywordReference.map(([keyword, text]) => (
                <p key={keyword}>
                  <strong>{keyword}</strong>
                  <span>{text}</span>
                </p>
              ))}
            </div>
          )}
        </section>

        <section className="chat-panel" aria-label="Chat">
          <p className="eyebrow">Chat</p>
          {isConnected ? (
            <>
              <div className="chat-list">
                {chatMessages.length ? (
                  chatMessages.map((message) => (
                    <p key={message.id}>
                      <time>{message.at}</time>
                      <strong>{message.playerName}</strong>
                      <span>{message.text}</span>
                    </p>
                  ))
                ) : (
                  <p className="empty-note">No messages yet.</p>
                )}
              </div>
              <form
                className="chat-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  sendChat();
                }}
              >
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Send a table note"
                />
                <button>Send</button>
              </form>
            </>
          ) : (
            <p className="empty-note">Join a lobby to chat.</p>
          )}
        </section>
        </div>
      </aside>}
      {passDeviceSeat && (
        <div className="pass-device-screen" role="dialog" aria-modal="true">
          <div>
            <p className="eyebrow">Pass device</p>
            <h2>{passDeviceSeat.name}</h2>
            <p>Private information is covered. Hand the device over, then continue when this seat is ready.</p>
            <div>
              <button type="button" onClick={confirmPassDevice}>
                Start {passDeviceSeat.name}'s turn
              </button>
              <button type="button" onClick={cancelPassDevice}>
                Back to {activePassSeat.name}
              </button>
            </div>
          </div>
        </div>
      )}
      {hoverPreview && (
        <div
          className="hover-preview"
          style={{
            left: hoverPreview.x,
            top: hoverPreview.y,
          }}
        >
          {hoverPreview.imageUrl && !hoverPreview.faceDown ? (
            <img src={hoverPreview.imageUrl} alt={hoverPreview.card.name} />
          ) : (
            <div className="card-back">MTG</div>
          )}
        </div>
      )}
    </main>
  );
}

function JumpstartThemeSelect({
  label,
  value,
  themes,
  onChange,
}: {
  label: string;
  value: string;
  themes: JumpstartTheme[];
  onChange: (themeId: string) => void;
}) {
  const themesByProduct = groupJumpstartThemesByProduct(themes);

  return (
    <label className="limited-field">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={themes.length === 0}>
        {themes.length === 0 && <option>No half-decks match</option>}
        {themesByProduct.map(([product, themes]) => (
          <optgroup key={product} label={product}>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name} ({theme.color})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function JumpstartFilterControls({
  label,
  filter,
  products,
  onChange,
}: {
  label: string;
  filter: JumpstartFilter;
  products: string[];
  onChange: (update: Partial<JumpstartFilter>) => void;
}) {
  return (
    <fieldset className="jumpstart-filter-controls">
      <legend>{label}</legend>
      <label>
        Set
        <select value={filter.product} onChange={(event) => onChange({ product: event.target.value })}>
          {products.map((product) => (
            <option key={product} value={product}>
              {product}
            </option>
          ))}
        </select>
      </label>
      <label>
        Colour
        <select value={filter.color} onChange={(event) => onChange({ color: event.target.value })}>
          <option value="All">All</option>
          <option value="W">White</option>
          <option value="U">Blue</option>
          <option value="B">Black</option>
          <option value="R">Red</option>
          <option value="G">Green</option>
          <option value="C">Colorless</option>
          <option value="M">Multicolor</option>
        </select>
      </label>
    </fieldset>
  );
}

function JumpstartThemeCard({ theme }: { theme: JumpstartTheme }) {
  return (
    <article>
      <strong>{theme.name}</strong>
      <span>
        {theme.product ?? "Jumpstart"} · {theme.color} · {theme.deck.reduce((sum, line) => sum + line.quantity, 0)} cards
      </span>
      <small>
        {theme.deck
          .filter((line) => !basicLandNames.includes(line.name as (typeof basicLandNames)[number]))
          .slice(0, 4)
          .map((line) => line.name)
          .join(", ")}
      </small>
    </article>
  );
}

function LimitedWorkspace({
  mode,
  sealedPacks,
  pool,
  deck,
  lands,
  draftPack,
  draftRound,
  status,
  onOpenSealedPack,
  onOpenAllSealedPacks,
  onDraftPick,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
  onMoveCard,
  onLandChange,
  onImport,
  isImporting,
}: {
  mode: LimitedMode;
  sealedPacks: SealedPackView[];
  pool: CardData[];
  deck: CardData[];
  lands: Record<string, number>;
  draftPack: CardData[];
  draftRound: number;
  status: string;
  onOpenSealedPack: (packId: string) => void;
  onOpenAllSealedPacks: () => void;
  onDraftPick: (index: number) => void;
  onSelectCard: (selection: LimitedSelection) => void;
  onHoverCard: (card: CardData, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
  onMoveCard: (card: CardData, destination: "deck" | "pool") => void;
  onLandChange: (name: string, delta: number) => void;
  onImport: () => void;
  isImporting: boolean;
}) {
  const landCount = Object.values(lands).reduce((sum, quantity) => sum + quantity, 0);
  const deckSize = deck.length + landCount;
  const stats = buildDeckStatsFromLimited(deck, lands);
  const unopenedSealedPacks = sealedPacks.filter((pack) => !pack.opened);

  return (
    <section className="limited-workspace" aria-label="Limited deck builder">
      <div className="limited-workspace-header">
        <div>
          <p className="eyebrow">{mode === "draft" ? "Draft table" : "Sealed pool"}</p>
          <h3>{mode === "draft" ? "Pick, then build" : "Build from your pool"}</h3>
          <p>{status}</p>
        </div>
        <div className="limited-build-meter">
          <strong>{deckSize}</strong>
          <span>40 minimum</span>
        </div>
      </div>

      {mode === "draft" && draftPack.length > 0 && (
        <section className="limited-draft-strip">
          <header>
            <strong>Pack {draftRound + 1}</strong>
            <span>Pick one, pass {draftRound === 1 ? "right" : "left"}</span>
          </header>
          <div>
            {draftPack.map((card, index) => (
              <LimitedImageCard
                key={`${card.id}-${index}`}
                card={card}
                source="draft"
                actionLabel="View"
                onClick={() => onSelectCard({ card, source: "draft", draftIndex: index })}
                onDoubleClick={() => onDraftPick(index)}
                onHover={(event) => onHoverCard(card, event)}
                onLeave={onLeaveCard}
              />
            ))}
          </div>
        </section>
      )}

      {mode === "sealed" && sealedPacks.length > 0 && (
        <section className="sealed-pack-strip">
          <header>
            <div>
              <strong>Sealed packs</strong>
              <span>{unopenedSealedPacks.length} unopened</span>
            </div>
            <button onClick={onOpenAllSealedPacks} disabled={unopenedSealedPacks.length === 0}>
              Open all
            </button>
          </header>
          <div>
            {sealedPacks.map((pack) => (
              <button
                key={pack.id}
                className={`sealed-pack ${pack.opened ? "is-opened" : ""} ${pack.isBonus ? "is-bonus" : ""}`}
                onClick={() => onOpenSealedPack(pack.id)}
                disabled={pack.opened}
                style={{
                  "--set-icon": pack.iconUrl ? `url("${pack.iconUrl}")` : "none",
                } as CSSProperties}
              >
                <span>{pack.label}</span>
                <strong>{pack.isBonus ? "Rare+" : pack.setCode.toUpperCase()}</strong>
                <small>{pack.opened ? "Opened" : "Open pack"}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {mode === "sealed" && sealedPacks.some((pack) => pack.opened) && (
        <section className="sealed-pack-contents" aria-label="Opened pack contents">
          {sealedPacks
            .filter((pack) => pack.opened)
            .map((pack) => (
              <article key={`${pack.id}-contents`}>
                <header>
                  <strong>{pack.label}</strong>
                  <span>{pack.isBonus ? "Bonus rare" : `${pack.setCode.toUpperCase()} Play Booster`}</span>
                </header>
                <div>
                  {pack.cards.map((card, index) => (
                    <LimitedImageCard
                      key={`${pack.id}-${card.id}-${index}`}
                      card={card}
                      source="pool"
                      actionLabel="View"
                      draggableCard={false}
                      onClick={() => onSelectCard({ card, source: "pool" })}
                      onHover={(event) => onHoverCard(card, event)}
                      onLeave={onLeaveCard}
                    />
                  ))}
                </div>
              </article>
            ))}
        </section>
      )}

      <div className="limited-build-layout">
        <LimitedImageGroups
          title="Pool"
          cards={pool}
          emptyText="Open packs to see your pool here."
          dropText="Drop deck cards here"
          source="pool"
          onCardClick={(card) => onSelectCard({ card, source: "pool" })}
          onCardDrop={(card, source) => {
            if (source !== "pool") {
              onMoveCard(card, "pool");
            }
          }}
          onCardHover={onHoverCard}
          onCardLeave={onLeaveCard}
        />
        <aside className="limited-deck-column">
          <div className="land-station">
            <header>
              <strong>Basic lands</strong>
              <span>{landCount} lands</span>
            </header>
            {basicLandNames.map((name) => (
              <div key={name}>
                <span>{name}</span>
                <button onClick={() => onLandChange(name, -1)}>-</button>
                <b>{lands[name] ?? 0}</b>
                <button onClick={() => onLandChange(name, 1)}>+</button>
              </div>
            ))}
          </div>
          <LimitedImageGroups
            title="Deck"
            cards={deck}
            emptyText="Drag cards here, or click cards in the pool."
            dropText="Drop pool cards here"
            source="deck"
            onCardClick={(card) => onSelectCard({ card, source: "deck" })}
            onCardDrop={(card, source) => {
              if (source !== "deck") {
                onMoveCard(card, "deck");
              }
            }}
            onCardHover={onHoverCard}
            onCardLeave={onLeaveCard}
            compact
          />
          <button className="primary-action" onClick={onImport} disabled={isImporting || deckSize < 40}>
            {isImporting ? "Importing..." : "Import Limited deck"}
          </button>
          <DeckStatsPanel stats={stats} compact />
        </aside>
      </div>
    </section>
  );
}

function DeckStatsPanel({ stats, compact }: { stats: DeckStats; compact?: boolean }) {
  return (
    <section className={`deck-stats ${compact ? "is-compact" : ""}`} aria-label="Deck stats">
      <header>
        <strong>Deck stats</strong>
        <span>{stats.totalCards} cards · avg MV {stats.averageManaValue.toFixed(2)}</span>
      </header>
      <div className="mana-stat-grid">
        <ManaPipRow title="Costs" values={stats.manaCosts} />
        <ManaPipRow title="Sources" values={stats.manaProduction} />
      </div>
      <div className="mana-curve">
        {stats.curve.map((entry) => (
          <div key={entry.label}>
            <span>{entry.label}</span>
            <b style={{ height: `${Math.max(8, entry.count * 7)}px` }} />
            <small>{entry.count}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function ManaPipRow({
  title,
  values,
}: {
  title: string;
  values: Record<ManaColor, number>;
}) {
  return (
    <div className="mana-pip-row">
      <span>{title}</span>
      {manaColors.map((color) => (
        <b key={color} className={`mana-pip mana-pip-${color.toLowerCase()}`}>
          {color} {values[color]}
        </b>
      ))}
    </div>
  );
}

function LimitedImageGroups({
  title,
  cards,
  emptyText,
  dropText,
  source,
  onCardClick,
  onCardDrop,
  onCardHover,
  onCardLeave,
  compact,
}: {
  title: string;
  cards: CardData[];
  emptyText: string;
  dropText: string;
  source: LimitedCardSource;
  onCardClick: (card: CardData) => void;
  onCardDrop: (card: CardData, source: LimitedCardSource) => void;
  onCardHover: (card: CardData, event: MouseEvent<HTMLElement>) => void;
  onCardLeave: () => void;
  compact?: boolean;
}) {
  const groups = groupLimitedCards(cards).filter((group) => group.cards.length > 0);

  return (
    <section
      className={`limited-card-groups is-${source} ${compact ? "is-compact" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const payload = parseDraggedLimitedCard(event);
        if (payload && payload.source !== source) {
          onCardDrop(payload.card, payload.source);
        }
      }}
    >
      <header>
        <strong>{title}</strong>
        <span>{cards.length} cards</span>
      </header>
      {groups.length ? (
        groups.map((group) => (
          <div key={group.id} className="limited-card-group">
            <p>{group.label}</p>
            <div>
              {group.cards.map((card, index) => (
                <LimitedImageCard
                  key={`${card.id}-${index}`}
                  card={card}
                  source={source}
                  actionLabel="View"
                  onClick={() => onCardClick(card)}
                  onHover={(event) => onCardHover(card, event)}
                  onLeave={onCardLeave}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="empty-note">{emptyText}</p>
      )}
      <small className="limited-drop-hint">{dropText}</small>
    </section>
  );
}

function LimitedImageCard({
  card,
  source,
  actionLabel,
  onClick,
  onDoubleClick,
  onHover,
  onLeave,
  draggableCard = true,
}: {
  card: CardData;
  source: LimitedCardSource;
  actionLabel: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  onHover?: (event: MouseEvent<HTMLElement>) => void;
  onLeave?: () => void;
  draggableCard?: boolean;
}) {
  return (
    <button
      className={`limited-image-card rarity-${card.rarity ?? "unknown"} ${draggableCard ? "" : "is-view-only"}`}
      draggable={draggableCard}
      onDragStart={(event) => {
        if (!draggableCard) {
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/json", JSON.stringify({ card, source }));
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
      title={`${actionLabel} ${card.name}`}
    >
      {card.imageUrl ? (
        <img src={card.imageUrl} alt={card.name} loading="lazy" />
      ) : (
        <span>{card.name}</span>
      )}
      <em>{actionLabel}</em>
    </button>
  );
}

function Tracker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="tracker">
      <span>{label}</span>
      <div>
        <button onClick={() => onChange(value - 1)} aria-label={`Lower ${label}`}>
          -
        </button>
        <strong>{value}</strong>
        <button onClick={() => onChange(value + 1)} aria-label={`Raise ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function CommanderDamageTracker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (delta: number) => void;
}) {
  return (
    <div className="commander-damage-row">
      <span>{label}</span>
      <button onClick={() => onChange(-1)}>-</button>
      <strong>{value}</strong>
      <button onClick={() => onChange(1)}>+</button>
    </div>
  );
}

function ZoneStack({
  zoneId,
  cards,
  cardsById,
  selectedId,
  libraryView,
  scryCount,
  hidePrivate,
  cardScale,
  onHoverCard,
  onLeaveCard,
  onSelect,
  onDropBeforeCard,
  onDragStart,
}: {
  zoneId: ZoneId;
  cards: CardInstance[];
  cardsById: Record<string, CardData>;
  selectedId?: string;
  libraryView: "hidden" | "scry" | "search";
  scryCount: number;
  hidePrivate: boolean;
  cardScale: number;
  onHoverCard: (card: CardInstance, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
  onSelect: (card: CardInstance, lane?: BattlefieldLane) => void;
  onDropBeforeCard: (event: DragEvent<HTMLButtonElement>, targetId: string) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, card: CardInstance) => void;
}) {
  if (hidePrivate && privateZones.has(zoneId)) {
    return (
      <div className="private-zone-hidden">
        <div className="card-back">MTG</div>
        <p>{cards.length} card{cards.length === 1 ? "" : "s"} hidden</p>
      </div>
    );
  }

  if (zoneId === "library" && libraryView === "hidden") {
    return (
      <div className="library-closed">
        <div className="card-back">MTG</div>
        <p>Library hidden. Use scry or search when the game asks you to look.</p>
      </div>
    );
  }

  const visibleCards =
    zoneId === "library" && libraryView === "scry" ? cards.slice(0, scryCount) : cards;

  return (
    <div className="zone-stack">
      {visibleCards.map((card, index) => (
        <CardTile
          key={card.instanceId}
          card={card}
          data={cardsById[card.cardId]}
          isSelected={card.instanceId === selectedId}
          compact={zoneId === "library"}
          indexLabel={zoneId === "library" ? index + 1 : undefined}
          cardScale={cardScale}
          onHover={(event) => onHoverCard(card, event)}
          onLeave={onLeaveCard}
          onSelect={() => onSelect(card)}
          onDropBefore={(event) => onDropBeforeCard(event, card.instanceId)}
          onDragStart={(event) => onDragStart(event, card)}
        />
      ))}
    </div>
  );
}

function BattlefieldZone({
  cards,
  cardsById,
  selectedId,
  layout,
  cardScale,
  onHoverCard,
  onLeaveCard,
  onDrop,
  onDropBeforeCard,
  onFreeMove,
  onFinishFreeMove,
  onDoubleClickCard,
  onTapZone,
  onTapFreeBoard,
  onSelect,
  onDragStart,
}: {
  cards: CardInstance[];
  cardsById: Record<string, CardData>;
  selectedId?: string;
  layout: BattlefieldLayout;
  cardScale: number;
  onHoverCard: (card: CardInstance, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
  onDrop: (
    event: DragEvent<HTMLElement>,
    zone: ZoneId,
    lane?: BattlefieldLane,
  ) => void;
  onDropBeforeCard: (
    event: DragEvent<HTMLElement>,
    zone: ZoneId,
    targetId: string,
    lane?: BattlefieldLane,
  ) => void;
  onFreeMove: (cardId: string, x: number, y: number) => void;
  onFinishFreeMove: () => void;
  onDoubleClickCard: (cardId: string) => void;
  onTapZone: (lane?: BattlefieldLane) => void;
  onTapFreeBoard: (event: MouseEvent<HTMLElement>) => void;
  onSelect: (card: CardInstance, lane?: BattlefieldLane) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, card: CardInstance) => void;
}) {
  if (layout === "free") {
    return (
      <div
        className="battlefield-free"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDrop(event, "battlefield")}
        onClick={(event) => {
          event.stopPropagation();
          onTapFreeBoard(event);
        }}
      >
        {cards.map((card) => (
          <FreeBattlefieldCard
            key={card.instanceId}
            card={card}
            data={cardsById[card.cardId]}
            isSelected={card.instanceId === selectedId}
            cardScale={cardScale}
            onSelect={() => onSelect(card)}
            onHover={(event) => onHoverCard(card, event)}
            onLeave={onLeaveCard}
            onMove={(x, y) => onFreeMove(card.instanceId, x, y)}
            onMoveEnd={onFinishFreeMove}
            onDoubleClick={() => onDoubleClickCard(card.instanceId)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="battlefield-lanes">
      {battlefieldLanes.map((lane) => {
        const laneCards = orderedBattlefieldCards(
          cards.filter((card) => card.battlefieldLane === lane.id),
        );

        return (
          <section
            className={`battlefield-lane lane-${lane.id}`}
            key={lane.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, "battlefield", lane.id)}
            onClick={(event) => {
              event.stopPropagation();
              onTapZone(lane.id);
            }}
          >
            <header>
              <span>
                <strong>{lane.label}</strong>
                <small>{lane.helper}</small>
              </span>
              <b>{laneCards.length}</b>
            </header>
            <div className="zone-stack">
              {laneCards.map((card) => (
                <CardTile
                  key={card.instanceId}
                  card={card}
                  data={cardsById[card.cardId]}
                  isSelected={card.instanceId === selectedId}
                  compact={false}
                  cardScale={cardScale}
                  onHover={(event) => onHoverCard(card, event)}
                  onLeave={onLeaveCard}
                  onSelect={() => onSelect(card, lane.id)}
                  onDoubleClick={() => onDoubleClickCard(card.instanceId)}
                  onDragStart={(event) => onDragStart(event, card)}
                  onDropBefore={(event) =>
                    onDropBeforeCard(event, "battlefield", card.instanceId, lane.id)
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FreeBattlefieldCard({
  card,
  data,
  isSelected,
  cardScale,
  onHover,
  onLeave,
  onSelect,
  onMove,
  onMoveEnd,
  onDoubleClick,
}: {
  card: CardInstance;
  data?: CardData;
  isSelected: boolean;
  cardScale: number;
  onHover: (event: MouseEvent<HTMLElement>) => void;
  onLeave: () => void;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onMoveEnd: () => void;
  onDoubleClick: () => void;
}) {
  const pointerStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const pointerDraggingRef = useRef(false);
  const suppressClickRef = useRef(false);

  function moveFromPointer(event: PointerEvent<HTMLDivElement>) {
    const board = event.currentTarget.closest(".battlefield-free");
    if (!board) {
      return;
    }

    const rect = board.getBoundingClientRect();
    const x = ((event.clientX - rect.left - event.currentTarget.offsetWidth / 2) / rect.width) * 100;
    const y = ((event.clientY - rect.top - event.currentTarget.offsetHeight / 2) / rect.height) * 100;
    onMove(x, y);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") {
      return;
    }

    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerDraggingRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointerStartRef.current || event.pointerType === "mouse") {
      return;
    }

    const distance = Math.hypot(
      event.clientX - pointerStartRef.current.x,
      event.clientY - pointerStartRef.current.y,
    );

    if (!pointerDraggingRef.current && distance < 8) {
      return;
    }

    event.preventDefault();
    pointerDraggingRef.current = true;
    suppressClickRef.current = true;
    moveFromPointer(event);
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!pointerStartRef.current || event.pointerType === "mouse") {
      return;
    }

    if (pointerDraggingRef.current) {
      event.preventDefault();
      event.stopPropagation();
      moveFromPointer(event);
      onMoveEnd();
    }

    pointerStartRef.current = undefined;
    pointerDraggingRef.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onDragEnd(event: DragEvent<HTMLButtonElement>) {
    const board = event.currentTarget.closest(".battlefield-free");
    if (!board) {
      return;
    }

    const rect = board.getBoundingClientRect();
    const x = ((event.clientX - rect.left - event.currentTarget.offsetWidth / 2) / rect.width) * 100;
    const y = ((event.clientY - rect.top - event.currentTarget.offsetHeight / 2) / rect.height) * 100;
    onMove(x, y);
  }

  return (
    <div
      className="free-card-position"
      onClickCapture={(event) => {
        if (!suppressClickRef.current) {
          return;
        }

        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pointerStartRef.current = undefined;
        pointerDraggingRef.current = false;
      }}
      style={{
        left: `${card.battlefieldPosition.x}%`,
        top: `${card.battlefieldPosition.y}%`,
      }}
    >
      <CardTile
        card={card}
        data={data}
        isSelected={isSelected}
        compact={false}
        cardScale={cardScale}
        onHover={onHover}
        onLeave={onLeave}
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onDragStart={(event) => event.dataTransfer.setData("text/plain", card.instanceId)}
        onDragEnd={onDragEnd}
      />
    </div>
  );
}

function OpponentBoard({
  peer,
  selectedRemoteId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
}: {
  peer: PublicPlayerState;
  selectedRemoteId?: string;
  onSelectCard: (cardId: string) => void;
  onHoverCard: (card: PublicCard, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
}) {
  const battlefield = orderedBattlefieldCards(
    peer.publicCards.filter((card) => card.zone === "battlefield"),
  );
  const command = orderedZoneCards(
    peer.publicCards.filter((card) => card.zone === "command"),
    "command",
  );
  const graveyard = orderedZoneCards(
    peer.publicCards.filter((card) => card.zone === "graveyard"),
    "graveyard",
  );
  const exile = orderedZoneCards(
    peer.publicCards.filter((card) => card.zone === "exile"),
    "exile",
  );

  return (
    <article className="opponent-board">
      <header>
        <div>
          <strong>{peer.playerName}</strong>
          <span>
            Life {peer.life} · Poison {peer.poison} · Energy {peer.energy}
          </span>
        </div>
        <small>
          Hand {peer.zoneCounts.hand} · Library {peer.zoneCounts.library}
        </small>
      </header>

      {peer.battlefieldLayout === "free" ? (
        <RemoteFreeBattlefield
          cards={battlefield}
          cardsById={peer.cardsById}
          selectedRemoteId={selectedRemoteId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
      ) : (
        <div className="opponent-battlefield">
          {battlefieldLanes.map((lane) => (
            <RemoteZone
              key={lane.id}
              label={lane.label}
              cards={orderedBattlefieldCards(
                battlefield.filter((card) => card.battlefieldLane === lane.id),
              )}
              cardsById={peer.cardsById}
              selectedRemoteId={selectedRemoteId}
              onSelectCard={onSelectCard}
              onHoverCard={onHoverCard}
              onLeaveCard={onLeaveCard}
              large
            />
          ))}
        </div>
      )}

      <div className="opponent-zones">
        <RemoteZone
          label="Command"
          cards={command}
          cardsById={peer.cardsById}
          selectedRemoteId={selectedRemoteId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
        <RemoteZone
          label="Graveyard"
          cards={graveyard}
          cardsById={peer.cardsById}
          selectedRemoteId={selectedRemoteId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
        <RemoteZone
          label="Exile"
          cards={exile}
          cardsById={peer.cardsById}
          selectedRemoteId={selectedRemoteId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
      </div>
    </article>
  );
}

function TabletopPodView({
  players,
  localPlayerId,
  roomLabel,
  selectedRemote,
  selectedLocalId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
}: {
  players: PublicPlayerState[];
  localPlayerId: string;
  roomLabel: string;
  selectedRemote?: {
    playerId: string;
    cardId: string;
  };
  selectedLocalId?: string;
  onSelectCard: (playerId: string, cardId: string) => void;
  onHoverCard: (
    player: PublicPlayerState,
    card: PublicCard,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onLeaveCard: () => void;
}) {
  const seats = arrangeTabletopSeats(players);
  const seatedPlayerIds = new Set(
    Object.values(seats)
      .flat()
      .map((player) => player.playerId),
  );
  const extraPlayers = players.filter((player) => !seatedPlayerIds.has(player.playerId));

  function renderSeat(player: PublicPlayerState, side: TabletopSide) {
    return (
      <div className={`pod-seat pod-seat-${side}`} key={player.playerId}>
        <TabletopPlayerBoard
          player={player}
          isLocal={player.playerId === localPlayerId}
          selectedCardId={
            player.playerId === localPlayerId
              ? selectedLocalId
              : selectedRemote?.playerId === player.playerId
                ? selectedRemote.cardId
                : undefined
          }
          onSelectCard={(cardId) => onSelectCard(player.playerId, cardId)}
          onHoverCard={(card, event) => onHoverCard(player, card, event)}
          onLeaveCard={onLeaveCard}
        />
      </div>
    );
  }

  return (
    <section
      className={`tabletop-pod-view pod-count-${Math.min(players.length, 6)}`}
      aria-label="Pod tabletop view"
    >
      <div
        className="pod-table-row pod-table-top"
        style={{ "--seat-count": Math.max(1, seats.top.length) } as CSSProperties}
      >
        {seats.top.map((player) => renderSeat(player, "top"))}
      </div>

      <div className="pod-table-middle">
        <div className="pod-table-end pod-table-left">
          {seats.left.map((player) => renderSeat(player, "left"))}
        </div>
        <div className="pod-table-center" aria-label="Table summary">
          <div>
            <span>{roomLabel}</span>
            <strong>{players.length}</strong>
            <small>{players.length === 1 ? "player" : "players"}</small>
          </div>
        </div>
        <div className="pod-table-end pod-table-right">
          {seats.right.map((player) => renderSeat(player, "right"))}
        </div>
      </div>

      <div
        className="pod-table-row pod-table-bottom"
        style={{ "--seat-count": Math.max(1, seats.bottom.length) } as CSSProperties}
      >
        {seats.bottom.map((player) => renderSeat(player, "bottom"))}
      </div>

      {extraPlayers.length > 0 && (
        <div className="pod-extra-players">
          {extraPlayers.map((player) => (
            <span key={player.playerId}>
              {player.playerName} <b>{player.life}</b>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function TabletopPlayerBoard({
  player,
  isLocal,
  selectedCardId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
}: {
  player: PublicPlayerState;
  isLocal: boolean;
  selectedCardId?: string;
  onSelectCard: (cardId: string) => void;
  onHoverCard: (card: PublicCard, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
}) {
  const battlefield = orderedBattlefieldCards(
    player.publicCards.filter((card) => card.zone === "battlefield"),
  );
  const command = orderedZoneCards(
    player.publicCards.filter((card) => card.zone === "command"),
    "command",
  );
  const graveyard = orderedZoneCards(
    player.publicCards.filter((card) => card.zone === "graveyard"),
    "graveyard",
  );
  const exile = orderedZoneCards(
    player.publicCards.filter((card) => card.zone === "exile"),
    "exile",
  );

  return (
    <article className={`pod-player-board ${isLocal ? "is-local" : ""}`}>
      <header>
        <div>
          <strong>{player.playerName}</strong>
          <span>{isLocal ? "You" : `Turn ${player.turn}`}</span>
        </div>
        <div className="pod-trackers" aria-label={`${player.playerName} trackers`}>
          <span>
            Life <b>{player.life}</b>
          </span>
          <span>
            Poison <b>{player.poison}</b>
          </span>
          <span>
            Energy <b>{player.energy}</b>
          </span>
        </div>
      </header>

      <TabletopBattlefield
        cards={battlefield}
        cardsById={player.cardsById}
        layout={player.battlefieldLayout}
        selectedCardId={selectedCardId}
        onSelectCard={onSelectCard}
        onHoverCard={onHoverCard}
        onLeaveCard={onLeaveCard}
      />

      <div className="pod-zone-summary">
        <TabletopMiniZone
          label="Command"
          cards={command}
          cardsById={player.cardsById}
          selectedCardId={selectedCardId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
        <TabletopMiniZone
          label="Graveyard"
          cards={graveyard}
          cardsById={player.cardsById}
          selectedCardId={selectedCardId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
        <TabletopMiniZone
          label="Exile"
          cards={exile}
          cardsById={player.cardsById}
          selectedCardId={selectedCardId}
          onSelectCard={onSelectCard}
          onHoverCard={onHoverCard}
          onLeaveCard={onLeaveCard}
        />
        <div className="pod-hidden-counts">
          <span>
            Hand <b>{player.zoneCounts.hand}</b>
          </span>
          <span>
            Library <b>{player.zoneCounts.library}</b>
          </span>
        </div>
      </div>
    </article>
  );
}

function TabletopBattlefield({
  cards,
  cardsById,
  layout,
  selectedCardId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
}: {
  cards: PublicCard[];
  cardsById: Record<string, CardData>;
  layout: BattlefieldLayout;
  selectedCardId?: string;
  onSelectCard: (cardId: string) => void;
  onHoverCard: (card: PublicCard, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
}) {
  if (layout === "free") {
    return (
      <section className="pod-free-battlefield">
        <span>
          Free board <b>{cards.length}</b>
        </span>
        <div>
          {cards.map((card) => (
            <TabletopCardButton
              key={card.instanceId}
              card={card}
              data={cardsById[card.cardId]}
              selected={selectedCardId === card.instanceId}
              className="pod-free-card"
              onSelect={() => onSelectCard(card.instanceId)}
              onHover={(event) => onHoverCard(card, event)}
              onLeave={onLeaveCard}
              style={{
                left: `${card.battlefieldPosition.x}%`,
                top: `${card.battlefieldPosition.y}%`,
              }}
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="pod-battlefield">
      {battlefieldLanes.map((lane) => {
        const laneCards = orderedBattlefieldCards(
          cards.filter((card) => card.battlefieldLane === lane.id),
        );

        return (
          <section className={`pod-battlefield-lane lane-${lane.id}`} key={lane.id}>
            <span>
              {shortLaneLabel(lane.id)} <b>{laneCards.length}</b>
            </span>
            <div>
              {laneCards.map((card) => (
                <TabletopCardButton
                  key={card.instanceId}
                  card={card}
                  data={cardsById[card.cardId]}
                  selected={selectedCardId === card.instanceId}
                  onSelect={() => onSelectCard(card.instanceId)}
                  onHover={(event) => onHoverCard(card, event)}
                  onLeave={onLeaveCard}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TabletopMiniZone({
  label,
  cards,
  cardsById,
  selectedCardId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
}: {
  label: string;
  cards: PublicCard[];
  cardsById: Record<string, CardData>;
  selectedCardId?: string;
  onSelectCard: (cardId: string) => void;
  onHoverCard: (card: PublicCard, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
}) {
  const visibleCards = cards.slice(0, 6);

  return (
    <section className="pod-mini-zone">
      <span>
        {label} <b>{cards.length}</b>
      </span>
      <div>
        {visibleCards.map((card) => (
          <TabletopCardButton
            key={card.instanceId}
            card={card}
            data={cardsById[card.cardId]}
            selected={selectedCardId === card.instanceId}
            onSelect={() => onSelectCard(card.instanceId)}
            onHover={(event) => onHoverCard(card, event)}
            onLeave={onLeaveCard}
            compact
          />
        ))}
        {cards.length > visibleCards.length && (
          <em className="pod-more-count">+{cards.length - visibleCards.length}</em>
        )}
      </div>
    </section>
  );
}

function TabletopCardButton({
  card,
  data,
  selected,
  onSelect,
  onHover,
  onLeave,
  compact = false,
  className = "",
  style,
}: {
  card: PublicCard;
  data?: CardData;
  selected: boolean;
  onSelect: () => void;
  onHover: (event: MouseEvent<HTMLElement>) => void;
  onLeave: () => void;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const imageUrl = cardDisplayImage(data, card);
  const counters = visibleCounters(card.counters);

  return (
    <button
      className={`pod-card ${compact ? "is-compact" : ""} ${className} ${
        card.tapped ? "is-tapped" : ""
      } ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
      style={style}
      title={data?.name ?? card.name}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={data?.name ?? card.name} loading="lazy" />
      ) : (
        <span>{card.faceDown ? "Face down" : card.name}</span>
      )}
      {counters.length > 0 && (
        <em>
          {counters.map(([type, value]) => `${shortCounterName(type)} ${value}`).join(" ")}
        </em>
      )}
    </button>
  );
}

function RemoteZone({
  label,
  cards,
  cardsById,
  selectedRemoteId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
  large,
}: {
  label: string;
  cards: PublicCard[];
  cardsById: Record<string, CardData>;
  selectedRemoteId?: string;
  onSelectCard: (cardId: string) => void;
  onHoverCard: (card: PublicCard, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
  large?: boolean;
}) {
  return (
    <section className={`remote-zone ${large ? "is-large" : ""}`}>
      <span>
        {label} <b>{cards.length}</b>
      </span>
      <div>
        {cards.map((card) => {
          const data = cardsById[card.cardId];
          const imageUrl = cardDisplayImage(data, card);
          const counters = visibleCounters(card.counters);

          return (
            <button
              className={`remote-card ${card.tapped ? "is-tapped" : ""} ${
                selectedRemoteId === card.instanceId ? "is-selected" : ""
              }`}
              key={card.instanceId}
              onClick={() => onSelectCard(card.instanceId)}
              onMouseMove={(event) => onHoverCard(card, event)}
              onMouseLeave={onLeaveCard}
              title={data?.name ?? card.name}
            >
              {imageUrl ? (
                <img src={imageUrl} alt={data?.name ?? card.name} loading="lazy" />
              ) : (
                <span>{card.faceDown ? "Face down" : card.name}</span>
              )}
              {counters.length > 0 && (
                <em>
                  {counters.map(([type, value]) => `${shortCounterName(type)} ${value}`).join(" ")}
                </em>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function RemoteFreeBattlefield({
  cards,
  cardsById,
  selectedRemoteId,
  onSelectCard,
  onHoverCard,
  onLeaveCard,
}: {
  cards: PublicCard[];
  cardsById: Record<string, CardData>;
  selectedRemoteId?: string;
  onSelectCard: (cardId: string) => void;
  onHoverCard: (card: PublicCard, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
}) {
  return (
    <section className="remote-free-battlefield">
      <span>
        Free battlefield <b>{cards.length}</b>
      </span>
      <div>
        {cards.map((card) => {
          const data = cardsById[card.cardId];
          const imageUrl = cardDisplayImage(data, card);
          const counters = visibleCounters(card.counters);

          return (
            <button
              className={`remote-card remote-free-card ${card.tapped ? "is-tapped" : ""} ${
                selectedRemoteId === card.instanceId ? "is-selected" : ""
              }`}
              key={card.instanceId}
              onClick={() => onSelectCard(card.instanceId)}
              onMouseMove={(event) => onHoverCard(card, event)}
              onMouseLeave={onLeaveCard}
              style={{
                left: `${card.battlefieldPosition.x}%`,
                top: `${card.battlefieldPosition.y}%`,
              }}
              title={data?.name ?? card.name}
            >
              {imageUrl ? (
                <img src={imageUrl} alt={data?.name ?? card.name} loading="lazy" />
              ) : (
                <span>{card.faceDown ? "Face down" : card.name}</span>
              )}
              {counters.length > 0 && (
                <em>
                  {counters.map(([type, value]) => `${shortCounterName(type)} ${value}`).join(" ")}
                </em>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CardTile({
  card,
  data,
  isSelected,
  compact,
  indexLabel,
  cardScale = 1,
  onHover,
  onLeave,
  onSelect,
  onDoubleClick,
  onDragStart,
  onDragEnd,
  onDropBefore,
}: {
  card: CardInstance;
  data?: CardData;
  isSelected: boolean;
  compact: boolean;
  indexLabel?: number;
  cardScale?: number;
  onHover?: (event: MouseEvent<HTMLElement>) => void;
  onLeave?: () => void;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  onDropBefore?: (event: DragEvent<HTMLButtonElement>) => void;
}) {
  const imageUrl = cardDisplayImage(data, card);
  const counters = visibleCounters(card.counters);
  const lastTouchTapRef = useRef(0);
  const suppressNextClickRef = useRef(false);

  function onTouchEnd(event: TouchEvent<HTMLButtonElement>) {
    if (!onDoubleClick) {
      return;
    }

    const now = Date.now();
    if (now - lastTouchTapRef.current < 320) {
      event.preventDefault();
      event.stopPropagation();
      onDoubleClick();
      suppressNextClickRef.current = true;
      lastTouchTapRef.current = 0;
      return;
    }

    lastTouchTapRef.current = now;
  }

  return (
    <button
      className={`card-tile ${isSelected ? "is-selected" : ""} ${
        card.tapped ? "is-tapped" : ""
      } ${compact ? "is-compact" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          return;
        }
        onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (isCompactViewport()) {
          return;
        }
        onDoubleClick?.();
      }}
      draggable={!isCompactViewport()}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (onDropBefore) {
          event.preventDefault();
        }
      }}
      onDrop={onDropBefore}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
      onTouchEnd={onTouchEnd}
      style={{ "--card-scale": cardScale } as CSSProperties}
      title={data?.name ?? card.name}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={data?.name ?? card.name} loading="lazy" />
      ) : (
        <span className="mini-card-back">{card.faceDown ? "Face down" : card.name}</span>
      )}
      {indexLabel && <span className="library-index">{indexLabel}</span>}
      {counters.length > 0 && (
        <span className="counter-stack">
          {counters.map(([type, value]) => (
            <b key={type}>
              <span>{shortCounterName(type)}</span>
              <i>{value}</i>
            </b>
          ))}
        </span>
      )}
      {card.isToken && <span className="token-badge">Token</span>}
    </button>
  );
}

function updateCards(
  game: GameState,
  cardIds: string[],
  update: Partial<CardInstance>,
  actionText: string,
): GameState {
  const ids = new Set(cardIds);
  const cleanedUpdate = Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  ) as Partial<CardInstance>;

  return {
    ...game,
    activeZone: cleanedUpdate.zone ?? game.activeZone,
    selectedId: cardIds[0] ?? game.selectedId,
    instances: game.instances.map((card) =>
      ids.has(card.instanceId) ? { ...card, ...cleanedUpdate } : card,
    ),
    actions: [createAction(actionText), ...game.actions],
  };
}

function moveCardsToZone(
  game: GameState,
  cardIds: string[],
  zone: ZoneId,
  actionText: string,
  lane?: BattlefieldLane,
): GameState {
  const ids = new Set(cardIds);
  const orderStart =
    zone === "battlefield"
      ? lane
        ? nextBattlefieldOrder(game, lane)
        : 0
      : nextZoneOrder(game, zone);
  let movedIndex = 0;

  return {
    ...game,
    activeZone: zone,
    selectedId: cardIds[0] ?? game.selectedId,
    instances: game.instances.map((card) => {
      if (!ids.has(card.instanceId)) {
        return card;
      }

      const order = orderStart + movedIndex;
      movedIndex += 1;
      return {
        ...card,
        zone,
        tapped: zone === "battlefield" ? card.tapped : false,
        battlefieldLane:
          zone === "battlefield" ? lane ?? card.battlefieldLane : card.battlefieldLane,
        battlefieldOrder: zone === "battlefield" ? order : undefined,
        zoneOrder: zone === "battlefield" ? undefined : order,
      };
    }),
    actions: [createAction(actionText), ...game.actions],
  };
}

function cardName(game: GameState, cardId: string): string {
  return game.instances.find((card) => card.instanceId === cardId)?.name ?? "card";
}

function createAction(text: string): GameAction {
  return {
    id: crypto.randomUUID(),
    text,
    at: formatTime(),
  };
}

function buildPublicState(
  game: GameState,
  playerId: string,
  playerName: string,
  roomCode: string,
): PublicPlayerState {
  const publicCards = game.instances
    .filter((card) => publicZones.has(card.zone))
    .map((card) => ({
      instanceId: card.instanceId,
      cardId: card.cardId,
      name: card.name,
      zone: card.zone,
      tapped: card.tapped,
      counters: card.counters,
      faceDown: card.faceDown,
      displayBack: card.displayBack,
      isToken: card.isToken,
      isGenerated: card.isGenerated,
      originalZone: card.originalZone,
      zoneOrder: card.zoneOrder,
      battlefieldLane: card.battlefieldLane,
      battlefieldOrder: card.battlefieldOrder,
      battlefieldPosition: card.battlefieldPosition,
    }));
  const zoneCounts = createZoneCounts(game.instances);
  const visibleCardIds = new Set(publicCards.map((card) => card.cardId));
  const cardsById = Object.fromEntries(
    Object.entries(game.cardsById).filter(([cardId]) => visibleCardIds.has(cardId)),
  );

  return {
    playerId,
    playerName: playerName.trim() || "Player",
    roomCode: roomCode.toUpperCase(),
    cardsById,
    publicCards,
    zoneCounts,
    life: game.life,
    poison: game.poison,
    energy: game.energy,
    turn: game.turn,
    battlefieldLayout: game.battlefieldLayout,
    updatedAt: Date.now(),
  };
}

function createZoneCounts(cards: CardInstance[]): Record<ZoneId, number> {
  const counts = Object.fromEntries(zones.map((zone) => [zone.id, 0])) as Record<
    ZoneId,
    number
  >;
  cards.forEach((card) => {
    counts[card.zone] += 1;
  });
  return counts;
}

function cardDisplayImage(
  data: CardData | undefined,
  card: Pick<CardInstance, "faceDown" | "displayBack">,
) {
  if (!data || card.faceDown) {
    return undefined;
  }

  return card.displayBack ? data.backImageUrl ?? data.imageUrl : data.imageUrl;
}

function orderedBattlefieldCards<T extends { battlefieldOrder?: number }>(cards: T[]): T[] {
  return cards
    .map((card, index) => ({ card, index }))
    .sort(
      (a, b) =>
        (a.card.battlefieldOrder ?? a.index) - (b.card.battlefieldOrder ?? b.index) ||
        a.index - b.index,
    )
    .map(({ card }) => card);
}

function orderedZoneCards<T extends { zoneOrder?: number }>(cards: T[], zone: ZoneId): T[] {
  if (zone === "battlefield") {
    return cards;
  }

  return cards
    .map((card, index) => ({ card, index }))
    .sort(
      (a, b) =>
        (a.card.zoneOrder ?? a.index) - (b.card.zoneOrder ?? b.index) ||
        a.index - b.index,
    )
    .map(({ card }) => card);
}

function nextBattlefieldOrder(
  game: GameState,
  lane: BattlefieldLane,
  excludingId?: string,
): number {
  const laneCards = game.instances.filter(
    (card) =>
      card.zone === "battlefield" &&
      card.battlefieldLane === lane &&
      card.instanceId !== excludingId,
  );

  return laneCards.length
    ? Math.max(...laneCards.map((card, index) => card.battlefieldOrder ?? index)) + 1
    : 0;
}

function nextZoneOrder(game: GameState, zone: ZoneId, excludingId?: string): number {
  const zoneCards = game.instances.filter(
    (card) => card.zone === zone && card.instanceId !== excludingId,
  );

  return zoneCards.length
    ? Math.max(...zoneCards.map((card, index) => card.zoneOrder ?? index)) + 1
    : 0;
}

function createZoneOrderCounters() {
  return new Map<ZoneId, number>();
}

function nextOrderForZone(counters: Map<ZoneId, number>, zone: ZoneId): number {
  const next = counters.get(zone) ?? 0;
  counters.set(zone, next + 1);
  return next;
}

function getOriginalZone(card: CardInstance): ZoneId | undefined {
  if (card.originalZone) {
    return card.originalZone;
  }

  if (card.isGenerated) {
    return card.isToken && card.zone === "tokenBank" ? "tokenBank" : undefined;
  }

  if (card.instanceId.includes("-commander-")) {
    return "command";
  }

  if (card.instanceId.includes("-sideboard-")) {
    return "sideboard";
  }

  return "library";
}

function buildTokenBankForDeck(offset: number, relatedTokens: CardData[] = []) {
  const tokenCardsByName = new Map<string, CardData>();

  relatedTokens.forEach((card) => {
    tokenCardsByName.set(normalizeTokenName(card.name), card);
  });

  const cards: Record<string, CardData> = {};
  const instances = Array.from(tokenCardsByName.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((card, index) => {
      cards[card.id] = card;

      return {
        instanceId: crypto.randomUUID(),
        cardId: card.id,
        name: card.name,
        zone: "tokenBank" as const,
        owner: "you" as const,
        tapped: false,
        counters: {},
        faceDown: false,
        displayBack: false,
        isToken: true,
        isGenerated: true,
        originalZone: "tokenBank" as const,
        battlefieldLane: inferTokenLane(card),
        battlefieldPosition: defaultFreePosition(offset + index),
      };
    });

  return { cards, instances };
}

function normalizeTokenName(name: string) {
  return name.toLowerCase().replace(/\s+token$/, "").trim();
}

function arrangeTabletopSeats(players: PublicPlayerState[]): TabletopSeatGroups {
  const visiblePlayers = players.slice(0, 6);
  const groups: TabletopSeatGroups = {
    top: [],
    bottom: [],
    left: [],
    right: [],
  };

  if (visiblePlayers.length === 0) {
    return groups;
  }

  if (visiblePlayers.length === 1) {
    groups.bottom = visiblePlayers;
    return groups;
  }

  if (visiblePlayers.length === 2) {
    groups.top = [visiblePlayers[1]];
    groups.bottom = [visiblePlayers[0]];
    return groups;
  }

  if (visiblePlayers.length === 3) {
    groups.top = [visiblePlayers[1]];
    groups.bottom = [visiblePlayers[0], visiblePlayers[2]];
    return groups;
  }

  groups.top = visiblePlayers.slice(1, 3);
  groups.bottom = [visiblePlayers[0], visiblePlayers[3]];

  if (visiblePlayers[4]) {
    groups.left = [visiblePlayers[4]];
  }

  if (visiblePlayers[5]) {
    groups.right = [visiblePlayers[5]];
  }

  return groups;
}

function shortLaneLabel(lane: BattlefieldLane): string {
  if (lane === "creatures") {
    return "Creatures";
  }

  if (lane === "lands") {
    return "Lands";
  }

  return "Engines";
}

function defaultFreePosition(index: number) {
  return {
    x: 4 + (index % 8) * 11,
    y: 6 + (Math.floor(index / 8) % 5) * 18,
  };
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function isCompactViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
}

function canUseHoverPreview() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

function inferBattlefieldLane(game: GameState, cardId: string): BattlefieldLane {
  const instance = game.instances.find((card) => card.instanceId === cardId);
  const typeLine = instance ? game.cardsById[instance.cardId]?.typeLine.toLowerCase() : "";

  return inferLaneFromTypeLine(typeLine, instance?.battlefieldLane);
}

function inferTokenLane(card: CardData): BattlefieldLane {
  return inferLaneFromCardData(card);
}

function inferLaneFromCardData(card: CardData): BattlefieldLane {
  return inferLaneFromTypeLine(card.typeLine.toLowerCase(), "noncreatures");
}

function inferLaneFromTypeLine(
  typeLine: string,
  fallback: BattlefieldLane = "noncreatures",
): BattlefieldLane {
  if (typeLine.includes("land")) {
    return "lands";
  }

  if (typeLine.includes("creature")) {
    return "creatures";
  }

  return fallback;
}

function visibleCounters(counters: CardInstance["counters"]): Array<[CounterType, number]> {
  return Object.entries(counters).filter((entry): entry is [CounterType, number] => entry[1] > 0);
}

function shortCounterName(type: CounterType): string {
  if (type === "loyalty") {
    return "L";
  }

  if (type === "charge") {
    return "C";
  }

  if (type === "shield") {
    return "Sh";
  }

  if (type === "flying") {
    return "Fly";
  }

  if (type === "custom") {
    return "*";
  }

  return type;
}

function isPublicActionText(text: string) {
  const privatePatterns = [
    /^Imported /,
    /^Pulled up /,
    /^Put .+ on (top|bottom) of library\.$/,
    /^Moved .+ to (hand|library)\.$/,
    /^Reordered .+ in (hand|library)\.$/,
    / in hand\.$/,
  ];

  return !privatePatterns.some((pattern) => pattern.test(text));
}

function buildDeckStatsFromGame(game: GameState): DeckStats {
  const cards = game.instances
    .filter((instance) => instance.zone !== "tokenBank" && !instance.isGenerated)
    .map((instance) => game.cardsById[instance.cardId])
    .filter((card): card is CardData => Boolean(card));

  return buildDeckStats(cards);
}

function buildDeckStatsFromLimited(cards: CardData[], lands: Record<string, number>): DeckStats {
  const landCards = Object.entries(lands).flatMap(([name, quantity]) =>
    Array.from({ length: quantity }, () => basicLandCardData(name)),
  );

  return buildDeckStats([...cards, ...landCards]);
}

function buildDeckStats(cards: CardData[]): DeckStats {
  const manaCosts = emptyManaColorCounts();
  const manaProduction = emptyManaColorCounts();
  const curveCounts = [0, 0, 0, 0, 0, 0, 0];
  let manaValueTotal = 0;
  let manaValueCards = 0;

  cards.forEach((card) => {
    countManaSymbols(card.manaCost, manaCosts);
    countManaProduction(card, manaProduction);

    if (!card.typeLine.toLowerCase().includes("land")) {
      const curveIndex = Math.min(6, Math.max(0, Math.floor(card.cmc)));
      curveCounts[curveIndex] += 1;
      manaValueTotal += card.cmc;
      manaValueCards += 1;
    }
  });

  return {
    totalCards: cards.length,
    averageManaValue: manaValueCards ? manaValueTotal / manaValueCards : 0,
    manaCosts,
    manaProduction,
    curve: curveCounts.map((count, index) => ({
      label: index === 6 ? "6+" : String(index),
      count,
    })),
  };
}

function emptyManaColorCounts(): Record<ManaColor, number> {
  return { W: 0, U: 0, B: 0, R: 0, G: 0 };
}

function countManaSymbols(manaCost: string | undefined, counts: Record<ManaColor, number>) {
  manaCost?.match(/\{[^}]+\}/g)?.forEach((symbol) => {
    manaColors.forEach((color) => {
      if (symbol.includes(color)) {
        counts[color] += 1;
      }
    });
  });
}

function countManaProduction(card: CardData, counts: Record<ManaColor, number>) {
  const basicLandColor = basicLandProducedColor(card.name);
  if (basicLandColor) {
    counts[basicLandColor] += 1;
    return;
  }

  const text = card.oracleText || "";
  manaColors.forEach((color) => {
    if (text.includes(`{${color}}`)) {
      counts[color] += 1;
    }
  });
}

function basicLandProducedColor(name: string): ManaColor | undefined {
  if (name === "Plains") {
    return "W";
  }
  if (name === "Island") {
    return "U";
  }
  if (name === "Swamp") {
    return "B";
  }
  if (name === "Mountain") {
    return "R";
  }
  if (name === "Forest") {
    return "G";
  }
  return undefined;
}

function basicLandCardData(name: string): CardData {
  return {
    id: `basic-${name.toLowerCase()}`,
    name,
    typeLine: "Basic Land",
    oracleText: "",
    cmc: 0,
  };
}

function removeOneCard(cards: CardData[], cardId: string) {
  const index = cards.findIndex((card) => card.id === cardId);
  if (index < 0) {
    return cards;
  }

  return [...cards.slice(0, index), ...cards.slice(index + 1)];
}

function parseDraggedLimitedCard(
  event: DragEvent<HTMLElement>,
): { card: CardData; source: LimitedCardSource } | undefined {
  try {
    const value = event.dataTransfer.getData("application/json");
    const parsed = value ? (JSON.parse(value) as Partial<{ card: CardData; source: LimitedCardSource }>) : undefined;
    return parsed?.card && parsed.source ? { card: parsed.card, source: parsed.source } : undefined;
  } catch {
    return undefined;
  }
}

function groupJumpstartThemesByProduct(themes: JumpstartTheme[]): Array<[string, JumpstartTheme[]]> {
  const groups = new Map<string, JumpstartTheme[]>();
  themes.forEach((theme) => {
    const product = theme.product ?? "Jumpstart";
    groups.set(product, [...(groups.get(product) ?? []), theme]);
  });
  return Array.from(groups.entries());
}

function filterJumpstartThemesBy(filter: JumpstartFilter) {
  return jumpstartThemes.filter((theme) => {
    const product = theme.product ?? "Jumpstart";
    return (
      (filter.product === "All" || product === filter.product) &&
      (filter.color === "All" || theme.color === filter.color)
    );
  });
}

function rotateDraftPacks(packs: CardData[][], direction: 1 | -1) {
  if (packs.length <= 1) {
    return packs;
  }

  return packs.map((_, index) => {
    const sourceIndex = (index - direction + packs.length) % packs.length;
    return packs[sourceIndex];
  });
}

function chooseBotDraftIndex(pack: CardData[]) {
  if (pack.length === 0) {
    return -1;
  }

  let bestIndex = 0;
  let bestScore = -Infinity;
  pack.forEach((card, index) => {
    const rarityScore = card.rarity === "mythic" ? 40 : card.rarity === "rare" ? 30 : card.rarity === "uncommon" ? 12 : 0;
    const manaScore = Math.max(0, 8 - Math.abs((card.cmc ?? 3) - 3));
    const score = rarityScore + manaScore + Math.random();
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function readAutosavedSession(): AutosavedSession | undefined {
  try {
    const raw = window.localStorage.getItem(autosaveKey);
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as Partial<AutosavedSession>;
    if (!isAutosavedSession(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function saveAutosavedSession(session: AutosavedSession) {
  try {
    window.localStorage.setItem(autosaveKey, JSON.stringify(session));
  } catch {
    // Autosave should never interrupt table actions.
  }
}

function clearAutosavedSession() {
  try {
    window.localStorage.removeItem(autosaveKey);
  } catch {
    // Nothing useful to do if storage is unavailable.
  }
}

function isAutosavedSession(value: Partial<AutosavedSession>): value is AutosavedSession {
  return (
    value.version === 1 &&
    typeof value.savedAt === "number" &&
    typeof value.playerName === "string" &&
    typeof value.roomCode === "string" &&
    isGameState(value.game)
  );
}

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<GameState>;
  return (
    Boolean(state.cardsById) &&
    typeof state.cardsById === "object" &&
    Array.isArray(state.instances) &&
    typeof state.life === "number" &&
    typeof state.poison === "number" &&
    typeof state.energy === "number" &&
    typeof state.turn === "number" &&
    typeof state.activeZone === "string" &&
    Array.isArray(state.actions) &&
    (state.battlefieldLayout === "lanes" || state.battlefieldLayout === "free") &&
    Boolean(state.commanderDamage) &&
    typeof state.commanderDamage === "object" &&
    typeof state.commanderTax === "number"
  );
}

function formatSavedAt(savedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(savedAt));
}

function getOrCreatePlayerId(): string {
  try {
    const existing = window.localStorage.getItem(playerIdKey);
    if (existing) {
      return existing;
    }

    const next = crypto.randomUUID();
    window.localStorage.setItem(playerIdKey, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

function createRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export default App;
