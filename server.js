const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Serve frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket server on same HTTP server (upgrade handled internally)
const wss = new WebSocket.Server({ server });

// Data structures to manage users and groups
let waitingUser = null; // waiting for 1-on-1 pairing
const pairings = new Map(); // ws -> partner ws for 1-on-1
const rooms = new Map(); // groupName -> Set of ws in group
const userMeta = new Map(); // ws -> {type, nickname, avatar, group?}

// Utility to send JSON safely
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Pair two 1-on-1 users
function pairUsers(user1, user2) {
  pairings.set(user1, user2);
  pairings.set(user2, user1);

  send(user1, { type: 'system', event: 'partner_connected', text: 'Connected to a stranger!' });
  send(user2, { type: 'system', event: 'partner_connected', text: 'Connected to a stranger!' });
}

// Disconnect 1-on-1 user and notify partner
function disconnect1v1(ws, notifyPartner = true) {
  const partner = pairings.get(ws);
  if (partner) {
    pairings.delete(partner);
    pairings.delete(ws);
    if (notifyPartner) {
      send(partner, { type: 'system', event: 'partner_disconnected', text: 'Stranger disconnected.' });
    }
  }
  if (waitingUser === ws) waitingUser = null;
  userMeta.delete(ws);
}

// Remove user from a group
function leaveGroup(ws) {
  const meta = userMeta.get(ws);
  if (meta && meta.group) {
    const groupName = meta.group;
    const members = rooms.get(groupName);
    if (members) {
      members.delete(ws);
      if (members.size === 0) {
        rooms.delete(groupName); // delete empty group
      }
    }
    meta.group = null;
    send(ws, { type: 'system', event: 'leftGroup', text: `Left group "${groupName}"` });
  }
  userMeta.set(ws, {...userMeta.get(ws), group: null});
}

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn('Invalid JSON:', raw);
      return;
    }

    switch (data.type) {
      // 1-on-1 chat join request
      case 'join1v1': {
        userMeta.set(ws, { type: '1v1', nickname: data.nickname, avatar: data.avatar, group: null });
        if (waitingUser && waitingUser !== ws && waitingUser.readyState === WebSocket.OPEN) {
          pairUsers(ws, waitingUser);
          waitingUser = null;
        } else {
          waitingUser = ws;
          send(ws, { type: 'system', event: 'waiting', text: 'Waiting for a stranger to connect...' });
        }
        break;
      }

      // 1-on-1 chat message
      case 'message1v1': {
        const partner = pairings.get(ws);
        if (partner && partner.readyState === WebSocket.OPEN) {
          const meta = userMeta.get(ws) || {};
          send(partner, {
            type: 'message1v1',
            text: data.text,
            nickname: meta.nickname,
            avatar: meta.avatar,
          });
        }
        break;
      }

      // 1-on-1 typing indicator
      case 'typing1v1': {
        const partner = pairings.get(ws);
        if (partner && partner.readyState === WebSocket.OPEN) {
          send(partner, { type: 'typing1v1', nickname: userMeta.get(ws)?.nickname || '' });
        }
        break;
      }

      // 1-on-1 leave / disconnect / new chat
      case 'leave1v1':
      case 'disconnect1v1': {
        disconnect1v1(ws);
        break;
      }
      case 'new1v1': {
        disconnect1v1(ws, false);
        if (waitingUser && waitingUser !== ws && waitingUser.readyState === WebSocket.OPEN) {
          pairUsers(ws, waitingUser);
          waitingUser = null;
        } else {
          waitingUser = ws;
          send(ws, { type: 'system', event: 'waiting', text: 'Waiting for a stranger to connect...' });
        }
        break;
      }

      // Group chat join
      case 'joinGroup': {
        userMeta.set(ws, { type: 'group', nickname: data.nickname, avatar: data.avatar, group: data.group });
        if (!rooms.has(data.group)) rooms.set(data.group, new Set());
        rooms.get(data.group).add(ws);
        send(ws, { type: 'system', event: 'joinedGroup', group: data.group, text: `Joined group "${data.group}"` });
        break;
      }

      // Group chat message broadcast
      case 'messageGroup': {
        const meta = userMeta.get(ws);
        if (!meta || !meta.group) return;
        const groupName = meta.group;
        const members = rooms.get(groupName);
        if (!members) return;
        const messageData = {
          type: 'messageGroup',
          text: data.text,
          nickname: meta.nickname,
          avatar: meta.avatar,
        };
        for (const client of members) {
          if (client.readyState === WebSocket.OPEN && client !== ws) {
            send(client, messageData);
          }
        }
        break;
      }

      // Group typing indicator broadcast
      case 'typingGroup': {
        const meta = userMeta.get(ws);
        if (!meta || !meta.group) return;
        const groupName = meta.group;
        const members = rooms.get(groupName);
        if (!members) return;
        for (const client of members) {
          if (client.readyState === WebSocket.OPEN && client !== ws) {
            send(client, { type: 'typingGroup', nickname: meta.nickname });
          }
        }
        break;
      }

      // Group leave
      case 'leaveGroup': {
        leaveGroup(ws);
        break;
      }

      // Handle report/block events if needed
      case 'report': {
        console.log(`🚨 Report from ${userMeta.get(ws)?.nickname}:`, data);
        // Implement storage or moderation here
        break;
      }
      case 'block': {
        // Optional: handle block (disconnect partner in 1-on-1 or ignore in group)
        disconnect1v1(ws);
        send(ws, { type: 'system', event: 'partner_disconnected', text: 'Stranger blocked.' });
        break;
      }

      default:
        console.warn('Unknown message type:', data.type);
    }
  });

  ws.on('close', () => {
    // Clean up 1-on-1 pairing
    disconnect1v1(ws);
    // Remove from group if in any
    leaveGroup(ws);
    userMeta.delete(ws);
    if (waitingUser === ws) waitingUser = null;
  });

  ws.on('error', () => {
    disconnect1v1(ws);
    leaveGroup(ws);
    userMeta.delete(ws);
    if (waitingUser === ws) waitingUser = null;
  });
});

const PORT = process.env.PORT || 4005;
server.listen(PORT, () => {
  console.log(`✅ Bro‑Chat server running on http://localhost:${PORT}`);
});
