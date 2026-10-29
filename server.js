const express = require('express');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '1mb' }));

const origins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map((s) => s.trim())
  : '*';
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: { origin: origins }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Cria uma sessão leve de visitante. Não cria conta persistente.
app.post('/api/guest', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 24)
    || `Visitante-${Math.floor(100000 + Math.random() * 900000)}`;
  res.json({ success: true, name, token: randomUUID() });
});

const TEXT_CHANNELS = ['geral', 'jogos', 'memes'].map((id) => ({ id, vip: false }));
const VOICE_CHANNELS = ['Sala 1', 'Sala 2', 'Sala 3'].map((id) => ({ id, vip: false }));
const history = Object.fromEntries(TEXT_CHANNELS.map(({ id }) => [id, []]));
const voice = Object.fromEntries(VOICE_CHANNELS.map(({ id }) => [id, new Map()]));
const online = new Map();

function voiceSnapshot() {
  const out = {};
  for (const ch of VOICE_CHANNELS) {
    out[ch.id] = [...voice[ch.id].entries()].map(([id, u]) => ({ id, name: u.name, vip: false, role: 'user' }));
  }
  return out;
}
function presenceSnapshot() {
  return [...online.entries()].map(([id, u]) => ({ id, name: u.name, vip: false, role: 'user' }));
}
function leaveVoice(socket) {
  const ch = socket.data.voice;
  if (!ch || !voice[ch]) return;
  voice[ch].delete(socket.id);
  socket.leave('v:' + ch);
  socket.to('v:' + ch).emit('voice:peer-left', { id: socket.id });
  socket.data.voice = null;
  io.emit('voice:state', voiceSnapshot());
}
function sendInit(socket) {
  const name = socket.data.name || 'Visitante';
  socket.emit('init', {
    id: socket.id,
    me: { username: name, vip: false, role: 'user' },
    text: TEXT_CHANNELS,
    voice: VOICE_CHANNELS,
    voiceState: voiceSnapshot(),
    presence: presenceSnapshot()
  });
}

io.on('connection', (socket) => {
  socket.on('join', (rawName) => {
    const name = String(rawName || '').trim().slice(0, 24) || 'Visitante';
    socket.data.name = name;
    online.set(socket.id, { name });
    sendInit(socket);
    io.emit('presence', presenceSnapshot());
  });

  socket.on('text:join', (ch) => {
    if (!history[ch]) return;
    if (socket.data.text) socket.leave('t:' + socket.data.text);
    socket.data.text = ch;
    socket.join('t:' + ch);
    socket.emit('text:history', { ch, msgs: history[ch] });
  });

  socket.on('text:send', (rawText) => {
    const ch = socket.data.text;
    if (!ch || !history[ch] || !socket.data.name) return;
    const text = String(rawText || '').trim().slice(0, 1000);
    if (!text) return;
    const msg = { name: socket.data.name, text, ts: Date.now(), vip: false, role: 'user' };
    history[ch].push(msg);
    if (history[ch].length > 100) history[ch].shift();
    io.to('t:' + ch).emit('text:msg', { ch, msg });
  });

  socket.on('voice:join', (ch) => {
    if (!voice[ch] || !socket.data.name) return;
    leaveVoice(socket);
    const peers = [...voice[ch].entries()].map(([id, u]) => ({ id, name: u.name, vip: false, role: 'user' }));
    voice[ch].set(socket.id, { name: socket.data.name });
    socket.data.voice = ch;
    socket.join('v:' + ch);
    socket.emit('voice:joined', { ch, peers });
    socket.to('v:' + ch).emit('voice:peer-joined', { id: socket.id, name: socket.data.name, vip: false, role: 'user' });
    io.emit('voice:state', voiceSnapshot());
  });
  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('signal', ({ to, data } = {}) => {
    const ch = socket.data.voice;
    if (!ch || !voice[ch]?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });
  socket.on('screen', ({ streamId, on } = {}) => {
    const ch = socket.data.voice;
    if (!ch) return;
    socket.to('v:' + ch).emit('screen', { from: socket.id, streamId, on: !!on });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    online.delete(socket.id);
    io.emit('presence', presenceSnapshot());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor iniciado na porta ' + PORT));
