import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 8787);
const maxMessageBytes = Number(process.env.MAX_MESSAGE_BYTES ?? 64 * 1024);
const maxClients = Number(process.env.MAX_CLIENTS ?? 200);
const maxClientsPerRoom = Number(process.env.MAX_CLIENTS_PER_ROOM ?? 8);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30000);
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const rooms = new Map();

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: wss.clients.size }));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("MTG Duels multiplayer relay\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket, request) => {
  if (!isAllowedOrigin(request.headers.origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }

  if (wss.clients.size > maxClients) {
    socket.close(1013, "Relay full");
    return;
  }

  let activeRoom;
  let playerId;
  let playerName;
  socket.isAlive = true;

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (rawMessage) => {
    if (rawMessage.length > maxMessageBytes) {
      socket.close(1009, "Message too large");
      return;
    }

    const envelope = parseEnvelope(rawMessage);
    if (!envelope) {
      return;
    }

    if (activeRoom && activeRoom !== envelope.roomCode) {
      leaveRoom(socket, activeRoom, playerId, playerName);
    }

    activeRoom = envelope.roomCode;
    playerId = envelope.message.playerId;
    if ("playerName" in envelope.message) {
      playerName = envelope.message.playerName;
    }
    const room = getRoom(activeRoom);

    if (!room.has(socket) && room.size >= maxClientsPerRoom) {
      socket.close(1013, "Room full");
      return;
    }

    room.add(socket);

    broadcastToRoom(room, envelope);

    if (envelope.message.type === "leave") {
      room.delete(socket);
      if (room.size === 0) {
        rooms.delete(activeRoom);
      }
      activeRoom = undefined;
    }
  });

  socket.on("close", () => {
    if (!activeRoom) {
      return;
    }

    leaveRoom(socket, activeRoom, playerId, playerName);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }

    socket.isAlive = false;
    socket.ping();
  });
}, heartbeatIntervalMs);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(port, () => {
  console.log(`MTG Duels relay listening on ws://localhost:${port}`);
});

function getRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) {
    return room;
  }

  const nextRoom = new Set();
  rooms.set(roomCode, nextRoom);
  return nextRoom;
}

function leaveRoom(socket, roomCode, playerId, playerName) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }

  room.delete(socket);
  if (playerId) {
    broadcastToRoom(room, {
      roomCode,
      message: {
        type: "leave",
        playerId,
        playerName: playerName ?? "Player",
        roomCode,
      },
    });
  }

  if (room.size === 0) {
    rooms.delete(roomCode);
  }
}

function broadcastToRoom(room, envelope) {
  const payload = JSON.stringify(envelope);
  room.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function parseEnvelope(rawMessage) {
  try {
    const envelope = JSON.parse(rawMessage.toString());
    if (
      typeof envelope?.roomCode !== "string" ||
      typeof envelope?.message?.type !== "string" ||
      typeof envelope?.message?.playerId !== "string"
    ) {
      return undefined;
    }

    return {
      roomCode: envelope.roomCode.toUpperCase(),
      message: envelope.message,
    };
  } catch {
    return undefined;
  }
}

function parseAllowedOrigins(value) {
  if (!value) {
    return undefined;
  }

  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isAllowedOrigin(origin) {
  return !allowedOrigins || (origin && allowedOrigins.has(origin));
}
