import type { LobbyWireMessage } from "./types";

type LobbyEnvelope = {
  roomCode: string;
  message: LobbyWireMessage;
};

const CONFIGURED_RELAY_URL = import.meta.env.VITE_MTG_DUELS_RELAY_URL?.trim() ?? "";

export type LobbyTransportStatus = "local" | "connecting" | "connected" | "error";

export type LobbyTransport = {
  postMessage: (message: LobbyWireMessage) => void;
  close: () => void;
};

export type LobbyTransportOptions = {
  roomCode: string;
  relayUrl: string;
  onMessage: (message: LobbyWireMessage) => void;
  onStatusChange: (status: LobbyTransportStatus) => void;
  getOpenMessages?: () => LobbyWireMessage[];
};

export function createLobbyTransport({
  roomCode,
  relayUrl,
  onMessage,
  onStatusChange,
  getOpenMessages,
}: LobbyTransportOptions): LobbyTransport {
  const normalizedRoom = roomCode.toUpperCase();
  const normalizedRelayUrl = relayUrl.trim();

  if (normalizedRelayUrl) {
    return createWebSocketTransport(
      normalizedRelayUrl,
      normalizedRoom,
      onMessage,
      onStatusChange,
      getOpenMessages,
    );
  }

  onStatusChange("local");
  return createBroadcastChannelTransport(normalizedRoom, onMessage);
}

export function getSavedRelayUrl(): string {
  const envRelayUrl = getConfiguredRelayUrl();
  const savedRelayUrl = window.localStorage.getItem("mtg-duels-relay-url");
  return envRelayUrl || savedRelayUrl || "";
}

export function getConfiguredRelayUrl(): string {
  return CONFIGURED_RELAY_URL;
}

export function saveRelayUrl(relayUrl: string) {
  const trimmed = relayUrl.trim();
  if (trimmed) {
    window.localStorage.setItem("mtg-duels-relay-url", trimmed);
  } else {
    window.localStorage.removeItem("mtg-duels-relay-url");
  }
}

function createBroadcastChannelTransport(
  roomCode: string,
  onMessage: (message: LobbyWireMessage) => void,
): LobbyTransport {
  const channel = new BroadcastChannel(`mtg-duels-room-${roomCode}`);
  channel.onmessage = (event: MessageEvent<LobbyWireMessage>) => {
    onMessage(event.data);
  };

  return {
    postMessage: (message) => channel.postMessage(message),
    close: () => channel.close(),
  };
}

function createWebSocketTransport(
  relayUrl: string,
  roomCode: string,
  onMessage: (message: LobbyWireMessage) => void,
  onStatusChange: (status: LobbyTransportStatus) => void,
  getOpenMessages?: () => LobbyWireMessage[],
): LobbyTransport {
  const queuedMessages: LobbyWireMessage[] = [];
  let socket: WebSocket | undefined;
  let isClosed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | undefined;

  const connect = () => {
    if (isClosed) {
      return;
    }

    onStatusChange("connecting");
    socket = new WebSocket(relayUrl);

    socket.addEventListener("open", () => {
      if (isClosed || !socket) {
        return;
      }

      reconnectAttempts = 0;
      onStatusChange("connected");
      getOpenMessages?.().forEach((message) => {
        if (socket?.readyState === WebSocket.OPEN) {
          sendEnvelope(socket, roomCode, message);
        }
      });
      queuedMessages.splice(0).forEach((message) => {
        if (socket?.readyState === WebSocket.OPEN) {
          sendEnvelope(socket, roomCode, message);
        }
      });
    });

    socket.addEventListener("message", (event) => {
      const message = parseRelayMessage(event.data, roomCode);
      if (message) {
        onMessage(message);
      }
    });

    socket.addEventListener("error", () => {
      if (!isClosed) {
        onStatusChange("error");
      }
    });

    socket.addEventListener("close", () => {
      if (!isClosed) {
        onStatusChange("error");
        scheduleReconnect();
      }
    });
  };

  const scheduleReconnect = () => {
    if (isClosed || reconnectTimer !== undefined) {
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const queueMessage = (message: LobbyWireMessage) => {
    const existingStateIndex =
      message.type === "state"
        ? queuedMessages.findIndex(
            (queued) => queued.type === "state" && queued.playerId === message.playerId,
          )
        : -1;

    if (existingStateIndex >= 0) {
      queuedMessages[existingStateIndex] = message;
      return;
    }

    queuedMessages.push(message);
    if (queuedMessages.length > 100) {
      queuedMessages.shift();
    }
  };

  connect();

  return {
    postMessage: (message) => {
      if (socket?.readyState === WebSocket.OPEN) {
        sendEnvelope(socket, roomCode, message);
        return;
      }

      queueMessage(message);
    },
    close: () => {
      isClosed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    },
  };
}

function sendEnvelope(socket: WebSocket, roomCode: string, message: LobbyWireMessage) {
  socket.send(JSON.stringify({ roomCode, message } satisfies LobbyEnvelope));
}

function parseRelayMessage(data: unknown, roomCode: string): LobbyWireMessage | undefined {
  if (typeof data !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(data) as Partial<LobbyEnvelope> | LobbyWireMessage;
    if (parsed && typeof parsed === "object" && "roomCode" in parsed && "message" in parsed) {
      return parsed.roomCode === roomCode ? parsed.message : undefined;
    }

    return parsed as LobbyWireMessage;
  } catch {
    return undefined;
  }
}
