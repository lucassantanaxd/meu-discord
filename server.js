const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// ALLOWED_ORIGIN: URL do site no Vercel (ex.: https://meu-discord.vercel.app). Vários: separe por vírgula.
const origins = process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()) : '*';
const io = new Server(server, { maxHttpBufferSize: 1e6, cors: { origin: origins } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/health', (_req, res) => res.send('ok'));

const TEXT_CHANNELS = ['geral', 'jogos', 'memes'];
const VOICE_CHANNELS = ['Sala 1', 'Sala 2', 'Sala 3'];

const history = Object.fromEntries(TEXT_CHANNELS.map((c) => [c, []]));
const voice = Object.fromEntries(VOICE_CHANNELS.map((c) => [c, new Map()]));

function voiceSnapshot() {
  const out = {};
  for (const ch of VOICE_CHANNELS) {
    out[ch] = [...voice[ch].entries()].map(([id, u]) => ({ id, name: u.name }));
  }
  return out;
}

function leaveVoice(socket) {
  const ch = socket.data.voice;
  if (!ch) return;
  voice[ch].delete(socket.id);
  socket.leave('v:' + ch);
  socket.to('v:' + ch).emit('voice:peer-left', { id: socket.id });
  socket.data.voice = null;
  io.emit('voice:state', voiceSnapshot());
}

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    socket.data.name = String(name || '').trim().slice(0, 24) || 'Anônimo';
    socket.emit('init', {
      id: socket.id,
      text: TEXT_CHANNELS,
      voice: VOICE_CHANNELS,
      voiceState: voiceSnapshot(),
    });
  });

  socket.on('text:join', (ch) => {
    if (!TEXT_CHANNELS.includes(ch)) return;
    if (socket.data.text) socket.leave('t:' + socket.data.text);
    socket.data.text = ch;
    socket.join('t:' + ch);
    socket.emit('text:history', { ch, msgs: history[ch] });
  });

  socket.on('text:send', (text) => {
    const ch = socket.data.text;
    if (!ch || !socket.data.name) return;
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;
    const msg = { name: socket.data.name, text, ts: Date.now() };
    history[ch].push(msg);
    if (history[ch].length > 100) history[ch].shift();
    io.to('t:' + ch).emit('text:msg', { ch, msg });
  });

  socket.on('voice:join', (ch) => {
    if (!VOICE_CHANNELS.includes(ch) || !socket.data.name) return;
    leaveVoice(socket);
    const peers = [...voice[ch].entries()].map(([id, u]) => ({ id, name: u.name }));
    voice[ch].set(socket.id, { name: socket.data.name });
    socket.data.voice = ch;
    socket.join('v:' + ch);
    socket.emit('voice:joined', { ch, peers });
    socket.to('v:' + ch).emit('voice:peer-joined', { id: socket.id, name: socket.data.name });
    io.emit('voice:state', voiceSnapshot());
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  // Sinalização WebRTC (offer/answer/ice) entre dois participantes da mesma sala
  socket.on('signal', ({ to, data }) => {
    const ch = socket.data.voice;
    if (!ch || !voice[ch].has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Avisos de tela compartilhada (para rotular o vídeo)
  socket.on('screen', ({ streamId, on }) => {
    const ch = socket.data.voice;
    if (!ch) return;
    socket.to('v:' + ch).emit('screen', { from: socket.id, streamId, on: !!on });
  });

  socket.on('disconnect', () => leaveVoice(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Rodando em http://localhost:' + PORT));
