import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
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
  getSavedRelayUrl,
  saveRelayUrl,
  type LobbyTransport,
  type LobbyTransportStatus,
} from "./multiplayer";
import { preconDecks, randomPrecon } from "./precons";
import archidektCatalog from "./archidekt-precons.json";
import { fetchCardFromScryfallInput, fetchCardsForDeckLines } from "./scryfall";
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
};

function App() {
  const [initialPrecon] = useState(randomPrecon);
  const [playerId] = useState(getOrCreatePlayerId);
  const [playerName, setPlayerName] = useState("Player");
  const [roomCode, setRoomCode] = useState(createRoomCode);
  const [isConnected, setIsConnected] = useState(false);
  const [mode, setMode] = useState<"solo" | "multiplayer">("solo");
  const [peersById, setPeersById] = useState<Record<string, PublicPlayerState>>({});
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [relayUrl, setRelayUrl] = useState(getSavedRelayUrl);
  const [transportStatus, setTransportStatus] = useState<LobbyTransportStatus>("local");
  const transportRef = useRef<LobbyTransport | undefined>(undefined);
  const gameRef = useRef<GameState>(initialState);
  const [selectedPreconId, setSelectedPreconId] = useState(initialPrecon.id);
  const [deckInput, setDeckInput] = useState(initialPrecon.decklist);
  const [deckUrl, setDeckUrl] = useState("");
  const [selectedCatalogUrl, setSelectedCatalogUrl] = useState(
    archidektCatalog.decks[0]?.url ?? "",
  );
  const [game, setGame] = useState<GameState>(initialState);
  const [status, setStatus] = useState("Paste a decklist, import, then draw.");
  const [isLoading, setIsLoading] = useState(false);
  const [isUrlLoading, setIsUrlLoading] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [libraryView, setLibraryView] = useState<"hidden" | "scry" | "search">("hidden");
  const [scryCount, setScryCount] = useState(0);
  const [layoutScale, setLayoutScale] = useState(1.35);
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => !isCompactViewport());
  const [rightPanelOpen, setRightPanelOpen] = useState(() => !isCompactViewport());
  const [cardScale, setCardScale] = useState(1);
  const [hoverPreview, setHoverPreview] = useState<{
    card: CardData;
    x: number;
    y: number;
    faceDown?: boolean;
  }>();
  const [xValue, setXValue] = useState(3);
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
  const commanderDamageSources = useMemo(() => {
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
  }, [mode, peers, playerId, playerName]);
  const connectedRoomLabel = isConnected ? `Room ${roomCode.toUpperCase()}` : "Solo sandbox";
  const relayEnabled = Boolean(relayUrl.trim());
  const transportLabel = relayEnabled ? "Cross-device relay" : "This browser";
  const transportStatusLabel =
    transportStatus === "connected"
      ? "relay connected"
      : transportStatus === "connecting"
        ? "relay connecting"
        : transportStatus === "error"
          ? "relay unavailable"
          : "local tabs";

  const selected = game.instances.find((card) => card.instanceId === game.selectedId);
  const selectedData = selected ? game.cardsById[selected.cardId] : undefined;
  const selectedRemoteCard = selectedRemote
    ? peersById[selectedRemote.playerId]?.publicCards.find(
        (card) => card.instanceId === selectedRemote.cardId,
      )
    : undefined;
  const selectedRemotePlayer = selectedRemote ? peersById[selectedRemote.playerId] : undefined;
  const selectedRemoteData =
    selectedRemoteCard && selectedRemotePlayer
      ? selectedRemotePlayer.cardsById[selectedRemoteCard.cardId]
      : undefined;
  const visibleZones = useMemo(
    () =>
      zones.map((zone) => ({
        ...zone,
        cards: game.instances.filter((card) => card.zone === zone.id),
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
    },
    [playerId, publishState, roomCode],
  );

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

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

  async function importDeck() {
    const lines = parseDeckList(deckInput);
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
      const tokenBank = buildTokenBankForDeck(cardsById, instances.length);

      setGame({
        ...initialState,
        cardsById: { ...cardsById, ...tokenBank.cards },
        instances: [...tokenBank.instances, ...instances],
        actions: [
          createAction(
            `Imported ${instances.length} cards${tokenBank.instances.length ? ` and ${tokenBank.instances.length} token bank entries` : ""}${missing.length ? `; missing ${missing.join(", ")}` : ""}.`,
          ),
        ],
      });
      setLibraryView("hidden");
      setScryCount(0);
      setSelectedRemote(undefined);
      setStatus(
        missing.length
          ? `Imported with ${missing.length} missing card name${missing.length === 1 ? "" : "s"}.`
          : "Deck imported and shuffled.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsLoading(false);
    }
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
      const library = current.instances.filter((card) => card.zone === "library");
      const toDraw = library.slice(0, count).map((card) => card.instanceId);

      if (toDraw.length === 0) {
        return current;
      }

      return updateCards(current, toDraw, { zone: "hand", tapped: false }, `Drew ${toDraw.length}.`);
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
      const penalty = mode === "penalty" ? mulliganPenalty + 1 : mulliganPenalty;

      return {
        ...current,
        instances: shuffled.map((card) =>
          drawIds.includes(card.instanceId) ? { ...card, zone: "hand" } : card,
        ),
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
        current.instances.find((card) => card.zone === "library")?.instanceId ??
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
      const library = shuffleCards(current.instances.filter((card) => card.zone === "library"));
      const others = current.instances.filter((card) => card.zone !== "library");
      return {
        ...current,
        instances: [...library, ...others],
        actions: [createAction("Shuffled library."), ...current.actions],
      };
    });
  }

  function moveCard(cardId: string, zone: ZoneId, lane?: BattlefieldLane) {
    setGame((current) =>
      updateCards(
        current,
        [cardId],
        {
          zone,
          tapped: zone === "battlefield" ? undefined : false,
          battlefieldLane:
            zone === "battlefield"
              ? lane ?? inferBattlefieldLane(current, cardId)
              : undefined,
          battlefieldPosition:
            zone === "battlefield"
              ? defaultFreePosition(current.instances.filter((card) => card.zone === "battlefield").length)
              : undefined,
        },
        `Moved ${cardName(current, cardId)} to ${zone}.`,
      ),
    );
  }

  function moveSelected(zone: ZoneId, lane?: BattlefieldLane) {
    if (selected) {
      moveCard(selected.instanceId, zone, lane);
    }
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

  function updateSelected(update: Partial<CardInstance>, action: string) {
    if (!selected) {
      return;
    }

    setGame((current) => updateCards(current, [selected.instanceId], update, action));
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
      isToken: true,
      isGenerated: true,
      battlefieldLane: inferTokenLane(tokenCard),
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
        isToken: false,
        isGenerated: true,
        battlefieldLane: zone === "battlefield" ? inferLaneFromCardData(card) : "noncreatures",
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

      const library = current.instances.filter(
        (card) => card.zone === "library" && card.instanceId !== selected.instanceId,
      );
      const others = current.instances.filter((card) => card.zone !== "library");
      const nextLibrary = position === "top" ? [target, ...library] : [...library, target];
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
    showPreview(data, card.faceDown, event);
  }

  function showRemoteCardPreview(
    card: PublicCard,
    data: CardData | undefined,
    event: MouseEvent<HTMLElement>,
  ) {
    showPreview(data, card.faceDown, event);
  }

  function showPreview(
    data: CardData | undefined,
    faceDown: boolean,
    event: MouseEvent<HTMLElement>,
  ) {
    if (!data) {
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
      x: clamp(x, 8, Math.max(8, window.innerWidth - previewWidth - 8)),
      y: clamp(y, 8, Math.max(8, window.innerHeight - previewHeight - 8)),
      faceDown,
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

  function resetBoardPositions() {
    setGame((current) => {
      let battlefieldIndex = 0;

      return {
        ...current,
        instances: current.instances.map((card) => {
          if (card.zone !== "battlefield") {
            return card;
          }

          const position = defaultFreePosition(battlefieldIndex);
          battlefieldIndex += 1;

          return {
            ...card,
            battlefieldPosition: position,
          };
        }),
        actions: [createAction("Reset battlefield positions."), ...current.actions],
      };
    });
  }

  function onDrop(event: DragEvent<HTMLElement>, zone: ZoneId, lane?: BattlefieldLane) {
    event.preventDefault();
    const cardId = event.dataTransfer.getData("text/plain") || draggedId;
    if (cardId) {
      moveCard(cardId, zone, lane);
    }
    setDraggedId(undefined);
  }

  function startSolo() {
    setMode("solo");
    setIsConnected(false);
    setPeersById({});
  }

  function joinLobby() {
    setRoomCode(roomCode.trim().toUpperCase() || createRoomCode());
    saveRelayUrl(relayUrl);
    setMode("multiplayer");
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
    setStatus("Back in solo sandbox mode.");
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

  return (
    <main
      className={`app-shell ${leftPanelOpen ? "" : "is-left-collapsed"} ${
        rightPanelOpen ? "" : "is-right-collapsed"
      }`}
      style={{ "--zone-scale": layoutScale } as CSSProperties}
      onMouseLeave={() => setHoverPreview(undefined)}
    >
      <button
        className="panel-tab panel-tab-left"
        onClick={() => setLeftPanelOpen((current) => !current)}
      >
        {leftPanelOpen ? "Hide deck" : "Deck & room"}
      </button>
      <button
        className="panel-tab panel-tab-right"
        onClick={() => setRightPanelOpen((current) => !current)}
      >
        {rightPanelOpen ? "Hide details" : "Details & chat"}
      </button>

      {leftPanelOpen && <aside className="sidebar">
        <div className="panel-titlebar">
          <div>
            <span>Deck & room</span>
            <small>Import, lobby, setup</small>
          </div>
          <button onClick={() => setLeftPanelOpen(false)}>Close</button>
        </div>
        <div className="brand-block">
          <p className="eyebrow">MTG Duels</p>
          <h1>Sandbox table</h1>
          <p>
            Import a real deck, draw an opening hand, and move cards freely while
            you test lines before buying.
          </p>
        </div>

        <section className="room-panel" aria-label="Room mode">
          <p className="eyebrow">Play mode</p>
          <div className="mode-switch">
            <button className={mode === "solo" ? "is-active" : ""} onClick={startSolo}>
              Solo
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
              <label htmlFor="relay-url">Relay URL</label>
              <input
                id="relay-url"
                value={relayUrl}
                onChange={(event) => setRelayUrl(event.target.value)}
                placeholder="wss://relay.example.com"
              />
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
          ) : (
            <p className="status-line">Solo mode stays local and private.</p>
          )}
        </section>

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
        </section>

        <section className="quick-controls" aria-label="Game controls">
          <p className="eyebrow">Table actions</p>
          <button onClick={() => draw(1)}>Draw 1</button>
          <button onClick={() => draw(7)}>Draw 7</button>
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
      </aside>}

      <section className="tabletop" aria-label="Play table">
        <header className="table-header">
          <div>
            <p className="eyebrow">{connectedRoomLabel}</p>
            <h2>{mode === "multiplayer" ? "Lobby table" : "Goldfish mode"}</h2>
          </div>
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
            min="0.75"
            max="1.45"
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
          <button className="reset-board-button" onClick={resetBoardPositions}>
            Reset board
          </button>
        </section>

        {mode === "multiplayer" && (
          <section className="opponents-panel" aria-label="Other players">
            {peers.length ? (
              peers.map((peer) => (
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
                No one else is in this room yet. Join {roomCode.toUpperCase()} from
                another {relayEnabled ? "device using the same relay" : "tab in this browser"}.
              </p>
            )}
          </section>
        )}

        <div className="zones-grid">
          {visibleZones.map((zone) => (
            <section
              key={zone.id}
              className={`zone zone-${zone.id} ${
                game.activeZone === zone.id ? "is-active" : ""
              }`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, zone.id)}
            >
              <button
                className="zone-heading"
                onClick={() =>
                  setGame((current) => ({ ...current, activeZone: zone.id }))
                }
              >
                <span>
                  <strong>{zone.label}</strong>
                  <small>{zone.helper}</small>
                </span>
                <b>{zone.cards.length}</b>
              </button>

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
                  onFreeMove={moveFreeBattlefieldCard}
                  onSelect={(card) => {
                    setSelectedRemote(undefined);
                    setGame((current) => ({
                      ...current,
                      selectedId: card.instanceId,
                      activeZone: zone.id,
                    }));
                  }}
                  onDragStart={(event, card) => {
                    setDraggedId(card.instanceId);
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
                  cardScale={cardScale}
                  onHoverCard={(card, event) => showCardPreview(card, game.cardsById[card.cardId], event)}
                  onLeaveCard={() => setHoverPreview(undefined)}
                  onSelect={(card) => {
                    setSelectedRemote(undefined);
                    setGame((current) => ({
                      ...current,
                      selectedId: card.instanceId,
                      activeZone: zone.id,
                    }));
                  }}
                  onDragStart={(event, card) => {
                    setDraggedId(card.instanceId);
                    event.dataTransfer.setData("text/plain", card.instanceId);
                  }}
                />
              )}
            </section>
          ))}
        </div>
      </section>

      {rightPanelOpen && <aside className="inspector">
        <div className="panel-titlebar">
          <div>
            <span>Details & table log</span>
            <small>Selected card, damage, chat</small>
          </div>
          <button onClick={() => setRightPanelOpen(false)}>Close</button>
        </div>
        <section className="selected-panel" aria-label="Selected card">
          <p className="eyebrow">Selected</p>
          {selectedRemoteCard && selectedRemoteData && selectedRemotePlayer ? (
            <>
              <div className="selected-preview">
                {selectedRemoteData.imageUrl && !selectedRemoteCard.faceDown ? (
                  <img src={selectedRemoteData.imageUrl} alt={selectedRemoteData.name} />
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
          ) : selected && selectedData ? (
            <>
              <div className="selected-preview">
                {selectedData.imageUrl && !selected.faceDown ? (
                  <img src={selectedData.imageUrl} alt={selectedData.name} />
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
                      { faceDown: !selected.faceDown },
                      `${selected.faceDown ? "Revealed" : "Turned face down"} ${selected.name}.`,
                    )
                  }
                >
                  {selected.faceDown ? "Reveal" : "Face down"}
                </button>
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
                    <span>
                      {type} <b>{selected.counters[type] ?? 0}</b>
                    </span>
                    <button onClick={() => changeCounter(type, -1)}>-</button>
                    <button onClick={() => changeCounter(type, 1)}>+</button>
                  </div>
                ))}
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
      </aside>}
      {hoverPreview && (
        <div
          className="hover-preview"
          style={{
            left: hoverPreview.x,
            top: hoverPreview.y,
          }}
        >
          {hoverPreview.card.imageUrl && !hoverPreview.faceDown ? (
            <img src={hoverPreview.card.imageUrl} alt={hoverPreview.card.name} />
          ) : (
            <div className="card-back">MTG</div>
          )}
        </div>
      )}
    </main>
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
  cardScale,
  onHoverCard,
  onLeaveCard,
  onSelect,
  onDragStart,
}: {
  zoneId: ZoneId;
  cards: CardInstance[];
  cardsById: Record<string, CardData>;
  selectedId?: string;
  libraryView: "hidden" | "scry" | "search";
  scryCount: number;
  cardScale: number;
  onHoverCard: (card: CardInstance, event: MouseEvent<HTMLElement>) => void;
  onLeaveCard: () => void;
  onSelect: (card: CardInstance) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, card: CardInstance) => void;
}) {
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
  onFreeMove,
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
  onFreeMove: (cardId: string, x: number, y: number) => void;
  onSelect: (card: CardInstance) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, card: CardInstance) => void;
}) {
  if (layout === "free") {
    return (
      <div
        className="battlefield-free"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDrop(event, "battlefield")}
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
          />
        ))}
      </div>
    );
  }

  return (
    <div className="battlefield-lanes">
      {battlefieldLanes.map((lane) => {
        const laneCards = cards.filter((card) => card.battlefieldLane === lane.id);

        return (
          <section
            className={`battlefield-lane lane-${lane.id}`}
            key={lane.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, "battlefield", lane.id)}
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
                  onSelect={() => onSelect(card)}
                  onDragStart={(event) => onDragStart(event, card)}
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
}: {
  card: CardInstance;
  data?: CardData;
  isSelected: boolean;
  cardScale: number;
  onHover: (event: MouseEvent<HTMLElement>) => void;
  onLeave: () => void;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
}) {
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
  const battlefield = peer.publicCards.filter((card) => card.zone === "battlefield");
  const command = peer.publicCards.filter((card) => card.zone === "command");
  const graveyard = peer.publicCards.filter((card) => card.zone === "graveyard");
  const exile = peer.publicCards.filter((card) => card.zone === "exile");

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
              cards={battlefield.filter((card) => card.battlefieldLane === lane.id)}
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
          const imageUrl = card.faceDown ? undefined : data?.imageUrl;
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
          const imageUrl = card.faceDown ? undefined : data?.imageUrl;
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
  onDragStart,
  onDragEnd,
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
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
}) {
  const imageUrl = card.faceDown ? undefined : data?.imageUrl;
  const counters = visibleCounters(card.counters);

  return (
    <button
      className={`card-tile ${isSelected ? "is-selected" : ""} ${
        card.tapped ? "is-tapped" : ""
      } ${compact ? "is-compact" : ""}`}
      onClick={onSelect}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
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
              {shortCounterName(type)} {value}
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
      isToken: card.isToken,
      isGenerated: card.isGenerated,
      battlefieldLane: card.battlefieldLane,
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

function buildTokenBankForDeck(cardsById: Record<string, CardData>, offset: number) {
  const tokenMatches = new Set<string>();
  Object.values(cardsById).forEach((card) => {
    const text = `${card.name} ${card.typeLine} ${card.oracleText}`.toLowerCase();
    tokenPresets.forEach((token) => {
      const tokenWords = token.name.toLowerCase().replace(/ token$/, "");
      const likelyToken =
        text.includes(`${tokenWords} token`) ||
        (token.name.includes("/") && text.includes("creature token")) ||
        (token.name === "Treasure Token" && text.includes("treasure")) ||
        (token.name === "Clue Token" && text.includes("clue")) ||
        (token.name === "Food Token" && text.includes("food")) ||
        (token.name === "Blood Token" && text.includes("blood"));

      if (likelyToken) {
        tokenMatches.add(token.name);
      }
    });
  });

  const cards: Record<string, CardData> = {};
  const instances = Array.from(tokenMatches).map((tokenName, index) => {
    const token = tokenPresets.find((preset) => preset.name === tokenName)!;
    const card: CardData = {
      id: `token-${token.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: token.name,
      typeLine: token.typeLine,
      oracleText: token.oracleText,
      cmc: 0,
    };
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
      isToken: true,
      isGenerated: true,
      battlefieldLane: inferTokenLane(card),
      battlefieldPosition: defaultFreePosition(offset + index),
    };
  });

  return { cards, instances };
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

function getOrCreatePlayerId(): string {
  return crypto.randomUUID();
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
