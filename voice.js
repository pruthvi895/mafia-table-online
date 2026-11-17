// Mafia Table voice/video (WebRTC, peer-to-peer). The game server only relays
// signalling between players it allows to hear each other right now (day: the
// living; night: Mafia only; removed players: their own channel). Public STUN
// only, no TURN: strict NATs can fail -> "voice unavailable on this network".
// Godot talks to this through window.mafiaVoice (see mafia_online_app.gd).
(function () {
  var ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  var V = window.mafiaVoice = { out: [], status: 'off', speaking: [], peers: {}, me: '', group: '', stream: null, video: false, muted: false, connected: [] };
  var ctx = null, meters = {}, tiles = null;

  function send(to, data) { V.out.push({ t: 'voice_signal', to: to, data: data }); }
  function supported() { return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  function tileBox() {
    if (tiles) return tiles;
    tiles = document.createElement('div');
    tiles.id = 'mafia-video';
    tiles.setAttribute('data-testid', 'mafia-video');
    // Bottom-left, clear of the top bar and the top-right corner. Not a debug overlay.
    tiles.style.cssText = 'position:fixed;left:10px;bottom:110px;top:auto;right:auto;display:flex;gap:8px;z-index:40;pointer-events:none;max-width:46vw;flex-wrap:wrap;align-items:flex-end';
    document.body.appendChild(tiles);
    return tiles;
  }

  function addTile(video, name) {
    var wrap = document.createElement('div');
    wrap.className = 'mafia-video-tile';
    wrap.style.cssText = 'position:relative;width:96px;height:72px;border:2px solid #d4ad61;border-radius:8px;overflow:hidden;background:#111;box-shadow:0 2px 8px rgba(0,0,0,0.45)';
    video.style.cssText = 'width:96px;height:72px;object-fit:cover;display:block;background:#000';
    var cap = document.createElement('div');
    cap.textContent = name || 'Player';
    cap.style.cssText = 'position:absolute;left:0;right:0;bottom:0;padding:2px 4px;font:12px/1.2 sans-serif;color:#f3ead8;background:rgba(0,0,0,0.65);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    wrap.appendChild(video);
    wrap.appendChild(cap);
    tileBox().appendChild(wrap);
    return wrap;
  }

  function dropTile(video) {
    if (!video) return;
    var w = video.parentNode;
    if (w && w !== tiles && w.className === 'mafia-video-tile') w.remove();
    else video.remove();
  }

  function meter(id, stream) {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (!stream.getAudioTracks().length) return;
      var src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
      an.fftSize = 512; src.connect(an);
      meters[id] = { an: an, buf: new Uint8Array(an.fftSize) };
    } catch (e) { }
  }

  setInterval(function () {
    var sp = [];
    for (var id in meters) {
      var m = meters[id]; m.an.getByteTimeDomainData(m.buf);
      var s = 0; for (var i = 0; i < m.buf.length; i++) { var d = (m.buf[i] - 128) / 128; s += d * d; }
      if (Math.sqrt(s / m.buf.length) > 0.04) {
        if (id === 'me') { if (!V.muted && V.group) sp.push(V.myName || 'You'); }
        else if (V.peers[id]) sp.push(V.peers[id].name);
      }
    }
    V.speaking = sp;
    var c = [];
    for (var pid in V.peers) { var st = V.peers[pid].pc.connectionState; if (st === 'connected') c.push(V.peers[pid].name); }
    V.connected = c;
    var dock = window.__mafiaVideoDock;
    if (tiles && dock) {
      if (dock.hide) {
        tiles.style.display = 'none';
      } else if (dock.w) {
        tiles.style.display = 'flex';
        tiles.style.left = Math.round(dock.x) + 'px';
        tiles.style.top = Math.round(dock.y) + 'px';
        tiles.style.bottom = 'auto';
        tiles.style.right = 'auto';
      }
    }
  }, 250);

  function closePeer(id) {
    var p = V.peers[id]; if (!p) return;
    try { p.pc.close(); } catch (e) { }
    if (p.audio) p.audio.remove();
    if (p.video) dropTile(p.video);
    delete meters[id]; delete V.peers[id];
  }

  function makePeer(id, name) {
    if (V.peers[id]) return V.peers[id];
    var pc = new RTCPeerConnection({ iceServers: ICE });
    var p = V.peers[id] = { pc: pc, name: name || id, audio: null, video: null };
    if (V.stream) V.stream.getTracks().forEach(function (t) { pc.addTrack(t, V.stream); });
    pc.onicecandidate = function (e) { if (e.candidate) send(id, { cand: e.candidate.toJSON() }); };
    pc.ontrack = function (e) {
      var s = e.streams[0];
      if (e.track.kind === 'audio' && !p.audio) {
        p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.srcObject = s;
        document.body.appendChild(p.audio); meter(id, s);
      }
      if (e.track.kind === 'video' && !p.video) {
        p.video = document.createElement('video'); p.video.autoplay = true; p.video.muted = true; p.video.playsInline = true;
        p.video.srcObject = s;
        addTile(p.video, p.name || 'Player');
      }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') V.status = 'voice unavailable on this network';
    };
    return p;
  }

  async function offer(id) {
    var pc = V.peers[id].pc;
    var o = await pc.createOffer(); await pc.setLocalDescription(o);
    send(id, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  }

  V.join = async function (video, myName) {
    V.myName = myName || 'You';
    if (!supported()) { V.status = 'voice unavailable on this network'; return; }
    if (!window.isSecureContext) { V.status = 'voice needs https'; return; }
    try {
      V.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 160, height: 120 } : false });
      V.video = !!video; V.status = 'on'; V.muted = false;
      meter('me', V.stream);
      if (video && !V.localVideo) {
        V.localVideo = document.createElement('video');
        V.localVideo.autoplay = true; V.localVideo.muted = true; V.localVideo.playsInline = true;
        V.localVideo.srcObject = V.stream;
        addTile(V.localVideo, 'You');
      }
      V.out.push({ t: 'voice_join', video: !!video });
    } catch (e) { V.status = 'mic blocked (' + e.name + ')'; }
  };

  V.leave = function () {
    for (var id in V.peers) closePeer(id);
    if (V.stream) V.stream.getTracks().forEach(function (t) { t.stop(); });
    if (V.localVideo) { dropTile(V.localVideo); V.localVideo = null; }
    if (tiles && !tiles.childElementCount) { tiles.remove(); tiles = null; }
    V.stream = null; delete meters.me; V.status = 'off'; V.group = '';
    V.out.push({ t: 'voice_leave' });
  };

  V.mute = function (m) {
    V.muted = !!m;
    if (V.stream) V.stream.getAudioTracks().forEach(function (t) { t.enabled = !V.muted && !!V.group; });
  };

  // Server decides who we may talk to; anything not listed is closed at once.
  V.setPeers = function (msg) {
    V.me = msg.me || ''; V.group = msg.group || '';
    var want = {};
    (msg.peers || []).forEach(function (p) { want[p.id] = p; });
    for (var id in V.peers) if (!want[id]) closePeer(id);
    if (V.stream) V.stream.getAudioTracks().forEach(function (t) { t.enabled = !V.muted && !!V.group; });
    if (!V.stream) return;
    for (var pid in want) {
      if (!V.peers[pid]) {
        makePeer(pid, want[pid].name);
        if (V.me < pid) offer(pid);
      } else V.peers[pid].name = want[pid].name;
    }
  };

  V.onSignal = async function (from, data) {
    if (!V.stream || !data) return;
    var p = V.peers[from] || makePeer(from, from);
    try {
      if (data.sdp) {
        await p.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          var a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a);
          send(from, { sdp: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } });
        }
      } else if (data.cand) await p.pc.addIceCandidate(data.cand);
    } catch (e) { }
  };

  V.state = function () {
    var box = tiles && tiles.isConnected ? tiles.getBoundingClientRect() : null;
    return JSON.stringify({
      status: V.status, speaking: V.speaking, connected: V.connected, group: V.group, muted: V.muted, video: V.video,
      tile: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
      out: V.out.splice(0)
    });
  };
})();
