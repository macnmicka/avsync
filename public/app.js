/* app.js — avsync 前端：央视频画面 + B站声音，延迟可调 */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  video: $('videoEl'), audio: $('audioEl'),
  videoOverlay: $('videoOverlay'), audioOverlay: $('audioOverlay'),
  videoDot: $('videoDot'), audioDot: $('audioDot'),
  videoState: $('videoState'), audioState: $('audioState'),
  videoLat: $('videoLat'), audioLat: $('audioLat'), videoRes: $('videoRes'),
  channelSelect: $('channelSelect'), channelFilter: $('channelFilter'),
  sourceInput: $('sourceInput'),
  btnLoadVideo: $('btnLoadVideo'),
  roomInput: $('roomInput'), btnLoadAudio: $('btnLoadAudio'),
  searchInput: $('searchInput'), btnSearch: $('btnSearch'), searchResults: $('searchResults'),
  offset: $('offset'), offsetNum: $('offsetNum'), offsetHint: $('offsetHint'),
  audioDelay: $('audioDelay'), audioDelayNum: $('audioDelayNum'),
  videoCap: $('videoCap'), audioCap: $('audioCap'),
  btnAlign: $('btnAlign'), btnPlay: $('btnPlay'),
  btnMute: $('btnMute'), btnZero: $('btnZero'),
  autoInfo: $('autoInfo'),
  autoVideoDelay: $('autoVideoDelay'), autoVideoDelayNum: $('autoVideoDelayNum'),
  autoAudioDelay: $('autoAudioDelay'), autoAudioDelayNum: $('autoAudioDelayNum'),
  mVideo: $('mVideo'), mAudio: $('mAudio'), mDiff: $('mDiff'),
  clock: $('clock'), cfgInfo: $('cfgInfo'),
  volume: $('volume'), btnBiliShow: $('btnBiliShow'), btnOpenPP: $('btnOpenPP'),
  vu: $('vu'),
  videoStage: $('videoStage'), btnFull: $('btnFull'), btnAuto: $('btnAuto'),
};

const state = {
  videoDelay: 0,          // 画面相对“最新直播”额外延后多少秒（服务端实现）
  audioDelay: 0,          // 声音额外延后多少秒（服务端实现）
  videoLag: NaN,          // 画面滞后（相对该流实时边缘）
  audioLag: NaN,          // 声音滞后
  videoHls: null, audioHls: null,
  channels: [], lastBili: null, room: '',
  serverSkew: 0,
  videoMaxDelay: 0, audioMaxDelay: 0, audioHardMax: 15,
  diffSamples: [],
  autoAlign: false,        // 自动实时对齐
  autoTimer: 0,
  driftSamples: [],        // 自动对齐用的平滑窗口
  lastCoarseAt: 0,         // 上次"重载式"粗调的时间，避免频繁重载
  lastAutoActionAt: 0,
  biliStatus: null,
  stableSince: 0,
  autoVideoDelay: 0,
  autoAudioDelay: 0,
  autoReadoutRaf: 0,
};

// ------------------------------------------------------------------ 工具

const fmt = (s, d = 1) => (Number.isFinite(s) ? s.toFixed(d) : '—');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setDot(dot, cls, text) {
  dot.className = 'dot' + (cls ? ' ' + cls : '');
  dot.title = text || '';
}

function stateLabel(prefix, cls, text) {
  const node = prefix === 'v' ? el.videoState : el.audioState;
  node.textContent = text;
  node.style.color = cls === 'live' ? 'var(--ok)' : cls === 'err' ? 'var(--acc2)' : '';
}

async function api(path) {
  const r = await fetch(path, { cache: 'no-store' });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error((j && j.error) || t.slice(0, 160) || ('HTTP ' + r.status));
  return j !== null ? j : t;
}

// ------------------------------------------------------------------ 频道

async function loadChannels() {
  const { channels } = await api('/api/channels');
  state.channels = channels;
  renderChannels('');
  const saved = localStorage.getItem('avsync.channel');
  if (saved && channels.some((c) => c.slug === saved)) el.channelSelect.value = saved;
}

function renderChannels(filter) {
  const f = filter.trim().toLowerCase();
  const cur = el.channelSelect.value;
  const list = state.channels.filter((c) =>
    !f || c.name.toLowerCase().includes(f) || c.slug.includes(f));
  el.channelSelect.innerHTML = list.length
    ? list.map((c) => `<option value="${c.slug}">${c.name}</option>`).join('')
    : '<option value="">（无匹配）</option>';
  if (list.some((c) => c.slug === cur)) el.channelSelect.value = cur;
}

// ------------------------------------------------------------------ 画面（央视频）
function attachHls(hls, onFatal) {
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // 分片地址过期/取不到时，重试比直接放弃好
      setTimeout(() => { try { hls.startLoad(); } catch { /* ignore */ } }, 800);
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try { hls.recoverMediaError(); } catch { /* ignore */ }
    } else if (onFatal) onFatal(data);
  });
}

/** 把一个 hls 实例接到媒体元素上（重连也走这里） */
function wireHls(hls, video, url, onReady, onFatal) {
  attachHls(hls, onFatal);
  hls.on(Hls.Events.MANIFEST_PARSED, () => { if (onReady) onReady(); });
  hls.attachMedia(video);
  hls.loadSource(url);
}

function loadVideo(slug) {
  if (!slug) return;
  localStorage.setItem('avsync.channel', slug);
  if (state.videoHls) { state.videoHls.destroy(); state.videoHls = null; }
  el.video.removeAttribute('src'); el.video.load();
  state.videoLag = NaN;
  state.stableSince = 0;
  state.driftSamples.length = 0;
  setDot(el.videoDot, 'load', '连接中');
  stateLabel('v', '', '连接中…');
  el.videoRes.textContent = '';
  el.videoOverlay.style.display = 'none';
  el.videoOverlay.textContent = '';

  const url = '/ysp/' + slug + '.m3u8?delay=' + Math.round(state.videoDelay);
  const ch = state.channels.find((c) => c.slug === slug);
  const name = ch ? ch.name : slug;
  state.slug = slug;

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12,
      maxBufferLength: 30,
      backBufferLength: 10,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });
    state.videoHls = hls;
    wireHls(hls, el.video, url, updateRes, () => {
      setDot(el.videoDot, 'err', '播放出错');
      stateLabel('v', 'err', '出错');
    });
  } else {
    el.video.src = url;
  }

  if (!state._videoListenersBound) {
    state._videoListenersBound = true;
    el.video.addEventListener('loadedmetadata', updateRes);
    el.video.addEventListener('resize', updateRes);
  }

  el.video.play().then(() => {
    setDot(el.videoDot, 'live', name + (state.videoDelay ? ' +' + state.videoDelay + 's' : ''));
    stateLabel('v', 'live', name);
  }).catch(() => {
    setDot(el.videoDot, 'load', '已就绪（待播放）');
    stateLabel('v', '', '已就绪');
  });
}

// 延迟改变后重新加载播放器（服务端窗口会整体平移，重载最干净）
let videoReloadTimer = 0, audioReloadTimer = 0;
function applyVideoDelay() {
  if (!state.slug) return;
  // 手动改值或自动粗调后，旧的差值样本已经失效；重载完成前暂停自动决策。
  state.stableSince = 0;
  state.driftSamples.length = 0;
  clearTimeout(videoReloadTimer);
  videoReloadTimer = setTimeout(() => loadVideo(state.slug), 350);
}
function applyAudioDelay() {
  if (!state.room) return;
  state.stableSince = 0;
  state.driftSamples.length = 0;
  clearTimeout(audioReloadTimer);
  audioReloadTimer = setTimeout(() => loadBili(state.room), 350);
}

// ------------------------------------------------------------------ 声音（B站）

// 从 B站链接里取房间号：live.bilibili.com/1882761732?xxx -> 1882761732
function extractRoom(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/i)
        || s.match(/(?:roomid|room_id)=(\d+)/i)
        || s.match(/(\d{3,})/);
  return m ? m[1] : '';
}

// 把“央视链接 / 频道名 / 简称”交给服务端解析成频道 slug
async function loadVideoFromInput() {
  const q = el.sourceInput.value.trim();
  if (!q) { loadVideo(el.channelSelect.value); return; }
  try {
    const r = await api('/api/resolve-channel?q=' + encodeURIComponent(q));
    el.channelSelect.value = r.slug;
    renderChannels(el.channelFilter.value);
    el.channelSelect.value = r.slug;
    loadVideo(r.slug);
  } catch (e) {
    alert('认不出这个视频源：' + e.message);
  }
}

function loadBili(room) {
  const rid = extractRoom(room);
  if (!rid) { alert('认不出 B站房间号，直接粘贴直播间链接或输入数字房间号即可'); return; }
  if (state.audioHls) { state.audioHls.destroy(); state.audioHls = null; }
  el.audio.removeAttribute('src'); el.audio.load();
  state.audioLag = NaN;
  state.biliStatus = null;
  state.stableSince = 0;
  state.driftSamples.length = 0;
  setDot(el.audioDot, 'load', '连接中');
  stateLabel('a', '', '连接中…');
  el.audioOverlay.style.display = 'none';
  state.room = rid;

  const url = '/bili/' + rid + '.m3u8?delay=' + Math.round(state.audioDelay);
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12,
      maxBufferLength: 30,
      backBufferLength: 10,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });
    state.audioHls = hls;
    wireHls(hls, el.audio, url, null, () => {
      setDot(el.audioDot, 'err', '播放出错');
      stateLabel('a', 'err', '出错');
    });
  } else {
    el.audio.src = url;
  }

  api('/api/bili/info?room=' + rid).then((info) => {
    const label = (info.uname ? info.uname + ' ' : '') + (info.title ? '· ' + info.title : '');
    stateLabel('a', '', label.trim() || ('房间 ' + info.roomId));
  }).catch(() => {});

  el.audio.muted = false;
  el.audio.play().then(() => {
    setDot(el.audioDot, 'live', 'B站 ' + rid + (state.audioDelay ? ' +' + state.audioDelay + 's' : ''));
    startVU();
  }).catch(() => {
    setDot(el.audioDot, 'load', '已就绪（待播放）');
    stateLabel('a', '', '已就绪（点播放）');
  });
}

function updateRes() {
  const hls = state.videoHls;
  let w = 0, h = 0;
  if (hls && hls.levels && hls.levels.length) {
    const lv = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0] || hls.levels[0];
    if (lv) { w = lv.width || 0; h = lv.height || 0; }
  }
  if ((!w || !h) && el.video.videoWidth) { w = el.video.videoWidth; h = el.video.videoHeight; }
  el.videoRes.textContent = w && h ? w + '×' + h : '';
}

// ------------------------------------------------------------------ VU 表
// 注意: 同一个 media 元素只能创建一次 MediaElementSource，重复创建会抛
// InvalidStateError 并使音频失效——所以这里只建一次并复用。
let audioCtx = null, analyser = null, vuRaf = 0, vuWired = false, vuBuf = null;
function startVU() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(audioCtx.destination);
    }
    if (!vuWired) {
      const src = audioCtx.createMediaElementSource(el.audio);
      src.connect(analyser);
      vuWired = true;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!vuRaf) vuRaf = requestAnimationFrame(drawVU);
    // 停止播放时把帧循环也停下，别空转
    el.audio.addEventListener('pause', stopVU, { once: true });
    el.audio.addEventListener('ended', stopVU, { once: true });
    el.audio.addEventListener('playing', () => { if (!vuRaf) vuRaf = requestAnimationFrame(drawVU); });
  } catch (e) { /* 某些情况下不可用，忽略 */ }
}

function stopVU() {
  if (vuRaf) { cancelAnimationFrame(vuRaf); vuRaf = 0; }
  clearVU();
}

function drawVU() {
  if (!analyser || el.audio.paused || el.audio.ended) { vuRaf = 0; return; }
  vuRaf = requestAnimationFrame(drawVU);
  if (!vuBuf || vuBuf.length !== analyser.frequencyBinCount) {
    vuBuf = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteTimeDomainData(vuBuf);
  let peak = 0;
  for (let i = 0; i < vuBuf.length; i++) peak = Math.max(peak, Math.abs(vuBuf[i] - 128) / 128);
  const c = el.vu, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  for (let i = 0; i < 24; i++) {
    const on = peak * 24 > i;
    g.fillStyle = i > 20 ? '#ff6b6b' : i > 15 ? '#ffb020' : '#33d17a';
    g.globalAlpha = on ? 1 : 0.13;
    g.fillRect(i * 10 + 2, 6, 7, 36);
  }
  g.globalAlpha = 1;
}

function clearVU() {
  try {
    const c = el.vu;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ 滞后测量

function hlsLatency(hls, hint) {
  // hint: 'pdt' 表示这条流有真实墙钟(PROGRAM-DATE-TIME)，可以用 playingDate 算滞后
  try {
    const d = hls.media;
    if (!d) return null;
    if (hint !== 'pdt') return null;        // 没有真实墙钟就不要用 playingDate
    if (!hls.playingDate || !Number.isFinite(hls.playingDate.getTime())) return null;
    const latency = (Date.now() - hls.playingDate.getTime()) / 1000;
    if (!Number.isFinite(latency) || latency < -5 || latency > 1800) return null;
    return { pos: d.currentTime, lag: latency };
  } catch { return null; }
}

function naLatency(d) {
  // 用 seekable 末端估算“离该流最前沿多远”（B站走这条路）
  try {
    if (!d.seekable || d.seekable.length === 0) return null;
    const end = d.seekable.end(d.seekable.length - 1);
    const start = d.seekable.start(0);
    if (end - start > 900) return null;   // 明显不是直播窗口，别用
    if (!Number.isFinite(end) || end <= 0) return null;
    return { pos: d.currentTime, edge: end, lag: end - d.currentTime };
  } catch { return null; }
}

function readLatencies() {
  let v = state.videoHls ? hlsLatency(state.videoHls, 'pdt') : null;   // 央视频有真实墙钟
  let a = state.audioHls ? hlsLatency(state.audioHls, 'none') : null;  // B站没有
  if (!v) v = naLatency(el.video);
  if (!a) a = naLatency(el.audio);
  state.videoLag = v ? v.lag : NaN;
  state.audioLag = a ? a.lag : NaN;
  const ready = !el.video.paused && !el.audio.paused &&
    el.video.readyState >= 2 && el.audio.readyState >= 2 &&
    Number.isFinite(state.videoLag) && Number.isFinite(state.audioLag);
  if (ready) {
    if (!state.stableSince) state.stableSince = Date.now();
  } else {
    state.stableSince = 0;
  }
}

// ------------------------------------------------------------------ 同步
//
// 两个源各自有自己的延迟，我们要的是“差值 = 0”：你听到的声音和看到的画面对得上。
// 差值 = 画面滞后 − 声音滞后。差值为正说明画面更慢，需要把画面延迟调小；
// 为负说明画面更快，需要把画面延迟调大。延迟都在服务端做，所以调完就稳定。
function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function currentDiff() {
  return median(state.diffSamples);
}

function pushDiff() {
  const v = state.videoLag, a = state.audioLag;
  if (!Number.isFinite(v) || !Number.isFinite(a)) return;
  state.diffSamples.push(v - a);
  while (state.diffSamples.length > 9) state.diffSamples.shift();   // 约 2.2 秒窗口
}

/**
 * 自动实时对齐。
 *
 * 分两级，避免"每次都重载播放器"：
 *  1) 细纠偏（|差值| <= 6 秒）：只改画面的 playbackRate，±0.4%~±5%。
 *     速率差 1% 时每秒挪 0.01 秒，所以 2 秒的偏差大约要 200 秒补完——
 *     慢但完全不打断播放，而且 1% 的音调变化基本听不出来（画面本来就静音）。
 *  2) 粗调（差得多 / 细纠偏追不上）：重算服务端"画面延迟"并重载一次。
 *     重载只在这两种情况下发生，且间隔至少 20 秒。
 */
function autoTick() {
  if (!state.autoAlign) return;
  if (!state.room || !state.slug || !state.stableSince || Date.now() - state.stableSince < 12000) return;
  if (el.video.paused || el.audio.paused || el.video.seeking || el.audio.seeking ||
      el.video.readyState < 2 || el.audio.readyState < 2) {
    state.driftSamples.length = 0;
    return;
  }
  const raw = state.videoLag - state.audioLag;
  if (!Number.isFinite(raw) || Math.abs(raw) > 900) return;
  const prev = median(state.driftSamples);
  if (Number.isFinite(prev) && Math.abs(raw - prev) > 3) return;
  state.driftSamples.push(raw);
  while (state.driftSamples.length > 15) state.driftSamples.shift();
  if (state.driftSamples.length < 7) return;
  const diff = median(state.driftSamples);
  if (!Number.isFinite(diff)) return;

  const err = diff;                       // >0: 画面更慢 -> 画面要加速
  const abs = Math.abs(err);

  // 已经足够准了：恢复正常速率
  if (abs < 0.7) {
    if (el.video.playbackRate !== 1 && !state.syncing) el.video.playbackRate = 1;
    animateAutoReadoutTo(state.videoDelay, state.audioDelay, 650);
    setAutoLabel('已对齐');
    return;
  }

  if (abs <= 3.5) {
    // 用小幅比例纠偏，避免短暂 seekable 抖动造成明显变速。
    const v = Math.min(0.025, Math.max(0.003, abs / 100));
    if (!state.syncing) el.video.playbackRate = err > 0 ? 1 + v : 1 - v;
    // 播放速率纠偏没有改变服务端窗口，用一个平滑的“有效目标”反映正在追赶的方向。
    animateAutoReadoutTo(clamp(state.videoDelay - err, 0, 300), state.audioDelay, 900);
    setAutoLabel('播放速率微调 ' + (err > 0 ? '+' : '-') + (v * 100).toFixed(1) + '%');
    return;
  }

  // 偏差太大：细纠偏要跑好几分钟，不如直接重算延迟（间隔限流）
  if (Date.now() - state.lastCoarseAt < 30000 || Date.now() - state.lastAutoActionAt < 12000) return;
  if (state.biliStatus && state.biliStatus.warmup) return;
  if (el.video.playbackRate !== 1 && !state.syncing) el.video.playbackRate = 1;
  state.driftSamples.length = 0;
  state.lastCoarseAt = Date.now();
  state.lastAutoActionAt = Date.now();
  setAutoLabel('重新计算延迟');
  autoRecalibrate(err);
}

/** 自动实时对齐的"粗调"：按当前偏差重算画面延迟并重载 */
function autoRecalibrate(err) {
  const maxVideo = Math.max(0, Math.round(state.videoMaxDelay));
  const maxAudio = Math.max(0, Math.round(state.audioMaxDelay || state.audioHardMax || 15));
  let vTarget = state.videoDelay - err;
  let aTarget = state.audioDelay;
  if (vTarget < 0) { aTarget += -vTarget; vTarget = 0; }
  if (vTarget > maxVideo) { aTarget += vTarget - maxVideo; vTarget = maxVideo; }
  aTarget = clamp(aTarget, 0, maxAudio);
  const dv = clamp(vTarget - state.videoDelay, -20, 20);
  const da = clamp(aTarget - state.audioDelay, -20, 20);
  const nv = clamp(Math.round(state.videoDelay + dv), 0, maxVideo);
  const na = clamp(Math.round(state.audioDelay + da), 0, maxAudio);
  if (nv === state.videoDelay && na === state.audioDelay) return;
  setVideoDelay(nv); setAudioDelay(na);
  applyVideoDelay(); applyAudioDelay(); savePrefs();
  animateAutoReadoutTo(nv, na, 900);
  setAutoInfo('服务端延迟：画面 ' + nv + ' 秒，声音 ' + na + ' 秒');
  flashStatus('自动对齐：调整到画面 ' + nv + 's / 声音 ' + na + 's');
}

function setAutoAlign(on) {
  state.autoAlign = !!on;
  el.btnAuto.classList.toggle('on', state.autoAlign);
  setAutoLabel(state.autoAlign ? '等待稳定采样' : '关');
  if (state.autoAlign) {
    setAutoReadout(state.videoDelay, state.audioDelay);
    setAutoInfo('服务端延迟：画面 ' + state.videoDelay + ' 秒，声音 ' + state.audioDelay + ' 秒');
  }
  localStorage.setItem('avsync.auto', state.autoAlign ? '1' : '0');
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = 0; }
  if (!state.autoAlign) {
    if (!state.syncing) el.video.playbackRate = 1;
    state.driftSamples.length = 0;
    return;
  }
  state.driftSamples.length = 0;
  state.stableSince = 0;
  state.lastAutoActionAt = 0;
  state.autoTimer = setInterval(autoTick, 1000);
}

function setAutoLabel(detail) {
  el.btnAuto.textContent = '🔁 自动实时对齐：' + detail;
  if (!state.autoAlign) setAutoInfo('自动调整：未开启');
}

function setAutoInfo(text) {
  if (el.autoInfo) el.autoInfo.textContent = text;
}

function renderAutoReadout() {
  if (el.autoVideoDelay) el.autoVideoDelay.value = String(state.autoVideoDelay);
  if (el.autoVideoDelayNum) el.autoVideoDelayNum.textContent = String(state.autoVideoDelay);
  if (el.autoAudioDelay) el.autoAudioDelay.value = String(state.autoAudioDelay);
  if (el.autoAudioDelayNum) el.autoAudioDelayNum.textContent = String(state.autoAudioDelay);
}

function setAutoReadout(v, a = state.audioDelay) {
  state.autoVideoDelay = clamp(Math.round(Number(v) || 0), 0, 300);
  // 自动结果条只是显示，不使用手动声音滑块的 15 秒控制上限。
  state.autoAudioDelay = clamp(Math.round(Number(a) || 0), 0, 300);
  renderAutoReadout();
}

function animateAutoReadoutTo(v, a = state.audioDelay, duration = 700) {
  const fromV = state.autoVideoDelay;
  const fromA = state.autoAudioDelay;
  const toV = clamp(Math.round(Number(v) || 0), 0, 300);
  const toA = clamp(Math.round(Number(a) || 0), 0, 300);
  if (state.autoReadoutRaf) cancelAnimationFrame(state.autoReadoutRaf);
  const started = performance.now();
  const frame = (now) => {
    const t = clamp((now - started) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    state.autoVideoDelay = Math.round(fromV + (toV - fromV) * eased);
    state.autoAudioDelay = Math.round(fromA + (toA - fromA) * eased);
    renderAutoReadout();
    if (t < 1) state.autoReadoutRaf = requestAnimationFrame(frame);
    else state.autoReadoutRaf = 0;
  };
  state.autoReadoutRaf = requestAnimationFrame(frame);
}

/** 在状态行上闪一句提示，让用户知道自动对齐做了什么 */
let flashTimer = 0;
function flashStatus(msg) {
  stateLabel('v', 'live', msg);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    const ch = state.channels.find((c) => c.slug === state.slug);
    if (ch) stateLabel('v', 'live', ch.name + (state.videoDelay ? ' +' + state.videoDelay + 's' : ''));
  }, 4000);
}

/** 一键对齐：量出差值，把两个延迟配到刚好抵消 */
async function align() {
  if (!state.room || !state.slug) { alert('先把画面和声音都加载起来'); return; }
  el.btnAlign.disabled = true;
  const t0 = Date.now();
  let diff = NaN;
  try {
    // 等测量稳定：差值要连续几个采样都接近才认
    for (;;) {
      if (Date.now() - t0 > 20000) break;
      if (state.diffSamples.length >= 7) {
        const last = state.diffSamples.slice(-5);
        const mx = Math.max(...last), mn = Math.min(...last);
        if (mx - mn < 1.5) { diff = median(last); break; }
      }
      await sleep(400);
    }
    if (!Number.isFinite(diff)) diff = currentDiff();
    if (!Number.isFinite(diff)) { alert('还量不到差值，等两个画面都播起来再试'); return; }

    applyAlignment(diff);
  } finally {
    el.btnAlign.disabled = false;
  }
}

function applyAlignment(diff) {
  // 目标：把差值调到 0。
  // diff > 0（画面更慢）-> 画面延迟要减掉 diff
  // diff < 0（画面更快）-> 画面延迟要加上 |diff|
  let vDelay = state.videoDelay - diff;
  let aDelay = state.audioDelay;
  if (vDelay < 0) {
    // 画面已经到最新边缘还是“太快”？那就把声音也往后拖，等效抵消
    aDelay += -vDelay;
    vDelay = 0;
  }
  // 受各自上限约束，剩下的部分扔给另一边
  if (vDelay > state.videoMaxDelay) {
    const rest = vDelay - state.videoMaxDelay;
    vDelay = state.videoMaxDelay;
    aDelay += rest;
  }
  if (aDelay > state.audioMaxDelay) aDelay = state.audioMaxDelay;
  vDelay = clamp(Math.round(vDelay), 0, Math.max(0, Math.round(state.videoMaxDelay)));
  aDelay = clamp(Math.round(aDelay), 0, Math.max(0, Math.round(state.audioMaxDelay)));
  setVideoDelay(vDelay);
  setAudioDelay(aDelay);
  setAutoReadout(vDelay, aDelay);
  state.diffSamples.length = 0;
  applyVideoDelay(); applyAudioDelay();
}

// ------------------------------------------------------------------ 界面刷新

function paint() {
  readLatencies();
  pushDiff();
  el.mVideo.textContent = Number.isFinite(state.videoLag) ? fmt(state.videoLag, 1) + ' s' : '—';
  el.mAudio.textContent = Number.isFinite(state.audioLag) ? fmt(state.audioLag, 1) + ' s' : '—';
  const diff = currentDiff();
  el.mDiff.textContent = Number.isFinite(diff) ? (diff >= 0 ? '+' : '') + fmt(diff, 1) + ' s' : '—';
  el.mDiff.className = 'v ' + (Number.isFinite(diff) ? (Math.abs(diff) < 1.0 ? 'good' : Math.abs(diff) < 4 ? 'mid' : 'bad') : '');
  el.videoLat.textContent = '视频滞后 ' + (Number.isFinite(state.videoLag) ? fmt(state.videoLag, 1) + 's' : '—');
  el.audioLat.textContent = '声音滞后 ' + (Number.isFinite(state.audioLag) ? fmt(state.audioLag, 1) + 's' : '—');
  const now = new Date(Date.now() + state.serverSkew);
  el.clock.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
}

setInterval(paint, 250);
setInterval(() => { if (el.video.currentTime) updateRes(); }, 3000);

/** 定期问服务端“两边最多能延迟多少秒”，顺便检查直播间是否可播 */
setInterval(async () => {
  try {
    if (state.slug) {
      const d = await api('/api/ysp/debug?slug=' + encodeURIComponent(state.slug));
      state.videoMaxDelay = Math.min(300, Number(d.maxDelaySec) || 0);
    }
    if (state.room) {
      const d = await api('/api/bili/status/' + encodeURIComponent(state.room));
      state.audioMaxDelay = Math.min(300, Number(d.maxDelaySec) || 0);
      state.biliStatus = d;
      if (d.error && el.audio.paused) stateLabel('a', 'err', d.error);
    }
    paintCaps();
  } catch { /* ignore */ }
}, 4000);

function paintCaps() {
  const vMax = Math.round(state.videoMaxDelay), aMax = Math.round(state.audioMaxDelay);
  el.videoCap.textContent = vMax
    ? `画面延迟上限约 ${vMax} 秒（央视频时移窗口）`
    : '正在统计画面可用延迟…';
  el.videoCap.className = 'cap' + (state.videoDelay > vMax ? ' warn' : '');
  el.audioCap.textContent = aMax
    ? (state.biliStatus && state.biliStatus.warmup
      ? `声音延迟可用 ${aMax} 秒，正在预热；还差约 ${Math.ceil(state.biliStatus.warmupRemainingSec || 0)} 秒`
      : `声音延迟安全上限 ${aMax} 秒（分片地址有效窗口）`)
    : '声音延迟上限统计中…刚打开时上限较小，等一会儿会变大';
  el.audioCap.className = 'cap' + (state.audioDelay > aMax ? ' warn' : '');
}

function setVideoDelay(v) {
  state.videoDelay = clamp(Math.round(Number(v) || 0), 0, 300);
  el.offset.value = String(state.videoDelay);
  el.offsetNum.textContent = String(state.videoDelay);
  el.offsetHint.textContent = state.videoDelay
    ? `画面比最新直播延后 ${state.videoDelay} 秒`
    : '画面贴着最新直播（不再额外延后）';
}

function setAudioDelay(v) {
  const hard = state.audioHardMax || 15;
  state.audioDelay = clamp(Math.round(Number(v) || 0), 0, hard);
  el.audioDelay.value = String(state.audioDelay);
  el.audioDelayNum.textContent = String(state.audioDelay);
}

// ------------------------------------------------------------------ 事件

el.channelFilter.addEventListener('input', () => renderChannels(el.channelFilter.value));
el.sourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideoFromInput(); });
// 之前这里是空的 —— 所以下拉里选了频道什么都不发生，必须手动点"加载"。
// 现在选了就直接切（下拉本身就是"换台"的直觉动作）。
el.channelSelect.addEventListener('change', () => {
  const slug = el.channelSelect.value;
  if (!slug) return;
  // 下拉选择了就不要再让输入框里的旧链接覆盖它
  el.sourceInput.value = '';
  localStorage.setItem('avsync.source', '');
  loadVideo(slug);
});
el.channelSelect.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideo(el.channelSelect.value); });
el.btnLoadVideo.addEventListener('click', loadVideoFromInput);
el.btnLoadAudio.addEventListener('click', () => loadBili(el.roomInput.value));
el.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadBili(el.roomInput.value); });

el.offset.addEventListener('input', () => setVideoDelay(el.offset.value));
el.offset.addEventListener('change', () => { applyVideoDelay(); savePrefs(); });
el.audioDelay.addEventListener('input', () => setAudioDelay(el.audioDelay.value));
el.audioDelay.addEventListener('change', () => { applyAudioDelay(); savePrefs(); });

el.btnAlign.addEventListener('click', align);
el.btnAuto.addEventListener('click', () => setAutoAlign(!state.autoAlign));
el.btnZero.addEventListener('click', () => {
  setVideoDelay(0); setAudioDelay(0);
  applyVideoDelay(); applyAudioDelay(); savePrefs();
});

// ---- 全屏 ----
function isFull() {
  return document.fullscreenElement === el.videoStage
      || document.webkitFullscreenElement === el.videoStage;
}
function toggleFull() {
  if (!el.videoStage) return;
  if (!isFull()) {
    const req = el.videoStage.requestFullscreen || el.videoStage.webkitRequestFullscreen;
    if (req) req.call(el.videoStage).catch(() => { /* 用户拒绝或不允许，忽略 */ });
    else if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen();
  } else {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex) ex.call(document).catch(() => {});
  }
}
function paintFullBtn() {
  el.btnFull.textContent = isFull() ? '⛶ 退出全屏' : '⛶ 全屏';
}
el.btnFull.addEventListener('click', (e) => { e.stopPropagation(); toggleFull(); });
el.videoStage.addEventListener('dblclick', toggleFull);
document.addEventListener('fullscreenchange', paintFullBtn);
document.addEventListener('webkitfullscreenchange', paintFullBtn);

el.btnPlay.addEventListener('click', async () => {
  if (el.video.paused) { try { await el.video.play(); } catch { /* ignore */ } ; try { await el.audio.play(); } catch { /* ignore */ } ; el.btnPlay.textContent = '⏸ 暂停'; }
  else { el.video.pause(); el.audio.pause(); el.btnPlay.textContent = '▶ 播放'; }
});
el.btnMute.addEventListener('click', () => {
  el.audio.muted = !el.audio.muted;
  el.btnMute.textContent = el.audio.muted ? '🔇 已静音' : '🔈 声音开';
});
el.volume.addEventListener('input', () => { el.audio.volume = Number(el.volume.value) / 100; });

el.btnSearch.addEventListener('click', doSearch);
el.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const q = el.searchInput.value.trim();
  if (!q) return;
  el.searchResults.innerHTML = '<div class="result"><span class="t">搜索中…</span></div>';
  try {
    const { list } = await api('/api/bili/search?q=' + encodeURIComponent(q) + '&limit=10');
    if (!list || !list.length) { el.searchResults.innerHTML = '<div class="result"><span class="t">没有结果</span></div>'; return; }
    el.searchResults.innerHTML = list.map((r) =>
      `<div class="result" data-room="${r.roomid}">
         <span class="t">${escapeHtml(r.title || '(无标题)')}</span>
         <span class="u">${escapeHtml(r.uname || '')}</span>
         <span class="o">${r.online || 0}</span>
       </div>`).join('');
    el.searchResults.querySelectorAll('.result').forEach((n) => {
      n.addEventListener('click', () => {
        el.roomInput.value = n.dataset.room;
        loadBili(n.dataset.room);
      });
    });
  } catch (e) {
    el.searchResults.innerHTML = `<div class="result"><span class="t">搜索失败：${escapeHtml(e.message)}</span></div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

el.btnBiliShow.addEventListener('click', () => {
  const small = el.audio.closest('.stage');
  const hidden = small.classList.toggle('hidden');
  el.btnBiliShow.textContent = hidden ? '显示B站画面' : '隐藏B站画面';
});

el.btnOpenPP.addEventListener('click', async () => {
  const q = el.sourceInput.value.trim() || el.channelSelect.value;
  const delay = Math.round(state.videoDelay);
  try {
    const r = await api('/api/open-player?player=potplayer&kind=ysp&q='
      + encodeURIComponent(q) + '&delay=' + delay);
    if (r.error) alert('打开失败：' + r.error);
  } catch (e) { alert('打开失败：' + e.message); }
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  const shift = e.shiftKey ? 5 : 1;
  switch (e.key) {
    case ' ': e.preventDefault(); el.btnPlay.click(); break;
    case 'f': case 'F': toggleFull(); break;
    case 'r': case 'R': setAutoAlign(!state.autoAlign); break;
    case 'ArrowLeft': e.preventDefault(); setVideoDelay(state.videoDelay - shift); applyVideoDelay(); savePrefs(); break;
    case 'ArrowRight': e.preventDefault(); setVideoDelay(state.videoDelay + shift); applyVideoDelay(); savePrefs(); break;
    case 'ArrowUp': e.preventDefault(); setAudioDelay(state.audioDelay + shift); applyAudioDelay(); savePrefs(); break;
    case 'ArrowDown': e.preventDefault(); setAudioDelay(state.audioDelay - shift); applyAudioDelay(); savePrefs(); break;
    case 'a': case 'A': align(); break;
    case '0': setVideoDelay(0); setAudioDelay(0); applyVideoDelay(); applyAudioDelay(); savePrefs(); break;
    default: break;
  }
});

// ------------------------------------------------------------------ 启动

function savePrefs() {
  localStorage.setItem('avsync.prefs', JSON.stringify({
    videoDelay: state.videoDelay, audioDelay: state.audioDelay,
  }));
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('avsync.prefs') || '{}');
    setVideoDelay(p.videoDelay || 0);
    setAudioDelay(p.audioDelay || 0);
  } catch { /* ignore */ }
}

async function boot() {
  // 时钟对齐：画面取的是“最新直播”，播放器用本机时钟定位，本机时钟偏了画面就偏。
  // 这里把偏差报给服务端，由服务端在取流时补上（两个源都会受益）。
  try {
    const t0 = Date.now();
    const now = await fetch('/api/time', { cache: 'no-store' }).then((r) => r.json());
    const rtt = Date.now() - t0;
    const skew = Math.round((t0 + rtt / 2) - now.ms);
    state.serverSkew = -skew;
    await fetch('/api/settime?skew=' + skew, { cache: 'no-store' });
  } catch { /* ignore */ }

  try {
    const cfg = await api('/api/config');
    el.cfgInfo.textContent = cfg.potplayer ? 'PotPlayer 已就绪' : 'PotPlayer 未找到（可手动配置）';
    // 声音延迟有硬上限（B站分片地址滚动过期），把滑块上限对齐到实际能力
    if (cfg.maxAudioDelay) {
      state.audioHardMax = cfg.maxAudioDelay;
      el.audioDelay.max = String(cfg.maxAudioDelay);
      if (state.audioDelay > cfg.maxAudioDelay) setAudioDelay(cfg.maxAudioDelay);
    }
  } catch { /* ignore */ }

  await loadChannels();
  loadPrefs();

  const lastRoom = localStorage.getItem('avsync.room') || '';
  if (lastRoom) el.roomInput.value = lastRoom;
  el.roomInput.addEventListener('change', () => localStorage.setItem('avsync.room', el.roomInput.value));

  const srcSaved = localStorage.getItem('avsync.source') || '';
  if (srcSaved) el.sourceInput.value = srcSaved;
  el.sourceInput.addEventListener('change', () => localStorage.setItem('avsync.source', el.sourceInput.value));

  // 自动加载上次用的频道与直播间
  const slug = localStorage.getItem('avsync.channel') || 'cctv5';
  if (state.channels.some((c) => c.slug === slug)) {
    el.channelSelect.value = slug;
    loadVideo(slug);
  }
  if (lastRoom) loadBili(lastRoom);

  // 恢复"自动实时对齐"的开关状态
  if (localStorage.getItem('avsync.auto') === '1') setAutoAlign(true);

  paintCaps();
  paintFullBtn();
}

boot();
