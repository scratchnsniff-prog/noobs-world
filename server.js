'use strict';

/*
 * Noob World server
 *
 * - Serves the game from the /public folder
 * - Runs the multiplayer connection at /ws (a WebSocket)
 * - Needs nothing installed: just Node 18 or newer, then `node server.js`
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Settings you can change ----------
const PORT = Number(process.env.PORT) || 3000;
// Normally the game files live in the /public folder. If an upload to GitHub lost that
// folder, fall back to the folder next to server.js so the game still starts.
function findPublicDir() {
  const candidates = [path.join(__dirname, 'public'), __dirname];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}
const PUBLIC_DIR = findPublicDir();
const FLAT_LAYOUT = PUBLIC_DIR === __dirname;
const PRIVATE_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'readme.md']);

const MAX_PLAYERS = 60;            // people allowed in the world at once
const MAX_SOCKETS = 200;           // open connections allowed (includes people on the name screen)
const SNAPSHOT_MS = 66;            // how often positions are sent out (about 15 times a second)
const NAME_MIN = 2;
const NAME_MAX = 16;
const CHAT_MAX = 100;              // longest chat message
const CHAT_COOLDOWN_MS = 800;      // minimum time between one player's messages
const BLOCKED_WORDS = [];          // add lowercase words here, e.g. ['word']. They show up as ****

// The walkable area. Keep these in step with CONFIG in public/index.html.
const WORLD = { minX: 40, maxX: 960, minY: 478, maxY: 574, maxJump: 120 };
const ANIMS = new Set(['idle', 'walk', 'jump', 'drink', 'burger', 'dance']);

// ---------- Static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const tryFiles = [filePath];
  // A flat upload may have lost the /assets folder, so also try the file name on its own
  const flatPath = path.join(PUBLIC_DIR, path.basename(urlPath));
  if (flatPath !== filePath) tryFiles.push(flatPath);

  const sendFirstFound = (i) => {
    if (i >= tryFiles.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    if (FLAT_LAYOUT && PRIVATE_FILES.has(path.basename(tryFiles[i]).toLowerCase())) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    fs.stat(tryFiles[i], (err, stat) => {
      if (err || !stat.isFile()) return sendFirstFound(i + 1);
      sendFile(tryFiles[i], stat);
    });
  };
  sendFirstFound(0);

  function sendFile(filePath, stat) {

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    };

    // Byte ranges: Safari needs these to play audio files
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] !== '' || range[2] !== '')) {
      if (range[1] === '') {
        start = Math.max(0, stat.size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
    }

    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  }
}

const server = http.createServer(serveStatic);
server.on('error', (err) => {
  console.error('Web server error:', err);
  process.exitCode = 1;
});

// ---------- Minimal WebSocket (RFC 6455), no packages needed ----------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 4096;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function writeRaw(client, buf) {
  const s = client.socket;
  if (client.closed || s.destroyed || !s.writable) return;
  try { s.write(buf); } catch (e) { /* the close handler cleans up */ }
}

function send(client, obj) {
  writeRaw(client, frame(0x1, Buffer.from(JSON.stringify(obj))));
}

function closeClient(client, code) {
  if (client.closed) return;
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code || 1000, 0);
  writeRaw(client, frame(0x8, payload));
  try { client.socket.end(); } catch (e) { /* ignore */ }
  dropClient(client);
}

// ---------- Game state ----------
let nextId = 1;
const clients = new Set();
const players = new Map(); // id -> player

function publicPlayer(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, jy: p.jy, f: p.f, a: p.a };
}

function broadcast(obj, exceptClient) {
  const buf = frame(0x1, Buffer.from(JSON.stringify(obj)));
  for (const c of clients) {
    if (c.player && c !== exceptClient) writeRaw(c, buf);
  }
}

function dropClient(client) {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client);
  if (client.player) {
    players.delete(client.player.id);
    broadcast({ t: 'leave', id: client.player.id });
    console.log('left:', client.player.name, '(' + players.size + ' online)');
  }
  try { client.socket.destroy(); } catch (e) { /* ignore */ }
}

function num(v, lo, hi, fallback) {
  v = Number(v);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filterChat(text) {
  let out = text;
  for (const w of BLOCKED_WORDS) {
    if (!w) continue;
    out = out.replace(new RegExp(escapeRegExp(w), 'gi'), '*'.repeat(w.length));
  }
  return out;
}

function handleMessage(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;

  // Simple flood protection
  const now = Date.now();
  if (now - client.windowStart >= 1000) {
    client.windowStart = now;
    client.count = 0;
  }
  client.count++;
  if (client.count > 200) return closeClient(client, 1008);
  if (client.count > 60) return;

  if (msg.t === 'join') {
    if (client.player) return;
    const name = cleanText(msg.name, NAME_MAX);
    if (name.length < NAME_MIN) {
      return send(client, { t: 'error', code: 'name', text: 'Pick a name with ' + NAME_MIN + ' to ' + NAME_MAX + ' characters.' });
    }
    const lower = name.toLowerCase();
    for (const p of players.values()) {
      if (p.name.toLowerCase() === lower) {
        return send(client, { t: 'error', code: 'taken', text: 'Someone is already using that name. Try another.' });
      }
    }
    if (players.size >= MAX_PLAYERS) {
      return send(client, { t: 'error', code: 'full', text: 'The world is full right now. Try again in a minute.' });
    }

    const player = {
      id: nextId++,
      name,
      x: 380 + Math.round(Math.random() * 240),
      y: 540,
      jy: 0,
      f: 0,
      a: 'idle',
      dirty: false,
      lastChat: 0
    };
    client.player = player;
    players.set(player.id, player);

    send(client, {
      t: 'welcome',
      you: publicPlayer(player),
      players: [...players.values()].filter(p => p !== player).map(publicPlayer)
    });
    broadcast({ t: 'join', p: publicPlayer(player) }, client);
    console.log('joined:', name, '(' + players.size + ' online)');
    return;
  }

  const p = client.player;
  if (!p) return;

  if (msg.t === 'state') {
    const x = Math.round(num(msg.x, WORLD.minX, WORLD.maxX, p.x));
    const y = Math.round(num(msg.y, WORLD.minY, WORLD.maxY, p.y));
    const jy = Math.round(num(msg.jy, 0, WORLD.maxJump, 0));
    const f = msg.f ? 1 : 0;
    const a = ANIMS.has(msg.a) ? msg.a : 'idle';
    if (x !== p.x || y !== p.y || jy !== p.jy || f !== p.f || a !== p.a) {
      p.x = x; p.y = y; p.jy = jy; p.f = f; p.a = a;
      p.dirty = true;
    }
    return;
  }

  if (msg.t === 'chat') {
    if (now - p.lastChat < CHAT_COOLDOWN_MS) return;
    const text = filterChat(cleanText(msg.text, CHAT_MAX));
    if (!text) return;
    p.lastChat = now;
    broadcast({ t: 'chat', id: p.id, name: p.name, text });
  }
}

// ---------- WebSocket plumbing ----------
function handleFrame(client, fin, opcode, payload) {
  if (opcode === 0x8) return closeClient(client, 1000);                 // close
  if (opcode === 0x9) return writeRaw(client, frame(0xA, payload.slice(0, 125))); // ping -> pong
  if (opcode === 0xA) { client.alive = true; return; }                  // pong

  if (opcode === 0x1 || opcode === 0x0) {
    if (opcode === 0x1) client.fragments = [];
    if (!client.fragments) return;
    client.fragments.push(payload);
    client.fragBytes = (client.fragBytes || 0) + payload.length;
    if (client.fragBytes > MAX_FRAME_BYTES) return closeClient(client, 1009);
    if (fin) {
      const text = Buffer.concat(client.fragments).toString('utf8');
      client.fragments = null;
      client.fragBytes = 0;
      handleMessage(client, text);
    }
  }
  // binary frames (0x2) are ignored
}

function onData(client, chunk) {
  if (client.closed) return;
  client.buf = Buffer.concat([client.buf, chunk]);

  while (!client.closed) {
    const buf = client.buf;
    if (buf.length < 2) return;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      if (buf.readUInt32BE(2) !== 0) return closeClient(client, 1009);
      len = buf.readUInt32BE(6);
      offset = 10;
    }

    if (!masked) return closeClient(client, 1002);          // browsers always mask
    if (len > MAX_FRAME_BYTES) return closeClient(client, 1009);
    if (buf.length < offset + 4 + len) return;               // wait for the rest

    const mask = buf.slice(offset, offset + 4);
    const payload = Buffer.from(buf.slice(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    client.buf = buf.slice(offset + 4 + len);

    handleFrame(client, fin, opcode, payload);
  }
}

server.on('upgrade', (req, socket) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* ignore */ }
  const key = req.headers['sec-websocket-key'];

  if (pathname !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  if (clients.size >= MAX_SOCKETS) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const client = {
    socket,
    buf: Buffer.alloc(0),
    closed: false,
    alive: true,
    player: null,
    fragments: null,
    fragBytes: 0,
    windowStart: Date.now(),
    count: 0,
    connectedAt: Date.now()
  };
  clients.add(client);

  socket.on('data', chunk => onData(client, chunk));
  socket.on('close', () => dropClient(client));
  socket.on('error', () => dropClient(client));
});

// ---------- Timers ----------
// Send out everyone who moved since the last tick
setInterval(() => {
  const rows = [];
  for (const p of players.values()) {
    if (p.dirty) {
      rows.push([p.id, p.x, p.y, p.jy, p.f, p.a]);
      p.dirty = false;
    }
  }
  if (rows.length) broadcast({ t: 'snap', p: rows });
}, SNAPSHOT_MS);

// Drop connections that went quiet, and people who never picked a name
setInterval(() => {
  const now = Date.now();
  for (const c of [...clients]) {
    if (!c.alive || (!c.player && now - c.connectedAt > 120000)) {
      closeClient(c, 1001);
      continue;
    }
    c.alive = false;
    writeRaw(c, frame(0x9, Buffer.alloc(0)));
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Serving game files from: ' + PUBLIC_DIR);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    console.log('WARNING: index.html was not found. Files next to server.js: ' + fs.readdirSync(__dirname).join(', '));
  }
  console.log('Noob World is running on port ' + PORT);
  console.log('Open http://localhost:' + PORT + ' in your browser');
});
