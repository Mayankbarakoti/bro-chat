const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public folder (index.html, profile.html, chat.html)
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server and attach Express app
const server = http.createServer(app);

// Create WebSocket server on the same HTTP server
const wss = new WebSocket.Server({ server });

// To keep track of waiting user for pairing
let waitingUser = null;

// Function to pair two users
function pairUsers(ws1, ws2) {
  ws1.partner = ws2;
  ws2.partner = ws1;

  // Inform both users that they are connected
  ws1.send(JSON.stringify({ type: 'info', message: 'You are connected to a chat partner.' }));
  ws2.send(JSON.stringify({ type: 'info', message: 'You are connected to a chat partner.' }));
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New user connected');

  // If someone is waiting, pair them
  if (waitingUser) {
    pairUsers(waitingUser, ws);
    waitingUser = null;
  } else {
    // No one waiting, so current user waits
    waitingUser = ws;
    ws.send(JSON.stringify({ type: 'info', message: 'Waiting for a chat partner...' }));
  }

  // Listen for messages from client
  ws.on('message', (message) => {
    console.log('Received:', message);

    // Forward message to partner if connected
    if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
      ws.partner.send(message);
    }
  });

  // Handle connection close
  ws.on('close', () => {
    console.log('User disconnected');

    // Inform partner if connected
    if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
      ws.partner.send(JSON.stringify({ type: 'info', message: 'Your chat partner left.' }));
      ws.partner.partner = null;
    }

    // If user was waiting, remove them from waiting queue
    if (waitingUser === ws) {
      waitingUser = null;
    }
  });

  // Ping-pong to keep connection alive
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Ping all clients every 30 seconds to keep connection alive
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Start server
server.listen(PORT, () => {
  console.log(`BRO-CHATT running at http://localhost:${PORT}`);
});
