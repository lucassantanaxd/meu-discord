// SERVER_URL vem de config.js (vazio = mesmo domínio; no Vercel aponta para o servidor no Render)
const socket = window.SERVER_URL ? io(window.SERVER_URL, { transports: ['websocket', 'polling'] }) : io();
const $ = (s) => document.querySelector(s);

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Para redes difíceis (4G/CGNAT), adicione um servidor TURN aqui:
    // { urls: 'turn:SEU_TURN:3478', username: 'user', credential: 'senha' },
  ],
};

let myId = null;
let myName = '';
let currentText = null;
let currentVoice = null;
let voiceState = {};

let micStream = null;   // áudio (e câmera, quando ligada)
let camTrack = null;
let screenStream = null;
let screenSenders = new Map(); // peerId -> [senders]
let deafened = false;

const peers = new Map(); // id -> { pc, name, makingOffer, ignoreOffer, polite, screenIds:Set, camSenders:[] }
const tiles = new Map(); // key -> element

// ---------- Login ----------
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = $('#nameInput').value.trim();
  if (!myName) return;
  localStorage.setItem('nome', myName);
  socket.emit('join', myName);
});
$('#nameInput').value = localStorage.getItem('nome') || '';

socket.on('init', (d) => {
  myId = d.id;
  voiceState = d.voiceState;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me').textContent = '👤 ' + myName;
  renderChannels(d.text, d.voice);
  openText(d.text[0]);
});

// ---------- Canais ----------
let TEXT = [], VOICE = [];
function renderChannels(text, voice) {
  if (text) TEXT = text;
  if (voice) VOICE = voice;
  $('#textList').innerHTML = '';
  TEXT.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'ch' + (c === currentText ? ' active' : '');
    el.textContent = '# ' + c;
    el.onclick = () => openText(c);
    $('#textList').appendChild(el);
  });
  $('#voiceList').innerHTML = '';
  VOICE.forEach((c) => {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'ch' + (c === currentVoice ? ' active' : '');
    el.textContent = '🔊 ' + c;
    el.onclick = () => joinVoice(c);
    wrap.appendChild(el);
    const users = document.createElement('div');
    users.className = 'vusers';
    (voiceState[c] || []).forEach((u) => {
      const d = document.createElement('div');
      d.textContent = u.name;
      users.appendChild(d);
    });
    wrap.appendChild(users);
    $('#voiceList').appendChild(wrap);
  });
}
socket.on('voice:state', (s) => { voiceState = s; renderChannels(); });

// ---------- Texto ----------
function openText(ch) {
  currentText = ch;
  $('#chatTitle').textContent = '# ' + ch;
  $('#messages').innerHTML = '';
  socket.emit('text:join', ch);
  renderChannels();
}
function addMsg(m) {
  const el = document.createElement('div');
  el.className = 'msg';
  const t = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const b = document.createElement('b'); b.textContent = m.name;
  const s = document.createElement('small'); s.textContent = t;
  const sp = document.createElement('span'); sp.textContent = m.text;
  el.append(b, s, sp);
  const box = $('#messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
socket.on('text:history', ({ ch, msgs }) => { if (ch === currentText) msgs.forEach(addMsg); });
socket.on('text:msg', ({ ch, msg }) => { if (ch === currentText) addMsg(msg); });
$('#msgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msgInput').value;
  if (!v.trim()) return;
  socket.emit('text:send', v);
  $('#msgInput').value = '';
});

// ---------- Voz / vídeo ----------
async function joinVoice(ch) {
  if (currentVoice === ch) return;
  if (currentVoice) leaveVoice();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    alert('Não consegui acessar o microfone: ' + err.message + '\n(Use HTTPS ou localhost e permita o acesso.)');
    return;
  }
  currentVoice = ch;
  $('#stage').classList.remove('hidden');
  addTile('me-cam', myName + ' (você)', micStream, true);
  setNoVideo('me-cam', true);
  updateButtons();
  renderChannels();
  socket.emit('voice:join', ch);
}

function leaveVoice() {
  socket.emit('voice:leave');
  stopScreen(true);
  peers.forEach((_, id) => closePeer(id));
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null; camTrack = null;
  tiles.forEach((el) => el.remove());
  tiles.clear();
  focusKey = null; chatHidden = false;
  $('#btnChat').classList.remove('off');
  currentVoice = null;
  $('#stage').classList.add('hidden');
  applyFocus();
  renderChannels();
}

socket.on('voice:joined', ({ peers: list }) => {
  // Quem entra cria a conexão com todos que já estavam na sala
  list.forEach((p) => createPeer(p.id, p.name, true));
});
socket.on('voice:peer-joined', ({ id, name }) => createPeer(id, name, false));
socket.on('voice:peer-left', ({ id }) => closePeer(id));

function createPeer(id, name, initiator) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection(ICE);
  const peer = {
    pc, name, makingOffer: false, ignoreOffer: false,
    polite: myId < id, // desempate para "perfect negotiation"
    screenIds: new Set(), camSenders: [],
  };
  peers.set(id, peer);

  // Envia mic (+ câmera, se ligada) e tela, se já estiver compartilhando
  micStream.getTracks().forEach((t) => {
    const s = pc.addTrack(t, micStream);
    if (t.kind === 'video') peer.camSenders.push(s);
  });
  if (screenStream) addScreenToPeer(id, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    } catch (e) { console.error(e); } finally { peer.makingOffer = false; }
  };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    const key = id + ':' + stream.id;
    if (!tiles.has(key)) {
      const isScreen = peer.screenIds.has(stream.id);
      addTile(key, name + (isScreen ? ' — tela' : ''), stream, false);
      setNoVideo(key, stream.getVideoTracks().length === 0);
    }
    const track = e.track;
    if (track.kind === 'video') {
      setNoVideo(key, false);
      track.onmute = () => setNoVideo(key, true);
      track.onunmute = () => setNoVideo(key, false);
    }
    stream.onremovetrack = () => { if (stream.getTracks().length === 0 && key.includes(':')) removeTile(key); };
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };
  return peer;
}

socket.on('signal', async ({ from, data }) => {
  let peer = peers.get(from);
  if (!peer) peer = createPeer(from, '...', false);
  const pc = peer.pc;
  try {
    if (data.description) {
      const offerCollision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
    }
  } catch (e) { console.error(e); }
});

function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  peers.delete(id);
  [...tiles.keys()].filter((k) => k.startsWith(id + ':')).forEach(removeTile);
}

// ---------- Tiles ----------
function addTile(key, label, stream, local) {
  const el = document.createElement('div');
  el.className = 'tile';
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true;
  v.srcObject = stream;
  v.muted = local || deafened;
  if (!local) v.dataset.remote = '1';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = (label[0] || '?').toUpperCase();
  const lb = document.createElement('div');
  lb.className = 'label'; lb.textContent = label;
  const fs = document.createElement('button');
  fs.className = 'fs'; fs.textContent = '⛶';
  fs.title = 'Tela cheia do navegador';
  fs.onclick = (e) => { e.stopPropagation(); v.requestFullscreen && v.requestFullscreen(); };
  el.title = 'Clique para ampliar';
  el.onclick = () => toggleFocus(key);
  el.append(v, av, lb, fs);
  $('#grid').appendChild(el);
  tiles.set(key, el);
  v.play().catch(() => {});
}
function removeTile(key) {
  const el = tiles.get(key);
  if (el) { el.remove(); tiles.delete(key); }
  if (focusKey === key) { focusKey = null; applyFocus(); }
}
function setNoVideo(key, on) { const el = tiles.get(key); if (el) el.classList.toggle('noVideo', on); }
function relabel(key, text) { const el = tiles.get(key); if (el) el.querySelector('.label').textContent = text; }

// ---------- Modo foco (ampliar um vídeo sem tela cheia) ----------
let focusKey = null;
function toggleFocus(key) {
  focusKey = focusKey === key ? null : key;
  applyFocus();
}
function applyFocus() {
  const grid = $('#grid');
  grid.classList.toggle('focus', !!focusKey);
  tiles.forEach((el, k) => el.classList.toggle('focused', k === focusKey));
  // Ao ampliar, esconde o chat para dar mais espaço; ao sair, mostra de novo
  const hideChat = !!currentVoice && (!!focusKey || chatHidden);
  $('#chat').classList.toggle('hidden', hideChat);
  $('#stage').classList.toggle('big', hideChat);
}
let chatHidden = false;
$('#btnChat').onclick = () => {
  chatHidden = !chatHidden;
  $('#btnChat').classList.toggle('off', chatHidden);
  applyFocus();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focusKey) { focusKey = null; applyFocus(); }
});

// ---------- Controles ----------
function updateButtons() {
  const mic = micStream && micStream.getAudioTracks()[0];
  $('#btnMic').classList.toggle('off', !!mic && !mic.enabled);
  $('#btnMic').textContent = mic && !mic.enabled ? '🔇 Mic mudo' : '🎤 Mic';
  $('#btnDeaf').classList.toggle('off', deafened);
  $('#btnCam').classList.toggle('on', !!camTrack);
  $('#btnScreen').classList.toggle('on', !!screenStream);
}

$('#btnMic').onclick = () => {
  const t = micStream && micStream.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  updateButtons();
};
$('#btnDeaf').onclick = () => {
  deafened = !deafened;
  document.querySelectorAll('video[data-remote]').forEach((v) => (v.muted = deafened));
  updateButtons();
};
$('#btnCam').onclick = async () => {
  if (camTrack) {
    peers.forEach((p) => { p.camSenders.forEach((s) => p.pc.removeTrack(s)); p.camSenders = []; });
    micStream.removeTrack(camTrack);
    camTrack.stop(); camTrack = null;
    setNoVideo('me-cam', true);
  } else {
    try {
      const cs = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      camTrack = cs.getVideoTracks()[0];
      micStream.addTrack(camTrack);
      peers.forEach((p) => p.camSenders.push(p.pc.addTrack(camTrack, micStream)));
      setNoVideo('me-cam', false);
      camTrack.onended = () => { if (camTrack) $('#btnCam').click(); };
    } catch (e) { alert('Não consegui abrir a câmera: ' + e.message); }
  }
  updateButtons();
};

function addScreenToPeer(id, peer) {
  const senders = screenStream.getTracks().map((t) => peer.pc.addTrack(t, screenStream));
  screenSenders.set(id, senders);
}
async function startScreen() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch (e) { return; }
  addTile('me-screen', myName + ' — sua tela', screenStream, true);
  socket.emit('screen', { streamId: screenStream.id, on: true });
  peers.forEach((p, id) => addScreenToPeer(id, p));
  screenStream.getVideoTracks()[0].onended = () => stopScreen();
  updateButtons();
}
function stopScreen(silent) {
  if (!screenStream) return;
  const sid = screenStream.id;
  peers.forEach((p, id) => (screenSenders.get(id) || []).forEach((s) => { try { p.pc.removeTrack(s); } catch (_) {} }));
  screenSenders.clear();
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  removeTile('me-screen');
  if (!silent) socket.emit('screen', { streamId: sid, on: false });
  updateButtons();
}
$('#btnScreen').onclick = () => (screenStream ? stopScreen() : startScreen());
$('#btnLeave').onclick = leaveVoice;

socket.on('screen', ({ from, streamId, on }) => {
  const p = peers.get(from);
  if (!p) return;
  if (on) {
    p.screenIds.add(streamId);
    relabel(from + ':' + streamId, p.name + ' — tela');
  } else {
    p.screenIds.delete(streamId);
    removeTile(from + ':' + streamId);
  }
});

// Atualiza os nomes dos peers (o servidor manda o nome em peer-joined / voice:joined)
socket.on('voice:joined', ({ peers: list }) => list.forEach((p) => { const x = peers.get(p.id); if (x) x.name = p.name; }));
