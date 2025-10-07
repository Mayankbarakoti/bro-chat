// ───────────────────────────────────────────────
// 💬 Mystery Meet Server (v2)
// Supports: 1-on-1 Chat + Group Chat with Live Group List
// ───────────────────────────────────────────────

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Serve frontend files (public folder)
app.use(express.static(path.join(__dirname, "public")));

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// ─── Data Structures ──────────────────────────────
let waitingUser = null; // waiting for 1v1 pairing
const pairings = new Map(); // ws → partner ws
const groups = new Map(); // groupName → Set<ws>
const userMeta = new Map(); // ws → {nickname, avatar, type, group?}

// ─── Utility ──────────────────────────────────────
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Broadcast Groups List ───────────────────────
function broadcastGroups() {
  const allGroups = [];

  for (const [name, members] of groups) {
    const users = [];
    for (const m of members) {
      const meta = userMeta.get(m);
      users.push(meta?.nickname || "Anonymous");
    }
    allGroups.push({ name, users });
  }

  const payload = { type: "groupsData", groups: allGroups };
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      send(client, payload);
    }
  }
}

// ─── 1v1 Chat Logic ───────────────────────────────
function pairUsers(ws1, ws2) {
  pairings.set(ws1, ws2);
  pairings.set(ws2, ws1);
  send(ws1, { type: "system", event: "partner_connected", text: "Connected to a stranger!" });
  send(ws2, { type: "system", event: "partner_connected", text: "Connected to a stranger!" });
}

function disconnect1v1(ws, notifyPartner = true) {
  const partner = pairings.get(ws);
  if (partner) {
    pairings.delete(partner);
    pairings.delete(ws);
    if (notifyPartner && partner.readyState === WebSocket.OPEN) {
      send(partner, { type: "system", event: "partner_left", text: "Stranger left the chat." });
    }
  }
  if (waitingUser === ws) waitingUser = null;
  userMeta.delete(ws);
}

// ─── Group Chat Logic ─────────────────────────────
function leaveGroup(ws) {
  const meta = userMeta.get(ws);
  if (meta && meta.group) {
    const groupName = meta.group;
    const members = groups.get(groupName);
    if (members) {
      members.delete(ws);
      if (members.size === 0) groups.delete(groupName);
    }
    meta.group = null;
    send(ws, { type: "system", event: "leftGroup", text: `Left group "${groupName}"` });
  }
  userMeta.set(ws, { ...userMeta.get(ws), group: null });
  broadcastGroups();
}

// ─── WebSocket Connection ─────────────────────────
wss.on("connection", (ws) => {
  console.log("⚡ New Mystery Meet user connected!");

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn("❌ Invalid JSON message");
      return;
    }

    switch (data.type) {
      // ─── 1v1 Chat ─────────────────────────────
      case "join1v1": {
        userMeta.set(ws, { type: "1v1", nickname: data.nickname, avatar: data.avatar });
        if (waitingUser && waitingUser !== ws && waitingUser.readyState === WebSocket.OPEN) {
          pairUsers(ws, waitingUser);
          waitingUser = null;
        } else {
          waitingUser = ws;
          send(ws, { type: "system", event: "waiting", text: "Waiting for a mystery partner..." });
        }
        break;
      }

      case "message1v1": {
        const partner = pairings.get(ws);
        if (partner && partner.readyState === WebSocket.OPEN) {
          const meta = userMeta.get(ws);
          send(partner, { type: "message1v1", text: data.text, nickname: meta.nickname, avatar: meta.avatar });
        }
        break;
      }

      case "typing1v1": {
        const partner = pairings.get(ws);
        if (partner && partner.readyState === WebSocket.OPEN) {
          send(partner, { type: "typing1v1", nickname: userMeta.get(ws)?.nickname || "" });
        }
        break;
      }

      case "leave1v1":
      case "disconnect1v1":
        disconnect1v1(ws);
        break;

      case "new1v1":
        disconnect1v1(ws, false);
        if (waitingUser && waitingUser !== ws && waitingUser.readyState === WebSocket.OPEN) {
          pairUsers(ws, waitingUser);
          waitingUser = null;
        } else {
          waitingUser = ws;
          send(ws, { type: "system", event: "waiting", text: "Waiting for a mystery partner..." });
        }
        break;

      // ─── Group Chat ───────────────────────────
      case "createGroup": {
        const groupName = data.group?.trim();
        if (!groupName) {
          send(ws, { type: "system", event: "error", text: "Group name is required." });
          return;
        }

        const nickname = data.nickname || "Anonymous";
        const avatar = data.avatar || "";

        if (userMeta.get(ws)?.group) leaveGroup(ws);

        if (!groups.has(groupName)) groups.set(groupName, new Set());
        groups.get(groupName).add(ws);

        userMeta.set(ws, { type: "group", nickname, avatar, group: groupName });
        send(ws, { type: "system", event: "joinedGroup", group: groupName, text: `Created & joined "${groupName}"` });
        broadcastGroups();
        break;
      }

      case "joinGroup": {
        const nickname = data.nickname || "Anonymous";
        const avatar = data.avatar || "";
        const groupName = data.group;

        if (!groupName) {
          send(ws, { type: "system", event: "error", text: "Invalid group name." });
          return;
        }

        if (!groups.has(groupName)) groups.set(groupName, new Set());
        groups.get(groupName).add(ws);

        userMeta.set(ws, { type: "group", nickname, avatar, group: groupName });
        send(ws, { type: "system", event: "joinedGroup", group: groupName });
        broadcastGroups();
        break;
      }

      case "messageGroup": {
        const meta = userMeta.get(ws);
        if (!meta?.group) return;
        const members = groups.get(meta.group);
        if (!members) return;

        const payload = { type: "messageGroup", nickname: meta.nickname, avatar: meta.avatar, text: data.text };
        for (const m of members) if (m !== ws && m.readyState === WebSocket.OPEN) send(m, payload);
        break;
      }

      case "typingGroup": {
        const meta = userMeta.get(ws);
        if (!meta?.group) return;
        const members = groups.get(meta.group);
        if (!members) return;

        for (const m of members)
          if (m !== ws && m.readyState === WebSocket.OPEN)
            send(m, { type: "typingGroup", nickname: meta.nickname });
        break;
      }

      case "leaveGroup":
        leaveGroup(ws);
        break;

      case "getGroups":
        const list = [];
        for (const [name, members] of groups) {
          const users = [];
          for (const m of members) users.push(userMeta.get(m)?.nickname || "Anonymous");
          list.push({ name, users });
        }
        send(ws, { type: "groupsData", groups: list });
        break;

      case "report":
        console.log(`🚨 Report from ${userMeta.get(ws)?.nickname}:`, data);
        break;

      default:
        console.warn("Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    disconnect1v1(ws);
    leaveGroup(ws);
    userMeta.delete(ws);
    if (waitingUser === ws) waitingUser = null;
  });

  ws.on("error", () => {
    disconnect1v1(ws);
    leaveGroup(ws);
    userMeta.delete(ws);
    if (waitingUser === ws) waitingUser = null;
  });
});

// ─── Start Server ────────────────────────────────
const PORT = process.env.PORT || 4014;
server.listen(PORT, () => {
  console.log(`✅ Mystery Meet 💬 server running on http://localhost:${PORT}`);
});
