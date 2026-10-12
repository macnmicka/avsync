// server.mjs — avsync 本地服务：央视频视频 + B站音频，同源代理 + 同步控制
// 浏览器网络请求全部走本机同源，彻底绕开跨域/防盗链限制。
// 无第三方依赖，Node 18+ 自带 fetch。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import {
  CHANNELS, CHANNEL_MAP, YspChannel, fetchSeg, proxyUrl, resolveChannelSlug,
  setClockSkew, clockSkew,
} from './ysp.mjs';
import * as bili from './bili.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8799);
const HOST = process.env.HOST || '127.0.0.1';

const cfg = bili.loadCookieFile(__dirname);
const VERBOSE = !!process.env.VERBOSE;

const yspChannels = new Map();
function getChannel(slug) {
  let ch = yspChannels.get(slug);
  if (!ch) {
    const def = CHANNEL_MAP.get(slug);
    if (!def) return null;
    ch = new YspChannel(def);
    yspChannels.set(slug, ch);
  }
  return ch;
}

const biliRooms = new Map();
function getRoom(roomId) {
  const k = String(roomId);
  let r = biliRooms.get(k);
  if (!r) { r = new bili.BiliRoom(k); biliRooms.set(k, r); }
  return r;
}

// ------------------------------------------------------------------ 工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(data);
}

function json(res, obj, code = 200) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function originOf(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  return 'http://' + host;
}

function decodeSegParam(param) {
  // base64url -> 原始 URL
  const s = decodeURIComponent(param);
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const u = b.toString('utf8');
  if (!/^https?:\/\//.test(u)) throw new Error('bad segment url');
  return u;
}

// ------------------------------------------------------------------ 静态文件

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    const rs = fs.createReadStream(file);
    // 必须在打开后出错前挂上 error 处理，否则文件被删/权限变化会让整个进程退出
    rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    rs.pipe(res);
  });
}

// ------------------------------------------------------------------ 路由

const server = http.createServer(async (req, res) => {
  // 注意：解析必须在 try 里。handler 是 async，抛在这里会变成
  // unhandled rejection，Node 22 默认直接终止整个进程——
  // 一个畸形请求目标(比如 "GET //["）就能把服务打死。
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'bad request target');
  }
  const p = url.pathname;
  const origin = originOf(req);
  try {
    if (p === '/api/channels') {
      return json(res, {
        channels: CHANNELS.map((c) => ({ slug: c[0], name: c[1], defn: c[4] })),
      });
    }

    if (p === '/api/time') {
      return json(res, { ms: Date.now(), skew: clockSkew(), iso: new Date().toISOString() });
    }

    // 前端上报"你的时钟比服务端快多少毫秒"，用来保证画面取的是真正最新的直播位置
    if (p === '/api/settime') {
      const skew = setClockSkew(Number(url.searchParams.get('skew') || 0));
      return json(res, { skew });
    }

    // 把用户粘贴的链接/频道名/简称解析成频道（视频源）
    if (p === '/api/resolve-channel') {
      const q = url.searchParams.get('q') || '';
      const slug = resolveChannelSlug(q);
      if (!slug) return json(res, { error: '认不出这个频道，试试频道名、cctv5p 这样的简称，或央视直播页链接' }, 404);
      const c = CHANNEL_MAP.get(slug);
      return json(res, { slug, name: c.name });
    }

    if (p === '/api/config') {
      return json(res, {
        hasCookie: !!cfg.biliCookie,
        port: PORT,
        potplayer: findPotplayer(),
        // B站分片地址滚动过期，所以"声音延迟"有个硬上限（约 15 秒）
        maxAudioDelay: bili.BILI_MAX_DELAY_SEC || 15,
      });
    }

    if (p === '/api/ysp/status') {
      const out = {};
      for (const [slug, ch] of yspChannels) {
        out[slug] = { mode: ch.mode, segs: ch.buffer.size, spanSec: ch.buffer.spanSec(), error: ch.lastError };
      }
      return json(res, out);
    }

    if (p === '/api/ysp/debug') {
      const slug = url.searchParams.get('slug') || 'cctv5';
      const ch = yspChannels.get(slug);
      if (!ch) return json(res, { error: 'channel not started' }, 404);
      return json(res, { slug, now: Date.now(), ...ch.snapshot() });
    }

    if (p === '/api/debug') {
      const out = { ysp: {}, bili: {} };
      for (const [k, v] of yspChannels) out.ysp[k] = v.snapshot();
      for (const [k, v] of biliRooms) out.bili[k] = v.snapshot();
      return json(res, out);
    }

    if (p.startsWith('/api/bili/search')) {
      const kw = url.searchParams.get('q') || '';
      if (!kw.trim()) return json(res, { list: [] });
      try {
        const list = await bili.searchLive(kw.trim(), Number(url.searchParams.get('limit') || 8));
        return json(res, { list });
      } catch (e) { return json(res, { error: e.message }, 502); }
    }

    if (p.startsWith('/api/bili/info')) {
      const input = url.searchParams.get('room') || '';
      try {
        const rid = await bili.resolveRoomId(input);
        const info = await bili.roomInfo(rid);
        let streams = { hls: false, flv: false, qn: null };
        try {
          const pi = await bili.playInfo(rid, { qn: Number(url.searchParams.get('qn') || 10000) });
          streams = { hls: !!pi.hls, flv: !!pi.flv, qn: pi.qn };
        } catch (e) { streams.error = e.message; }
        return json(res, { roomId: rid, ...info, streams });
      } catch (e) { return json(res, { error: e.message }, 502); }
    }

    // HLS 清单：央视频（?delay=N 表示画面再往后推 N 秒，用于和别的音源对齐）
    let m = p.match(/^\/ysp\/([\w]+)\.m3u8$/);
    if (m) {
      const ch = getChannel(m[1]);
      if (!ch) return send(res, 404, '未知频道');
      ch.touch();
      const delay = Math.max(0, Math.min(600, Number(url.searchParams.get('delay') || 0) || 0));
      let pl = ch.playlist(origin, delay);
      if (!pl) {
        // 冷启动要等首刷：bkliveinfo 那几路要探测多个 CDN 才能确定可用地址，
        // 比 JCE 慢，所以等待预算给足（约 12 秒）。
        for (let i = 0; i < 30 && !pl; i++) {
          await new Promise((r) => setTimeout(r, 400));
          pl = ch.playlist(origin, delay);
        }
      }
      if (!pl) return send(res, 503, `频道 ${ch.name} 暂无数据 (${ch.lastError || '拉取中'}), 请稍后重试`);
      return send(res, 200, pl, 'application/vnd.apple.mpegurl');
    }

    // HLS 清单：B站（?delay=N 表示声音相对最新直播再往后推 N 秒）
    m = p.match(/^\/bili\/([\w]+)\.m3u8$/);
    if (m) {
      const room = getRoom(m[1]);
      room.touch();
      const delay = Math.max(0, Math.min(600, Number(url.searchParams.get('delay') || 0) || 0));
      let pl = room.playlist(origin, delay);
      if (!pl) {
        for (let i = 0; i < 5 && !pl; i++) {
          await new Promise((r) => setTimeout(r, 500));
          pl = room.playlist(origin, delay);
        }
      }
      if (!pl) {
        return json(res, {
          error: room.lastError || '该直播间暂时取不到流（可能未开播）',
          buffered: room.buffer.size, spanSec: room.buffer.spanSec(),
        }, 502);
      }
      return send(res, 200, pl, 'application/vnd.apple.mpegurl');
    }

    // B站房间状态（含"最多能延迟多少秒"）
    m = p.match(/^\/api\/bili\/status\/([\w]+)$/);
    if (m) {
      const room = getRoom(m[1]);
      return json(res, room.snapshot());
    }

    // B站 FLV 直链（兜底）
    m = p.match(/^\/bili\/([\w]+)\.flv$/);
    if (m) {
      try {
        const pi = await bili.playInfo(m[1], { qn: Number(url.searchParams.get('qn') || 10000) });
        if (!pi.flv) return json(res, { error: '无 FLV 流' }, 502);
        return json(res, { url: pi.flv });
      } catch (e) { return json(res, { error: e.message }, 502); }
    }

    // 分片 / 子清单统一代理。B站的分片地址带房间号前缀（b<room>:<base64>），
    // 这样地址过期时可以按房间重新取签名。
    if (p.startsWith('/seg/')) {
      let param = p.slice(5);
      let room = '';
      const hm = param.match(/^b(\d+):/);
      if (hm) { room = hm[1]; param = param.slice(hm[0].length); }
      let target;
      try { target = decodeSegParam(param); }
      catch { return send(res, 400, 'bad seg'); }
      try {
        const upstream = await fetchSeg(target);
        return send(res, upstream.status, upstream.body,
          upstream.headers['content-type'] || 'application/octet-stream');
      } catch (e) {
        // B站的签名地址会过期：用假地址上带的 ?g=<这份分片当初出自的清单>
        // 重建一个新签名地址再试一次
        if (room) {
          let gen = url.searchParams.get('g') || '';
          if (gen) { try { gen = Buffer.from(gen, 'base64url').toString('utf8'); } catch { gen = ''; } }
          const fresh = await bili.freshUrlFor(room, target, gen).catch(() => '');
          if (fresh && fresh !== target) {
            const up2 = await fetchSeg(fresh);
            return send(res, up2.status, up2.body,
              up2.headers['content-type'] || 'application/octet-stream');
          }
        }
        throw e;
      }
    }

    // 打开外部播放器（可选便利功能）：把本代理的清单地址交给 PotPlayer/VLC
    if (p === '/api/open-player') {
      const which = url.searchParams.get('player') || 'potplayer';
      const kind = url.searchParams.get('kind') || 'ysp';
      const q = url.searchParams.get('q') || url.searchParams.get('slug') || 'cctv5';
      const room = url.searchParams.get('room') || '';
      const exe = which === 'potplayer' ? findPotplayer() : which === 'vlc' ? findVlc() : '';
      if (!exe) return json(res, { error: `未找到 ${which}，可在 config.json 里写路径` }, 404);
      let target = '';
      if (kind === 'ysp') {
        const slug = resolveChannelSlug(q);
        const ch = slug ? getChannel(slug) : null;
        if (!ch) return json(res, { error: '认不出频道：' + q }, 404);
        ch.touch();
        for (let i = 0; i < 10 && !ch.playlist(origin, 0); i++) await new Promise((r) => setTimeout(r, 400));
        if (!ch.playlist(origin, 0)) return json(res, { error: '频道还没准备好，稍后再试' }, 503);
        const delay = Math.max(0, Math.min(600, Number(url.searchParams.get('delay') || 0) || 0));
        target = `${origin}/ysp/${slug}.m3u8?delay=${delay}`;
      } else {
        const rid = await bili.resolveRoomId(room);
        const pi = await bili.playInfo(rid, { qn: 10000 });
        target = pi.hls || pi.flv;
        if (!target) return json(res, { error: '取不到 B站流地址' }, 502);
      }
      execFile(exe, [target], (err) => { if (VERBOSE && err) console.error(err.message); });
      return json(res, { ok: true, target });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    if (VERBOSE) console.error('[err]', p, e);
    const code = Number(e && e.statusCode) || 500;
    return json(res, { error: e && e.message ? e.message : String(e) }, code);
  }
});

// ------------------------------------------------------------------ 播放器探测

function tryPaths(cands) {
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return '';
}
function findPotplayer() {
  return cfg.potplayerPath || tryPaths([
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'PotPlayer', 'PotPlayerMini64.exe') : '',
  ]);
}
function findVlc() {
  return cfg.vlcPath || tryPaths([
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
  ]);
}

// ------------------------------------------------------------------ 兜底与清理

// 最后一道防线：任何漏网的异常都不该让服务悄悄退出。
// （正常路径的错误都在路由的 try/catch 里处理了，这里只是保险。）
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e && e.stack ? e.stack.split('\n')[0] : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e && e.stack ? e.stack.split('\n')[0] : e);
});

// 清理长时间没人看的频道/房间，避免 Map 和缓冲无限增长。
// （BiliRoom 的轮询本身会在 IDLE_MS 后自停，这里负责把对象也扔掉。）
const JANITOR_MS = 60000;
const ROOM_TTL_MS = 30 * 60000;
setInterval(() => {
  const now = Date.now();
  for (const [k, ch] of yspChannels) {
    if (!ch.startedAt && now - ch.lastAccess > ROOM_TTL_MS) yspChannels.delete(k);
  }
  for (const [k, r] of biliRooms) {
    if (!r.timer && now - r.lastAccess > ROOM_TTL_MS) biliRooms.delete(k);
  }
  bili.pruneCaches?.();
}, JANITOR_MS).unref();

server.listen(PORT, HOST, () => {
  console.log('==========================================');
  console.log(' avsync 已启动');
  console.log('   页面:  http://' + HOST + ':' + PORT + '/');
  console.log('   频道:  ' + CHANNELS.length + ' 路央视频/卫视');
  console.log('   B站Cookie: ' + (cfg.biliCookie ? '已配置（可用高清晰度）' : '未配置（1080p 以内可用）'));
  console.log('   按 Ctrl+C 退出');
  console.log('==========================================');
});

process.on('SIGINT', () => { console.log('\n已退出'); process.exit(0); });
