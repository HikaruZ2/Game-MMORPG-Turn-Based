import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Store connected players: socketId -> PlayerData
const players = new Map();

// Helper to get local network IP addresses
function getNetworkIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// REST endpoints for health check and status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    serverTime: new Date().toISOString(),
    playerCount: players.size,
    players: Array.from(players.values()),
    networkIps: getNetworkIps()
  });
});

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // 1. Player joins game
  socket.on('player:join', (playerData) => {
    const player = {
      id: socket.id,
      name: playerData.name || `ผู้กล้า_${socket.id.slice(0, 4)}`,
      role: playerData.role || 'fighter',
      level: playerData.level || 1,
      pvpRank: playerData.pvpRank || 'Unranked',
      pvpPoints: playerData.pvpPoints || 0,
      title: playerData.title || '',
      zoneId: playerData.zoneId || 'town',
      x: playerData.x ?? 600,
      y: playerData.y ?? 440,
      direction: playerData.direction || 'down',
      isMoving: false,
      chat: ''
    };

    players.set(socket.id, player);
    console.log(`[Player Joined] ${player.name} (Role: ${player.role}, Level: ${player.level}) in Zone: ${player.zoneId}`);

    // Send current world state back to the newly joined player
    socket.emit('player:init', {
      selfId: socket.id,
      players: Array.from(players.values()).filter(p => p.id !== socket.id)
    });

    // Broadcast newly joined player to everyone else
    socket.broadcast.emit('player:joined', player);

    // Announce in chat
    io.emit('chat:message', {
      sender: 'System',
      text: `🎉 ผู้เล่น [${player.name}] เข้าสู่ดินแดนฮิคารุแล้ว!`,
      channel: 'system',
      timestamp: Date.now()
    });
  });

  // 2. Real-time Movement & Zone Updates
  socket.on('player:move', (moveData) => {
    const p = players.get(socket.id);
    if (!p) return;

    p.x = moveData.x;
    p.y = moveData.y;
    p.direction = moveData.direction || p.direction;
    p.isMoving = !!moveData.isMoving;
    if (moveData.zoneId) p.zoneId = moveData.zoneId;

    // Relay position to everyone else
    socket.broadcast.emit('player:moved', {
      id: socket.id,
      x: p.x,
      y: p.y,
      direction: p.direction,
      isMoving: p.isMoving,
      zoneId: p.zoneId
    });
  });

  // 3. Zone Transition
  socket.on('player:zone', (zoneData) => {
    const p = players.get(socket.id);
    if (!p) return;

    p.zoneId = zoneData.zoneId;
    p.x = zoneData.x ?? 600;
    p.y = zoneData.y ?? 440;

    socket.broadcast.emit('player:zone_changed', {
      id: socket.id,
      zoneId: p.zoneId,
      x: p.x,
      y: p.y
    });
  });

  // 4. In-Game Chat Broadcast
  socket.on('chat:send', (msgData) => {
    const p = players.get(socket.id);
    const sender = p ? p.name : msgData.sender || 'Unknown';
    const text = String(msgData.text || '').trim().slice(0, 100);
    const channel = msgData.channel || 'world';

    if (!text) return;

    // Store recent chat on player for overhead canvas speech bubble
    if (p) {
      p.chat = text;
      // Clear player bubble after 6 seconds
      setTimeout(() => {
        if (p && p.chat === text) p.chat = '';
      }, 6000);
    }

    io.emit('chat:message', {
      id: `${socket.id}_${Date.now()}`,
      sender,
      role: p?.role || 'fighter',
      text,
      channel,
      senderSocketId: socket.id,
      timestamp: Date.now()
    });
  });

  // 5. PVP Challenge request
  socket.on('pvp:challenge', ({ targetSocketId, challengerInfo }) => {
    const challenger = players.get(socket.id);
    if (!challenger) return;

    console.log(`[PVP Challenge] ${challenger.name} challenged ${targetSocketId}`);
    io.to(targetSocketId).emit('pvp:challenged', {
      fromSocketId: socket.id,
      challenger: {
        id: socket.id,
        name: challenger.name,
        role: challenger.role,
        level: challenger.level,
        pvpRank: challenger.pvpRank,
        ...challengerInfo
      }
    });
  });

  // 6. PVP Response (Accept / Decline)
  socket.on('pvp:response', ({ challengerSocketId, accepted }) => {
    const responder = players.get(socket.id);
    const challenger = players.get(challengerSocketId);

    if (!challenger || !responder) return;

    if (accepted) {
      console.log(`[PVP Accepted] ${responder.name} vs ${challenger.name}`);
      const roomId = `pvp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      // Notify challenger
      io.to(challengerSocketId).emit('pvp:match_start', {
        roomId,
        isFirstTurn: true,
        opponent: {
          id: socket.id,
          name: responder.name,
          role: responder.role,
          level: responder.level,
          pvpRank: responder.pvpRank
        }
      });

      // Notify responder
      socket.emit('pvp:match_start', {
        roomId,
        isFirstTurn: false,
        opponent: {
          id: challengerSocketId,
          name: challenger.name,
          role: challenger.role,
          level: challenger.level,
          pvpRank: challenger.pvpRank
        }
      });

      // Announce in chat
      io.emit('chat:message', {
        sender: 'System',
        text: `⚔️ ศึกประลองเดือด! [${challenger.name}] VS [${responder.name}] เริ่มต้นขึ้นแล้ว!`,
        channel: 'system',
        timestamp: Date.now()
      });
    } else {
      io.to(challengerSocketId).emit('pvp:declined', {
        targetName: responder.name
      });
    }
  });

  // 7. PVP In-Battle Skill / Action Relay
  socket.on('pvp:battle_action', ({ targetSocketId, action }) => {
    io.to(targetSocketId).emit('pvp:battle_action', action);
  });

  // 8. Disconnect Cleanup
  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      console.log(`[Player Left] ${p.name} (${socket.id})`);
      players.delete(socket.id);

      socket.broadcast.emit('player:left', {
        id: socket.id,
        name: p.name
      });

      io.emit('chat:message', {
        sender: 'System',
        text: `👋 ผู้เล่น [${p.name}] ออกจากเซิร์ฟเวอร์แล้ว`,
        channel: 'system',
        timestamp: Date.now()
      });
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = getNetworkIps();
  console.log('\n=============================================================');
  console.log('🌟 HIKARU MULTIPLAYER SERVER STARTED SUCCESSFULLY!');
  console.log(`📡 Local Server:   http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`🌐 Network Server: http://${ip}:${PORT}`);
    console.log(`👉 Friends can join via: http://${ip}:5173`);
  });
  console.log('=============================================================\n');
});
