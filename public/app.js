const $ = (s) => document.querySelector(s);
const API = (window.SERVER_URL || '').replace(/\/$/, '');
const ICE = {
  iceServers: window.ICE_SERVERS || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

let token = ls.get('token');
let socket = null;
let me = null;
let myId = null;
let TEXT = [], VOICE = [];
let currentText = null;
let currentVoice = null;
let voiceState = {};
let presence = [];

let micStream = null;   // áudio (e câmera, quando ligada)
let camTrack = null;
let screenStream = null;
let deafened = false;
const screenSenders = new Map(); // peerId -> [senders]
const peers = new Map();         // id -> { pc, name, vip, ... }
const tiles = new Map();         // key -> elemento

// ---------------------------------------------------------------- Utilidades
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
function banner(msg) {
  const b = $('#banner');
  if (!msg) return b.classList.add('hidden');
  b.textContent = msg;
  b.classList.remove('hidden');
}
function nameSpan(name, vip, role) {
  const s = document.createElement('span');
  s.className = 'nm' + (role === 'admin' ? ' admin' : vip ? ' vip' : '');
  s.textContent = name;
  return s;
}
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erro (' + r.status + ')');
  return d;
}

// ---------------------------------------------------------------- Sessão automática de visitante (sem tela de login)
async function createGuestSession() {
  // Reutiliza a sessão se já existir; se não, cria uma conta temporária automaticamente.
  // Isso evita a tela de login, mas depende de o servidor permitir /api/register.
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const username = 'Visitante-' + suffix;
    const password = (globalThis.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random())) + 'Aa1!';
    try {
      const d = await api('/api/register', { method: 'POST', body: { username, password } });
      token = d.token;
      if (!token) throw new Error('O servidor não retornou um token de sessão.');
      ls.set('token', token);
      ls.set('lastUser', username);
      startSession();
      return;
    } catch (err) {
      // Uma colisão de nome pode acontecer; tenta outro nome. Erros de servidor serão exibidos abaixo.
      if (attempt === maxAttempts - 1) {
        banner('Não foi possível entrar como visitante. O servidor precisa permitir cadastro automático: ' + err.message);
      }
    }
  }
}

function logout() {
  // Sem login: limpa a sessão atual e recarrega para criar outro visitante.
  ls.del('token');
  token = null;
  try { if (currentVoice) leaveVoice(); } catch (_) {}
  if (socket) socket.disconnect();
  location.reload();
}
$('#btnLogout').onclick = logout;

// ---------------------------------------------------------------- Socket
function startSession() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); }
  socket = io(API || undefined, {
    auth: (cb) => cb({ token }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
  });

  socket.on('connect_error', (err) => {
    if (err && err.message === 'auth') {
      ls.del('token'); token = null;
      socket.disconnect();
      $('#app').classList.add('hidden');
      banner('Sessão de visitante expirada. Criando outra sessão…');
      createGuestSession();
    } else {
      banner('Sem conexão com o servidor. Tentando de novo…');
    }
  });
  socket.on('disconnect', () => banner('Conexão perdida. Reconectando…'));

  // 'init' chega em toda (re)conexão
  socket.on('init', (d) => {
    const reconnect = !!currentText;
    myId = d.id; me = d.me;
    TEXT = d.text; VOICE = d.voice;
    voiceState = d.voiceState; presence = d.presence;
    banner(null);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderMe(); renderChannels(); renderPresence();
    openText(TEXT.find((c) => c.id === currentText) ? currentText : TEXT[0].id);
    if (currentVoice && micStream) {
      // caiu e voltou: refaz as conexões com todos automaticamente
      resetPeers();
      socket.emit('voice:join', currentVoice);
      toast('Reconectado à chamada');
    } else if (reconnect) {
      toast('Reconectado');
    }
  });

  socket.on('me', (u) => { me = u; renderMe(); renderChannels(); });
  socket.on('presence', (p) => { presence = p; renderPresence(); });
  socket.on('voice:state', (s) => { voiceState = s; renderChannels(); });
  socket.on('voice:kicked', () => {
    toast('Você entrou na chamada em outro lugar.');
    leaveVoice(true);
  });

  socket.on('text:history', ({ ch, msgs }) => { if (ch === currentText) { $('#messages').innerHTML = ''; msgs.forEach(addMsg); } });
  socket.on('text:msg', ({ ch, msg }) => { if (ch === currentText) addMsg(msg); });

  socket.on('voice:joined', ({ peers: list }) => list.forEach((p) => createPeer(p.id, p.name, p.vip)));
  socket.on('voice:peer-joined', ({ id, name, vip }) => createPeer(id, name, vip));
  socket.on('voice:peer-left', ({ id }) => closePeer(id));
  socket.on('signal', onSignal);
  socket.on('screen', onScreenMsg);
}

// Volta a conectar sozinho quando a aba reabre ou a internet volta
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && socket && !socket.connected) socket.connect();
});
window.addEventListener('online', () => { if (socket && !socket.connected) socket.connect(); });
// Evita o servidor grátis dormir durante uma chamada
setInterval(() => { if (currentVoice) fetch(API + '/health', { mode: 'no-cors' }).catch(() => {}); }, 4 * 60 * 1000);

// ---------------------------------------------------------------- Sidebar
function renderMe() {
  const el = $('#meName');
  el.innerHTML = '';
  el.append('👤 ', nameSpan(me.username, me.vip, me.role));
  $('#btnAdmin').classList.toggle('hidden', me.role !== 'admin');
}
const canAccess = (c) => !c.vip || me.vip || me.role === 'admin';

function renderChannels() {
  if (!me) return;
  $('#textList').innerHTML = '';
  TEXT.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'ch' + (c.id === currentText ? ' active' : '') + (canAccess(c) ? '' : ' locked');
    el.textContent = (canAccess(c) ? '# ' : '🔒 ') + c.id + (c.vip ? ' ⭐' : '');
    el.onclick = () => (canAccess(c) ? openText(c.id) : toast('Canal exclusivo para VIPs ⭐'));
    $('#textList').appendChild(el);
  });
  $('#voiceList').innerHTML = '';
  VOICE.forEach((c) => {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'ch' + (c.id === currentVoice ? ' active' : '') + (canAccess(c) ? '' : ' locked');
    el.textContent = (canAccess(c) ? '🔊 ' : '🔒 ') + c.id + (c.vip ? ' ⭐' : '');
    el.onclick = () => (canAccess(c) ? joinVoice(c.id) : toast('Sala exclusiva para VIPs ⭐'));
    wrap.appendChild(el);
    const users = document.createElement('div');
    users.className = 'vusers';
    (voiceState[c.id] || []).forEach((u) => {
      const d = document.createElement('div');
      d.appendChild(nameSpan(u.name, u.vip, u.role));
      users.appendChild(d);
    });
    wrap.appendChild(users);
    $('#voiceList').appendChild(wrap);
  });
}
function renderPresence() {
  $('#onlineTitle').textContent = 'Online — ' + presence.length;
  const box = $('#onlineList');
  box.innerHTML = '';
  presence.forEach((u) => {
    const d = document.createElement('div');
    d.appendChild(nameSpan(u.name, u.vip, u.role));
    box.appendChild(d);
  });
}

// ---------------------------------------------------------------- Texto
function openText(id) {
  currentText = id;
  $('#chatTitle').textContent = '# ' + id;
  $('#messages').innerHTML = '';
  socket.emit('text:join', id);
  renderChannels();
}
function addMsg(m) {
  const el = document.createElement('div');
  el.className = 'msg';
  const t = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const b = document.createElement('b');
  b.appendChild(nameSpan(m.name, m.vip, m.role));
  const s = document.createElement('small'); s.textContent = t;
  const sp = document.createElement('span'); sp.textContent = m.text;
  el.append(b, s, sp);
  const box = $('#messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(el);
  if (stick) box.scrollTop = box.scrollHeight;
}
$('#msgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msgInput').value;
  if (!v.trim()) return;
  socket.emit('text:send', v);
  $('#msgInput').value = '';
});

// ---------------------------------------------------------------- Voz / vídeo
async function joinVoice(ch) {
  if (currentVoice === ch) return;
  if (currentVoice) leaveVoice();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    // sem microfone: entra só para ouvir/ver
    micStream = new MediaStream();
    toast('Sem microfone (' + err.name + '). Você vai só ouvir e ver.', 6000);
  }
  currentVoice = ch;
  $('#stage').classList.remove('hidden');
  addTile('me-cam', me.username + ' (você)', micStream, true, me.username);
  setNoVideo('me-cam', true);
  updateButtons();
  renderChannels();
  applyFocus();
  socket.emit('voice:join', ch);
}

let lastRejoin = 0;
function rejoinVoice() {
  if (!currentVoice || !socket.connected || Date.now() - lastRejoin < 15000) return;
  lastRejoin = Date.now();
  resetPeers();
  socket.emit('voice:join', currentVoice);
  toast('Reconectando a chamada…');
}

function resetPeers() {
  [...peers.keys()].forEach(closePeer);
  [...tiles.keys()].filter((k) => !k.startsWith('me-')).forEach(removeTile);
  screenSenders.clear();
}

function leaveVoice(fromServer) {
  if (!fromServer && socket) socket.emit('voice:leave');
  stopScreen(true);
  resetPeers();
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

function createPeer(id, name, vip) {
  if (peers.has(id)) return peers.get(id);
  if (!micStream) return null;
  const pc = new RTCPeerConnection(ICE);
  const peer = {
    pc, name, vip, makingOffer: false, ignoreOffer: false,
    polite: myId < id, // desempate para "perfect negotiation"
    screenIds: new Set(), camSenders: [], timer: null,
  };
  peers.set(id, peer);

  if (micStream.getAudioTracks().length === 0) pc.addTransceiver('audio', { direction: 'recvonly' });
  micStream.getTracks().forEach((t) => {
    const s = pc.addTrack(t, micStream);
    if (t.kind === 'video') peer.camSenders.push(s);
  });
  if (screenStream) {
    addScreenToPeer(id, peer);
    socket.emit('screen', { streamId: screenStream.id, on: true });
  }

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
      addTile(key, (peer.vip ? '⭐ ' : '') + peer.name + (isScreen ? ' — tela' : ''), stream, false, peer.name);
      setNoVideo(key, stream.getVideoTracks().length === 0);
    }
    if (e.track.kind === 'video') {
      setNoVideo(key, false);
      e.track.onmute = () => setNoVideo(key, true);
      e.track.onunmute = () => setNoVideo(key, false);
    }
    stream.onremovetrack = () => { if (stream.getTracks().length === 0) removeTile(key); };
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    clearTimeout(peer.timer);
    if (st === 'disconnected') {
      peer.timer = setTimeout(() => { if (pc.connectionState !== 'connected') { try { pc.restartIce(); } catch (_) {} } }, 4000);
      // se ainda assim não voltar, refaz a chamada inteira
      peer.timer2 = setTimeout(() => { if (peers.get(id) === peer && pc.connectionState !== 'connected') rejoinVoice(); }, 14000);
    } else if (st === 'failed') {
      try { pc.restartIce(); } catch (_) {}
      peer.timer = setTimeout(() => { if (peers.get(id) === peer && pc.connectionState !== 'connected') rejoinVoice(); }, 8000);
    } else if (st === 'connected') {
      clearTimeout(peer.timer2);
    }
  };
  return peer;
}

async function onSignal({ from, data }) {
  let peer = peers.get(from);
  if (!peer) {
    const known = ((voiceState[currentVoice] || []).find((u) => u.id === from)) || {};
    peer = createPeer(from, known.name || '...', known.vip);
    if (!peer) return;
  }
  const pc = peer.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
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
}

function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  clearTimeout(p.timer); clearTimeout(p.timer2);
  try { p.pc.close(); } catch (_) {}
  peers.delete(id);
  screenSenders.delete(id);
  [...tiles.keys()].filter((k) => k.startsWith(id + ':')).forEach(removeTile);
}

function onScreenMsg({ from, streamId, on }) {
  const p = peers.get(from);
  if (!p) return;
  if (on) {
    p.screenIds.add(streamId);
    relabel(from + ':' + streamId, (p.vip ? '⭐ ' : '') + p.name + ' — tela');
  } else {
    p.screenIds.delete(streamId);
    removeTile(from + ':' + streamId);
  }
}

// ---------------------------------------------------------------- Tiles
function addTile(key, label, stream, local, initial) {
  const el = document.createElement('div');
  el.className = 'tile';
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true;
  v.srcObject = stream;
  v.muted = local || deafened;
  if (!local) v.dataset.remote = '1';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = ((initial || label)[0] || '?').toUpperCase();
  const lb = document.createElement('div');
  lb.className = 'label'; lb.textContent = label;
  const fs = document.createElement('button');
  fs.className = 'fs'; fs.textContent = '⛶'; fs.title = 'Tela cheia do navegador';
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

// ---------------------------------------------------------------- Modo foco
let focusKey = null;
let chatHidden = false;
function toggleFocus(key) { focusKey = focusKey === key ? null : key; applyFocus(); }
function applyFocus() {
  $('#grid').classList.toggle('focus', !!focusKey);
  tiles.forEach((el, k) => el.classList.toggle('focused', k === focusKey));
  const hideChat = !!currentVoice && (!!focusKey || chatHidden);
  $('#chat').classList.toggle('hidden', hideChat);
  $('#stage').classList.toggle('big', hideChat);
}
$('#btnChat').onclick = () => {
  chatHidden = !chatHidden;
  $('#btnChat').classList.toggle('off', chatHidden);
  applyFocus();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#adminModal').classList.contains('hidden')) return closeAdmin();
    if (focusKey) { focusKey = null; applyFocus(); }
  }
});

// ---------------------------------------------------------------- Controles
function updateButtons() {
  const mic = micStream && micStream.getAudioTracks()[0];
  $('#btnMic').classList.toggle('off', !mic || !mic.enabled);
  $('#btnMic').textContent = !mic ? '🚫 Sem mic' : !mic.enabled ? '🔇 Mic mudo' : '🎤 Mic';
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
    peers.forEach((p) => { p.camSenders.forEach((s) => { try { p.pc.removeTrack(s); } catch (_) {} }); p.camSenders = []; });
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
    } catch (e) { toast('Não consegui abrir a câmera: ' + e.message, 5000); }
  }
  updateButtons();
};

function addScreenToPeer(id, peer) {
  screenSenders.set(id, screenStream.getTracks().map((t) => peer.pc.addTrack(t, screenStream)));
}
async function startScreen() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch (e) { return; }
  addTile('me-screen', me.username + ' — sua tela', screenStream, true, me.username);
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
  if (!silent && socket) socket.emit('screen', { streamId: sid, on: false });
  updateButtons();
}
$('#btnScreen').onclick = () => (screenStream ? stopScreen() : startScreen());
$('#btnLeave').onclick = () => leaveVoice();

// ---------------------------------------------------------------- Admin
function closeAdmin() { $('#adminModal').classList.add('hidden'); }
$('#adminClose').onclick = closeAdmin;
$('#btnAdmin').onclick = () => { $('#adminModal').classList.remove('hidden'); loadAdmin(); };

async function loadAdmin() {
  const box = $('#adminUsers');
  box.textContent = 'Carregando…';
  try {
    const { users } = await api('/api/admin/users');
    $('#adminInfo').textContent = users.length + ' conta(s). Clique em ⭐ para dar/tirar VIP.';
    box.innerHTML = '';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'urow';
      const dot = document.createElement('span');
      dot.className = 'dot' + (u.online ? ' on' : '');
      const nm = document.createElement('span');
      nm.className = 'nmWrap';
      nm.appendChild(nameSpan(u.username, u.vip, u.role));
      const vip = document.createElement('button');
      vip.className = 'small'; vip.textContent = u.vip ? '⭐ Tirar VIP' : '⭐ Dar VIP';
      vip.onclick = async () => { try { await api('/api/admin/vip', { method: 'POST', body: { username: u.username, vip: !u.vip } }); loadAdmin(); } catch (e) { toast(e.message); } };
      const adm = document.createElement('button');
      adm.className = 'small'; adm.textContent = u.role === 'admin' ? '👑 Tirar admin' : '👑 Tornar admin';
      adm.onclick = async () => { try { await api('/api/admin/role', { method: 'POST', body: { username: u.username, role: u.role === 'admin' ? 'user' : 'admin' } }); loadAdmin(); } catch (e) { toast(e.message); } };
      row.append(dot, nm, vip, adm);
      box.appendChild(row);
    });
  } catch (e) { box.textContent = e.message; }
}

$('#btnBackup').onclick = async () => {
  try {
    const r = await fetch(API + '/api/admin/backup', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Falha (' + r.status + ')');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'backup-discord-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Backup baixado ✅');
  } catch (e) { toast('Erro no backup: ' + e.message, 5000); }
};
$('#btnRestore').onclick = () => $('#restoreFile').click();
$('#restoreFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!confirm('Restaurar vai APAGAR tudo que existe agora (contas e mensagens) e colocar o conteúdo do backup. Todos serão deslogados. Continuar?')) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await api('/api/admin/restore', { method: 'POST', body: data });
    alert('Backup restaurado: ' + r.users + ' contas, ' + r.messages + ' mensagens. Entre de novo.');
    logout();
  } catch (err) { toast('Erro ao restaurar: ' + err.message, 6000); }
};

// ---------------------------------------------------------------- Início
if (token) startSession();
else createGuestSession();
