// bili.mjs — B站直播取流（房间号 → 可播放的 HLS 地址 / 播放列表）
// 只用公开的网页播放接口，不需要登录；如需更高清晰度，可在 config.json 填入自己的 Cookie。
// 无第三方依赖。

import fs from 'node:fs';
import path from 'node:path';
import { rawRequest, rawGet } from './http.mjs';
import { SegmentBuffer } from './ysp.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let cookie = '';
export function setCookie(c) { cookie = (c || '').trim(); }

/** 定期清理两个"房间号 -> 值"的缓存，避免长期运行时无限增长 */
export function pruneCaches(maxAgeMs = 60 * 60000) {
  const now = Date.now();
  for (const [k, v] of roomCache) {
    if (typeof v === 'string' && v === k) roomCache.delete(k);   // 冗余别名
  }
  for (const [k, v] of urlCache) {
    if (!v || !v.ts || now - v.ts > maxAgeMs) urlCache.delete(k);
  }
  if (roomCache.size > 500) roomCache.clear();
}

function apiHeaders(extra = {}) {
  const h = {
    'User-Agent': UA,
    Referer: 'https://live.bilibili.com/',
    Origin: 'https://live.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extra,
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function withCookie(extra = {}) {
  const h = { ...extra };
  if (cookie) h.Cookie = cookie;
  return h;
}

async function apiJson(url) {
  const r = await rawRequest(url, { headers: apiHeaders(), timeout: 20000 });
  if (r.status !== 200) throw new Error('bili api http ' + r.status);
  return JSON.parse(r.body.toString('utf8'));
}

// ------------------------------------------------------------------ 取流

const roomCache = new Map();   // 输入的 id -> 真实 room_id
const urlCache = new Map();    // room_id -> { urls, hls, ts }

/** 支持直播间号、短号、以及 live.bilibili.com/xxxx 形式的输入 */
export async function resolveRoomId(input) {
  const s = String(input).trim();
  const m = s.match(/(\d+)/);
  if (!m) throw new Error('无法识别直播间号: ' + s);
  const id = m[1];
  if (roomCache.has(id)) return roomCache.get(id);
  const j = await apiJson('https://api.live.bilibili.com/room/v1/Room/room_init?id=' + id);
  if (j.code !== 0) throw new Error('bili room_init: ' + (j.message || j.code));
  const rid = String(j.data.room_id);
  roomCache.set(id, rid);
  roomCache.set(rid, rid);
  return rid;
}

/** 直播间当前是否在播 + 标题/主播 */
export async function roomInfo(roomId) {
  try {
    const j = await apiJson('https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=' + roomId);
    if (j.code !== 0) return { live: null, title: '', uname: '' };
    const d = j.data || {};
    return {
      live: d.room_info ? d.room_info.live_status === 1 : null,
      title: (d.room_info && d.room_info.title) || '',
      uname: (d.anchor_info && d.anchor_info.base_info && d.anchor_info.base_info.uname) || '',
    };
  } catch { return { live: null, title: '', uname: '' }; }
}

/** 拿到该房间所有可用的 http 流地址（HLS 优先，失败可回退 FLV） */
export async function playInfo(roomId, { qn = 10000, refresh = false } = {}) {
  const cached = urlCache.get(roomId);
  if (!refresh && cached && Date.now() - cached.ts < 60_000) return cached;
  const q = new URLSearchParams({
    room_id: roomId, protocol: '0,1', format: '0,1,2', codec: '0,1',
    qn: String(qn), platform: 'web', ptype: '8', dolby: '5', panorama: '1',
    https_url_req: '1', web_location: '444.8',
  });
  const j = await apiJson('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?' + q);
  if (j.code !== 0) throw new Error('bili playinfo: ' + (j.message || j.code));
  const data = j.data || {};
  const streams = (((data.playurl_info || {}).playurl || {}).stream) || [];
  const items = [];
  for (const s of streams) {
    for (const f of s.format || []) {
      for (const c of f.codec || []) {
        for (const u of c.url_info || []) {
          items.push({
            protocol: s.protocol_name, format: f.format_name, codec: c.codec_name,
            qn: c.current_qn, acceptQn: c.accept_qn, host: u.host,
            url: u.host + c.base_url + (u.extra || ''),
          });
        }
      }
    }
  }
  // 首选 hls/ts/avc（浏览器兼容最好），其次 hls/fmp4/avc，再 flv/avc
  const score = (i) => {
    let s = 0;
    if (i.protocol === 'http_hls') s += 100;
    if (i.format === 'ts') s += 20;
    if (i.format === 'fmp4') s += 10;
    if (i.codec === 'avc') s += 5;
    return s;
  };
  const usable = items.filter((i) => i.codec === 'avc').sort((a, b) => score(b) - score(a));
  const hls = usable.find((i) => i.protocol === 'http_hls');
  const flv = usable.find((i) => i.protocol === 'http_stream');
  const out = {
    urls: items, hls: hls ? hls.url : '', flv: flv ? flv.url : '',
    liveStatus: data.live_status, ts: Date.now(), qn,
  };
  if (!out.hls && !out.flv) {
    const err = new Error(data.live_status === 0 ? '该直播间当前未开播' : '没有可用的播放地址');
    err.code = 'NO_STREAM';
    throw err;
  }
  urlCache.set(roomId, out);
  return out;
}

// ------------------------------------------------------------------ 带延迟缓冲的房间
/**
 * B站直播也是 HLS，但上游清单只有很短的窗口（约 3~5 片），想"延迟 N 秒"就必须
 * 自己把分片攒下来。这里给每个房间开一个后台轮询器，把分片按序号攒进缓冲，
 * 再按要求的延迟切窗口下发——和央视频那边用的是同一套机制。
 */
export class BiliRoom {
  constructor(roomId) {
    this.roomId = String(roomId);
    // B站直播分片是 1 秒级的 fMP4，上上游窗口只有约 10 秒，所以要勤快轮询
    // 才能把历史攒下来（延迟上限 = 攒到的时长）。
    this.buffer = new SegmentBuffer({ maxKeep: 1200, maxSpanSec: 1200, seqBase: 1 });
    this.timer = null;
    this.lastAccess = Date.now();   // 不能被当成 0，否则"多久没访问"会显示成 17 亿秒
    this.refreshing = false;
    this.lastError = '';
    this.stats = { polls: 0, errors: 0, added: 0 };
    this.info = null;
  }

  touch() {
    this.lastAccess = Date.now();
    if (!this.timer) this.arm();
  }

  arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  async poll() {
    this.timer = null;
    if (Date.now() - this.lastAccess > IDLE_MS) return;   // 没人看就停
    await this.refresh().catch(() => {});
    if (Date.now() - this.lastAccess <= IDLE_MS) this.arm();
  }

  async refresh() {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      const pi = await playInfo(this.roomId, { qn: 10000 });
      if (pi.liveStatus === 0) {
        this.lastError = '该直播间当前未开播';
        this.stats.errors++;
        return false;
      }
      if (!pi.hls) { this.lastError = '该直播间没有 HLS 流'; this.stats.errors++; return false; }
      const res = await rawGet(pi.hls, { headers: apiHeaders(), timeout: 15000 });
      if (res.status !== 200) throw new Error('bili m3u8 http ' + res.status);
      const text = res.body.toString('utf8');
      if (!text.includes('#EXTM3U')) throw new Error('bili m3u8 内容异常');
      const base = res.url || pi.hls;
      this.listUrl = base;
      const seq0 = mediaSequenceOf(text);
      // 上游偶尔不给 MEDIA-SEQUENCE，此时不能用 'sq:null' 当 key——那样所有分片
      // 会被去重成一条，延迟功能会静默失效。退化成按"文件名"当 key。
      let listSeq = 0;
      const segs = parseBiliSegments(text, base, seq0).map((s) => ({
        ...s,
        seq: seq0 !== null ? s.seq : listSeq++,
        key: seq0 !== null
          ? 'sq:' + s.seq
          : 'fn:' + (s.url.split('?')[0].split('/').pop() || '') + ':' + s.dur,
        gen: base,
      }));
      // fMP4 流需要 #EXT-X-MAP 初始化段，它的地址也要按相对路径解出来
      const mapRaw = (text.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || '';
      if (mapRaw) this.mapUri = abs(mapRaw, base);
      this.lastUpstream = {
        at: Date.now(), seq0, n: segs.length,
        seqs: segs.map((s) => s.seq), durs: segs.map((s) => s.dur),
        map: this.mapUri ? this.mapUri.slice(-30) : '',
        tail: segs.length ? segs[segs.length - 1].url.slice(-40) : '',
      };
      // 分片按媒体序号做 key；epoch 用房间号这个常量，永远不触发清空，
      // 缓冲只按"保留时长"淘汰（B站每次轮询序号都会前进，不能用序号当 epoch）。
      const prevEpoch = this.buffer.epoch;
      void prevEpoch;
      this.buffer.addAll(segs, this.roomId + ':bili');
      this.lastError = '';
      this.stats.polls++;
      return true;
    } catch (e) {
      this.lastError = (e && e.message ? e.message : String(e)).slice(0, 160);
      this.stats.errors++;
      return false;
    } finally { this.refreshing = false; }
  }

  maxDelay() {
    // 只统计"地址还活着的"分片能覆盖多久——那才是能真正下发的量
    const alive = this.buffer.items.filter((i) => !i.urlAt || Date.now() - i.urlAt <= URL_MAX_AGE_MS);
    let span = 0;
    for (const it of alive) span += it.dur || 0;
    return Math.min(BILI_MAX_DELAY_SEC, Math.max(0, span - PLAY_SEGS * 1 - 2));
  }

  /** 当前仍可安全下发的历史窗口（用于前端显示预热进度）。 */
  freshSpan() {
    const now = Date.now();
    let span = 0;
    for (const it of this.buffer.items) {
      if (!it.urlAt || now - it.urlAt <= URL_MAX_AGE_MS) span += it.dur || 0;
    }
    return Math.round(span * 10) / 10;
  }

  snapshot() {
    const safeDelay = this.maxDelay();
    return {
      roomId: this.roomId, error: this.lastError, buffered: this.buffer.size,
      bufferSpanSec: this.buffer.spanSec(), freshSpanSec: this.freshSpan(),
      maxDelaySec: safeDelay, safeDelaySec: safeDelay,
      warmup: safeDelay < BILI_MAX_DELAY_SEC,
      warmupRemainingSec: Math.max(0, BILI_MAX_DELAY_SEC - safeDelay),
      polls: this.stats.polls, errors: this.stats.errors,
      lastUpstream: this.lastUpstream,
      keys: this.buffer.items.slice(-3).map((i) => i.key),
      lastAccessAgo: Math.round((Date.now() - this.lastAccess) / 1000),
    };
  }

  playlist(origin, delaySec = 0) {
    // 先把地址已经死掉的分片剔掉，免得下发死链
    this.buffer.dropExpiredUrls(URL_MAX_AGE_MS);
    const win = this.buffer.window(delaySec, PLAY_SEGS);
    const segs = SegmentBuffer.contiguous(win);
    if (!segs.length) return null;
    const target = Math.max(2, Math.max(...segs.map((s) => Math.round(s.dur))));
    const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + target,
      '#EXT-X-MEDIA-SEQUENCE:' + (segs[0].seq ?? 0),
      '#EXT-X-ALLOW-CACHE:NO', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-START:TIME-OFFSET=0'];
    // fMP4 流的初始化段
    if (this.mapUri) out.push('#EXT-X-MAP:URI="' + proxySeg(this.mapUri, origin, this.roomId, this.listUrl) + '"');
    // 不要给 B站 造 #EXT-X-PROGRAM-DATE-TIME：B站清单本身不带墙钟，
    // 我们编一个反而会让播放器的延迟统计（playingDate）算错。
    // 前端对这条流改用 seekable 估算滞后。
    for (const s of segs) {
      out.push('#EXTINF:' + (s.dur || 1).toFixed(3) + ',');
      out.push(proxySeg(s.url, origin, this.roomId, s.gen || this.listUrl));
    }
    return out.join('\n') + '\n';
  }
}

const POLL_MS = 1000;
const IDLE_MS = 180000;
const PLAY_SEGS = 8;
// B站分片地址是滚动过期的：实测最新片约 +36 秒失效、次新约 +60 秒。
// 超过这个年龄的地址就别再下发了——否则播放器拿到的是死链，
// 只能靠 404 兜底去救，白白卡一下。
const URL_MAX_AGE_MS = 20000;
// 因此"声音延迟"的实际上限大约就是这个窗口深度
export const BILI_MAX_DELAY_SEC = 15;

function mediaSequenceOf(text) {
  const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseBiliSegments(text, baseUrl, seq0) {
  const out = [];
  let dur = 3.0, idx = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const v = parseFloat(line.slice(8).split(',')[0]);
      dur = Number.isFinite(v) ? v : 3.0;
    } else if (!line.startsWith('#')) {
      out.push({ dur, url: abs(line, baseUrl), seq: seq0 === null ? null : seq0 + idx });
      idx++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ 播放列表改写（本地代理）

/** 取得 B站 HLS 的 m3u8 内容，并把其中地址改写成本代理地址。返回 null 表示该房间无 HLS，应当用 FLV。 */
export async function hlsPlaylist(roomId, origin, { qn = 10000 } = {}) {
  const info = await playInfo(roomId, { qn });
  if (!info.hls) return null;
  const res = await rawGet(info.hls, { headers: apiHeaders(), timeout: 20000 });
  if (res.status !== 200) throw new Error('bili m3u8 http ' + res.status);
  const text = res.body.toString('utf8');
  if (!text.includes('#EXTM3U')) throw new Error('bili m3u8 内容异常');
  const base = res.url || info.hls;
  return rewrite(text, base, origin);
}

/** 当前在播的清单地址（缓存片刻，避免每次刷新都打接口） */
let playlistUrlCache = { url: '', ts: 0, room: '' };

export async function currentPlaylistUrl(roomId, force) {
  const rid = String(roomId);
  if (!force && playlistUrlCache.room === rid && Date.now() - playlistUrlCache.ts < 5000) {
    return playlistUrlCache.url;
  }
  const pi = await playInfo(rid, { qn: 10000, refresh: true });
  playlistUrlCache = { url: pi.hls || '', ts: Date.now(), room: rid };
  return playlistUrlCache.url;
}

/**
 * 给一个失效的 B站分片找一个可用的新地址。
 *
 * 坑（实测出来的）：B站分片 URL 里有一个会轮换的路径段，例如
 *   .../live-bvc/909151/live_xxx-1791760226.ts     <- 上游现在给的
 *   .../live-bvc/464383/live_xxx-1791760226.ts     <- 我们当初缓存下来的
 * 所以**不能**把文件名拼到旧目录上（那样必然 404）。正确做法是重新取一份
 * 上游清单，按分片文件名找到它此刻的真实地址；找不到就说明这片已经从
 * B站 CDN 掉出窗口了，只能报错让播放器往前跳。
 */
export async function freshUrlFor(roomId, oldUrl, genUrl) {
  const name = filenameOf(oldUrl);
  if (!name) return '';
  const listUrl = await currentPlaylistUrl(roomId, genUrl).catch(() => '');
  if (!listUrl) return '';
  try {
    const r = await rawGet(listUrl, { headers: apiHeaders(), timeout: 10000 });
    if (r.status !== 200) return '';
    const text = r.body.toString('utf8');
    if (!text.includes('#EXTM3U')) return '';
    const base = r.url || listUrl;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const abs2 = abs(line, base);
      if (filenameOf(abs2) === name) return abs2;
    }
  } catch { /* ignore */ }
  return '';
}

/** 取 URL 的文件名（去掉 query） */
function filenameOf(u) {
  try { return (new URL(u).pathname.split('/').pop()) || ''; }
  catch { return (String(u).split('?')[0].split('/').pop()) || ''; }
}

function abs(u, base) { try { return new URL(u, base).toString(); } catch { return ''; } }

// ------------------------------------------------------------------ 播放列表改写（本地代理）

/** 假分片地址里带上"它出自哪份清单"，这样分片过期时可以按原来的 CDN 主机+路径重建签名 */
export function proxySeg(u, origin, room, gen) {
  const enc = Buffer.from(u, 'utf8').toString('base64url');
  const q = gen ? '?g=' + Buffer.from(gen, 'utf8').toString('base64url') : '';
  return origin + '/seg/' + (room ? 'b' + room + ':' : '') + enc + q;
}

export function rewrite(text, baseUrl, origin) {
  const out = [];
  let pendingMap = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    if (line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-PART:')) {
      pendingMap = true;
      out.push(line.replace(/URI="([^"]+)"/g, (_, u) => {
        const a = abs(u, baseUrl);
        return a ? 'URI="' + proxySeg(a, origin) + '"' : _;
      }));
    } else if (!line.startsWith('#')) {
      const a = abs(line, baseUrl);
      if (a) out.push(proxySeg(a, origin));
      else out.push(line);
      void pendingMap;
    } else out.push(line);
  }
  return out.join('\n') + '\n';
}

export async function searchLive(keyword, limit = 8) {
  const q = new URLSearchParams({ search_type: 'live_room', keyword, page: '1', page_size: String(limit) });
  const j = await apiJson('https://api.bilibili.com/x/web-interface/search/type?' + q);
  if (j.code !== 0) throw new Error('bili search: ' + (j.message || j.code));
  const list = ((j.data || {}).result || []).map((r) => ({
    roomid: r.roomid, uname: r.uname,
    title: String(r.title || '').replace(/<[^>]+>/g, ''),
    tag: r.tag, online: r.online,
  }));
  return list;
}

export function loadCookieFile(dir) {
  try {
    const p = path.join(dir, 'config.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg.biliCookie) setCookie(cfg.biliCookie);
      return cfg;
    }
  } catch { /* ignore */ }
  return {};
}
