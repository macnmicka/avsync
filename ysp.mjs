// avsync-ysp.mjs — 央视频 (JCE PidTimeShift + bkliveinfo cKey) 取流模块
// 协议移植自 funwukong/ysp-live (纯 Python 标准库实现)，改用 Node.js 重写。
// 仅标准库 (node:zlib 等)，无第三方依赖。

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { rawGet } from './http.mjs';

// ------------------------------------------------------------------ JCE 序列化

class W {
  constructor() { this.b = []; }
  _head(typ, tag) {
    if (tag < 15) this.b.push(((tag & 0xf) << 4) | (typ & 0xf));
    else { this.b.push(0xf0 | (typ & 0xf)); this.b.push(tag); }
  }
  int(v, tag) {
    v = Number(v) | 0;
    if (v === 0) return this._head(12, tag);
    if (v >= -128 && v <= 127) { this._head(0, tag); const t = Buffer.alloc(1); t.writeInt8(v); this.b.push(...t); return; }
    if (v >= -32768 && v <= 32767) { this._head(1, tag); const t = Buffer.alloc(2); t.writeInt16BE(v); this.b.push(...t); return; }
    this._head(2, tag); const t = Buffer.alloc(4); t.writeInt32BE(v); this.b.push(...t);
  }
  long(v, tag) {
    v = Number(v);
    if (v >= -2147483648 && v <= 2147483647) return this.int(v, tag);
    this._head(3, tag); const t = Buffer.alloc(8); t.writeBigInt64BE(BigInt(v)); this.b.push(...t);
  }
  float(v, tag) { this._head(4, tag); const t = Buffer.alloc(4); t.writeFloatBE(Number(v)); this.b.push(...t); }
  double(v, tag) { this._head(5, tag); const t = Buffer.alloc(8); t.writeDoubleBE(Number(v)); this.b.push(...t); }
  string(s, tag) {
    if (s === null || s === undefined) return;
    const data = Buffer.from(String(s), 'utf8');
    if (data.length > 255) { this._head(7, tag); const t = Buffer.alloc(4); t.writeInt32BE(data.length); this.b.push(...t); }
    else { this._head(6, tag); this.b.push(data.length); }
    this.b.push(...data);
  }
  bytes(data, tag) {
    const d = Buffer.from(data);
    this._head(13, tag); this._head(0, 0); this.int(d.length, 0); this.b.push(...d);
  }
  struct(fn, tag) { this._head(10, tag); fn(this); this._head(11, 0); }
  list(tag) { this._head(9, tag); this.int(0, 0); }
  out() { return Buffer.from(this.b); }
}

class R {
  constructor(data) { this.d = Buffer.from(data); this.p = 0; }
  rem() { return this.d.length - this.p; }
  get(n) { const b = this.d.subarray(this.p, this.p + n); if (b.length !== n) throw new Error('EOF'); this.p += n; return b; }
  u8() { return this.get(1)[0]; }
  head() {
    const b = this.u8(); let typ = b & 0xf; let tag = (b & 0xf0) >> 4;
    if (tag === 15) tag = this.u8();
    return [typ, tag];
  }
  value(typ) {
    switch (typ) {
      case 0: return this.get(1).readInt8();
      case 1: return this.get(2).readInt16BE();
      case 2: return this.get(4).readInt32BE();
      case 3: return Number(this.get(8).readBigInt64BE());
      case 4: return this.get(4).readFloatBE();
      case 5: return this.get(8).readDoubleBE();
      case 6: return this.get(this.u8()).toString('utf8');
      case 7: return this.get(this.get(4).readInt32BE()).toString('utf8');
      case 8: { const n = this._int(); const o = {}; for (let i = 0; i < n; i++) o[this._fv()] = this._fv(); return o; }
      case 9: { const n = this._int(); const a = []; for (let i = 0; i < n; i++) a.push(this._fv()); return a; }
      case 10: return this.struct();
      case 11: return null;
      case 12: return 0;
      case 13: { this.head(); const n = this._int(); return this.get(n); }
      default: throw new Error('JCE type ' + typ);
    }
  }
  _fv() { const [t] = this.head(); return this.value(t); }
  _int() { const [t] = this.head(); return Number(this.value(t)); }
  struct() {
    const m = {};
    while (this.rem() > 0) {
      const [t, tag] = this.head();
      if (t === 11) break;
      m[tag] = this.value(t);
    }
    return m;
  }
}

// ------------------------------------------------------------------ 分片缓冲
/**
 * 统一的分片环形缓冲。所有源（央视频 JCE / bkliveinfo / B站）都先把分片按顺序
 * 收进这里，再按"延迟 N 秒"切出一个窗口下发。
 *
 * 这样做的好处：延迟是**服务端**属性，改一次就稳定生效，播放器不用变速、
 * 不用循环纠偏，也就不会漂移（之前的播放速率方案会漂）。
 */
export class SegmentBuffer {
  constructor({ maxKeep = 80, maxSpanSec = 900, seqBase = 1 } = {}) {
    this.items = [];          // 升序：[{key,dur,pdt,url,t0}]
    this.keys = new Set();
    this.maxKeep = maxKeep;
    this.maxSpanSec = maxSpanSec;   // 按"时长"而不是"条数"淘汰，才不会被慢速源塞爆
    this.epoch = null;
    // 下发给播放器的 EXT-X-MEDIA-SEQUENCE 必须随时间**单调递增**。
    // 播放器靠它判断"清单是否前进"；如果它一直不变（JCE 分片本来没有序号，
    // 之前被 ?? 0 写死成 0），播放器可能认为清单没更新而不再取新分片 —— 表现就是
    // "放一会儿卡住，把延迟归零一下又好了"。这个计数器专治这个。
    this.seqNext = Number.isFinite(seqBase) ? seqBase : 1;
  }

  get size() { return this.items.length; }

  /** 缓冲里最新分片的"墙钟滞后"（秒），没有墙钟信息时返回 null */
  get newestAgeSec() {
    const last = this.newestPdt();
    if (!last) return null;
    const t = Date.parse(last);
    return Number.isFinite(t) ? Math.round((Date.now() - t) / 1000) : null;
  }

  newestPdt() {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].pdt) return this.items[i].pdt;
    return '';
  }

  /** 缓冲覆盖的时间长度（秒），用于告诉用户"延迟最多能开多大" */
  spanSec() {
    let s = 0;
    for (const it of this.items) s += it.dur || 0;
    return Math.round(s);
  }

  /** 追加一批分片（保持去重与升序）。epoch 变化视为流重启，清空重来。 */
  addAll(segs, epoch = null) {
    if (epoch !== null && this.epoch !== null && epoch !== this.epoch) {
      this.items = []; this.keys.clear();
    }
    if (epoch !== null) this.epoch = epoch;
    let added = 0;
    for (const s of segs) {
      const key = s.key || s.url;
      if (this.keys.has(key)) {
        const ex = this.items.find((i) => i.key === key);
        if (ex) {
          ex.url = s.url;                 // 地址会过期，刷新成最新签名
          ex.urlAt = Date.now();
          if (s.gen) ex.gen = s.gen;
        }
        continue;
      }
      this.keys.add(key);
      this.items.push({
        key, dur: s.dur || 6, pdt: s.pdt || '', url: s.url,
        seq: this.seqNext++,            // 单调递增，供 EXT-X-MEDIA-SEQUENCE 使用
        gen: s.gen || '', t0: Date.now(),
        // 地址"最后一次刷新"的时刻。B站分片地址是滚动过期的（实测最新片约 +36 秒
        // 就 404），所以下发时要按它判断地址还活着没有。
        urlAt: Date.now(),
      });
      added++;
    }
    // 按墙钟排序（有些源返回顺序不稳）
    this.items.sort((a, b) => {
      if (a.pdt && b.pdt) return Date.parse(a.pdt) - Date.parse(b.pdt);
      return 0;
    });
    while (this.items.length > 1 &&
           (this.items.length > this.maxKeep || this.spanSec() > this.maxSpanSec)) {
      const drop = this.items.shift();
      this.keys.delete(drop.key);
    }
    return added;
  }

  /** 去掉地址已经死掉的分片（B站分片地址滚动过期） */
  dropExpiredUrls(maxAgeMs) {
    const now = Date.now();
    const keep = [];
    const dropped = [];
    for (const it of this.items) {
      // urlAt 为 0/undefined 的（比如央视频时移分片）不会过期，直接保留
      if (!it.urlAt || now - it.urlAt <= maxAgeMs) keep.push(it);
      else { dropped.push(it); this.keys.delete(it.key); }
    }
    this.items = keep;
    return dropped.length;
  }

  /**
   * 按"延迟 delaySec 秒"取一个下发窗口。
   * delaySec = 0 表示给最新的；越大表示越"过去"。
   * playSegs 是窗口里保留多少片（约等于播放器的缓冲量）。
   *
   * 两个约束：不能越界；并且只要缓冲够长，就尽量给满 playSegs 片——
   * 只给 1 片的清单播放器几乎没有缓冲余量，很容易卡。
   */
  window(delaySec = 0, playSegs = 8) {
    const all = this.items;
    if (!all.length) return [];
    const want = Math.max(1, Math.floor(playSegs) || 1);
    // 允许的"最靠前"位置：至少还能凑出 want 片
    const minEnd = Math.min(all.length - 1, Math.max(0, want - 1));
    let end = all.length - 1;
    let acc = 0;
    while (end > minEnd && acc < delaySec) { acc += all[end].dur || 0; end--; }
    const start = Math.max(0, end - want + 1);
    return all.slice(start, end + 1);
  }

  /** 去掉时间轴上不连续的一段（末尾往前看，遇到跳变就截断） */
  static contiguous(segs) {
    if (segs.length < 2) return segs;
    const out = [segs[segs.length - 1]];
    for (let i = segs.length - 2; i >= 0; i--) {
      const cur = segs[i], nxt = out[out.length - 1];
      if (cur.pdt && nxt.pdt) {
        const gap = (Date.parse(nxt.pdt) - Date.parse(cur.pdt)) / 1000;
        if (!(gap > 0 && gap <= 20)) break;
      }
      out.push(cur);
    }
    return out.reverse();
  }
}

// ------------------------------------------------------------------ 常量

const VER_NAME = '3.2.7.26212';
const VER_CODE = '302070';
const APP_ID = '1200013';
const QMF_APP_ID = 10012;
const QMF_PLATFORM = 1;
const BIZ_ID = 0;
const CHAN_ID = '10070';
const GUID = crypto.randomBytes(16).toString('hex');

const UA_DEFAULT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const UA_QQLIVE = 'qqlive';

function qua(w) {
  w.string(VER_NAME, 0); w.string(VER_CODE, 1);
  w.int(1080, 2); w.int(2400, 3); w.int(3, 4); w.string('12', 5);
  w.int(1, 6); w.int(1, 7); w.int(420, 8); w.string(CHAN_ID, 9);
  for (let i = 10; i <= 14; i++) w.string('', i);
  w.struct((ww) => { ww.int(0, 0); ww.int(0, 1); ww.string('', 2); }, 15);
  w.string('', 16); w.string('', 17); w.string('', 18);
  w.struct((ww) => { ww.int(0, 0); ww.float(0, 1); ww.float(0, 2); ww.double(0, 3); }, 19);
  w.string(GUID.slice(0, 16), 20); w.string('Pixel 6', 21);
  w.int(1, 22);
  for (let i = 23; i <= 26; i++) w.int(0, i);
  w.string('', 27); w.string('', 28); w.string(GUID, 29);
}

function head(w, cmd, reqid) {
  w.int(reqid, 0); w.int(cmd, 1);
  w.struct((ww) => qua(ww), 2);
  w.string(APP_ID, 3); w.string(GUID, 4);
  w.list(5); w.struct(() => {}, 6);
  w.list(7);
  w.int(0, 8); w.int(0, 9); w.int(0, 10);
}

function wrap(cmd, body, reqid) {
  const w = new W();
  w.struct((ww) => head(ww, cmd, reqid), 0);
  w.bytes(body, 1);
  const reqcmd = w.out();
  const inner = Buffer.concat([
    Buffer.from([38]),
    (() => { const t = Buffer.alloc(4); t.writeInt32BE(reqcmd.length + 17); return t; })(),
    Buffer.from([1]), Buffer.alloc(10), reqcmd, Buffer.from([40]),
  ]);
  const comp = zlib.gzipSync(inner);
  const out = [];
  out.push(Buffer.from([19]));
  const i32 = (v) => { const t = Buffer.alloc(4); t.writeInt32BE(v); return t; };
  const u16 = (v) => { const t = Buffer.alloc(2); t.writeUInt16BE(v); return t; };
  const i64 = (v) => { const t = Buffer.alloc(8); t.writeBigInt64BE(BigInt(v)); return t; };
  out.push(i32(0), u16(2), u16(65281));
  out.push(u16(cmd), u16(0), i64(reqid));
  out.push(i32(531), i32(QMF_APP_ID), i64(BIZ_ID));
  const g = Buffer.from(GUID, 'utf8').subarray(0, 32);
  out.push(g, Buffer.alloc(32 - g.length));
  out.push(Buffer.from([QMF_PLATFORM]), i32(Number(VER_CODE)), Buffer.alloc(6));
  out.push(Buffer.from([0]), u16(0), u16(0));
  out.push(i32(inner.length), comp, Buffer.from([3]));
  const buf = Buffer.concat(out);
  buf.writeInt32BE(buf.length, 1);
  return buf;
}

function unwrap(data) {
  if (data[0] !== 0x13 || data.length < 90) return null;
  const flags = data.readInt32BE(21);
  let payload = data.subarray(89, data.length - 1);
  if (flags & 2) payload = zlib.gunzipSync(payload);
  if (payload[0] !== 0x26 || payload[payload.length - 1] !== 0x28) return null;
  return new R(payload.subarray(16, payload.length - 1)).struct()[1] || Buffer.alloc(0);
}

export class DeadHostError extends Error {}

// ------------------------------------------------------------------ HTTP helpers

// 注意: 央视部分 CDN 对 undici(fetch) 指纹返回 403，必须用原生 https(见 http.mjs)
async function httpGetText(url, opts) {
  const r = await rawGet(url, opts);
  return { text: r.body.toString('utf8'), url: r.url, status: r.status };
}

// ------------------------------------------------------------------ 央视频: JCE

/** 时移转直播：返回一个约 WINDOW 秒的 m3u8 地址 */
export async function jceTimeshiftUrl(pid, sid, start, end, stream = 'fhd') {
  const w = new W();
  w.string(pid, 0); w.string(sid, 1); w.long(start, 2); w.long(end, 3); w.string(stream, 4);
  const CMD = 25312;
  const reqid = (Date.now() & 0x7fffffff) >>> 0;
  const packet = wrap(CMD, w.out(), reqid);
  const res = await rawGet('https://jacc.ysp.cctv.cn', {
    method: 'POST', body: packet,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(packet.length) },
  });
  const raw = res.body;
  const body = unwrap(raw);
  if (!body) throw new Error('jce: bad response');
  const m = new R(body).struct();
  const err = m[0] || 0;
  if (err !== 0) throw new Error('jce: ' + (m[1] || ('errCode=' + err)));
  const url = m[2] || '';
  if (!url) throw new Error('jce: empty m3u8');
  if (url.includes('liverecord.video.cloud.cctv.com')) throw new DeadHostError('jce: dead cdn host');
  return url;
}

// ------------------------------------------------------------------ 央视频: bkliveinfo + cKey

const CK_PLATFORM = 4330403;
const CK_APPVER = 'V8.22.1035.3031';
const CK_TEA = Buffer.from('59b2f7cf725ef43c34fdd7c123411ed3', 'hex');
const CK_GTEA = Buffer.from('110DBEC10C23E7D2E56A1CAD6914EF1B', 'hex');
const CK_XOR = Buffer.from([0x84, 0x2e, 0xed, 0x08, 0xf0, 0x66, 0xe6, 0xea, 0x48, 0xb4, 0xca, 0xa9, 0x91, 0xed, 0x6f, 0xf3]);
const CK_GXOR = Buffer.from([0xb3, 0xc9, 0x53, 0xa0, 0x69, 0x13, 0xad, 0x4d]);

const u32 = (v) => v >>> 0;

function teaBlk(blk, key) {
  let y = blk.readUInt32BE(0), z = blk.readUInt32BE(4);
  const k = [key.readUInt32BE(0), key.readUInt32BE(4), key.readUInt32BE(8), key.readUInt32BE(12)];
  let s = 0;
  for (let i = 0; i < 16; i++) {
    s = u32(s + 0x9e3779b9);
    y = u32(y + u32(u32(u32(z << 4) + k[0]) ^ u32(z + s) ^ u32((z >>> 5) + k[1])));
    z = u32(z + u32(u32(u32(y << 4) + k[2]) ^ u32(y + s) ^ u32((y >>> 5) + k[3])));
  }
  const o = Buffer.alloc(8); o.writeUInt32BE(y, 0); o.writeUInt32BE(z, 4); return o;
}

function cksum(buf) {
  let v = 0;
  for (const b of buf) v = (0x83 * v + b) & 0x7fffffff;
  return v;
}

function teaPkt(data, key) {
  const pad = (8 - ((data.length + 10) % 8)) % 8;
  const plain = Buffer.concat([
    Buffer.from([(crypto.randomBytes(1)[0] & 0xf8) | pad]),
    crypto.randomBytes(pad), crypto.randomBytes(2), data, Buffer.alloc(7),
  ]);
  const chunks = [];
  let pp = Buffer.alloc(8), pc = Buffer.alloc(8);
  for (let off = 0; off < plain.length; off += 8) {
    const src = plain.subarray(off, off + 8);
    const mixed = Buffer.from(src.map((a, i) => a ^ pc[i]));
    const enc = teaBlk(mixed, key);
    const cipher = Buffer.from(enc.map((a, i) => a ^ pp[i]));
    chunks.push(cipher);
    pp = mixed; pc = cipher;
  }
  return Buffer.concat(chunks);
}

const lp = (s) => {
  const d = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
  const t = Buffer.alloc(2); t.writeUInt16BE(d.length); return Buffer.concat([t, d]);
};

function ckGuard(ts, guid) {
  const tail = (v) => { const t = String(v); return t.length >= 5 ? t.slice(-5) : ''; };
  const i32 = (v) => { const t = Buffer.alloc(4); t.writeUInt32BE(u32(v)); return t; };
  const body = Buffer.concat([i32(ts), lp(tail(guid)), lp(tail('null')), lp(tail('null')), lp('-1')]);
  const plain = lp(body);
  let enc = Buffer.concat([teaPkt(plain, CK_GTEA), i32(cksum(plain))]);
  enc = Buffer.from(enc.map((a, i) => a ^ CK_GXOR[i & 7]));
  return enc.toString('hex').toUpperCase();
}

function ckey(channelId) {
  const ts = Math.floor(Date.now() / 1000);
  const guid = crypto.randomBytes(16).toString('hex');
  const guard = ckGuard(ts, guid);
  const uid = crypto.randomBytes(4).toString('hex').toUpperCase();
  const i32 = (v) => { const t = Buffer.alloc(4); t.writeUInt32BE(u32(v)); return t; };
  const body = Buffer.concat([
    Buffer.from('0000004200000004000004d2', 'hex'),
    i32(CK_PLATFORM), i32(0), i32(ts),
    lp('dcgh'), lp('_zj1A5Gh6QYcxWjIUGos2w=='), lp(CK_APPVER), lp(String(channelId)),
    lp(guid), i32(1), i32(1), lp(uid), lp('nil'),
    lp('57eab0c4-2c58-44c6-8ae9-dd2757525dc5'), lp('nil'), lp('v0.1.000'),
    lp('com.cctv.yangshipin.app.iphone'), lp(String(CK_PLATFORM)),
    lp('ex_json_bus'), lp('ex_json_vs'), lp(guard),
  ]);
  const hdr = Buffer.alloc(2); hdr.writeUInt16BE(body.length);
  const pkt = Buffer.concat([hdr, body]);
  pkt.writeUInt32BE(cksum(pkt), 18);
  let enc = Buffer.concat([teaPkt(pkt, CK_TEA), i32(cksum(pkt))]);
  enc = Buffer.from(enc.map((a, i) => a ^ CK_XOR[i & 15]));
  const b64 = enc.toString('base64').replace(/\+/g, '_').replace(/\//g, '-').replace(/=+$/, '');
  return { cKey: '--01' + b64, guid, ts, flowId: crypto.randomUUID().replace(/-/g, '').toUpperCase() + '_' + CK_PLATFORM };
}

const BK_H264 = Buffer.from('H(30:1080,60:1080|30:1080,60:1080)').toString('base64');

export async function bkPlayurls(channelId, livePid, defn = 'fhd') {
  const t = ckey(channelId);
  const q = new URLSearchParams({
    atime: '120', livepid: livePid, cnlid: channelId,
    appVer: CK_APPVER, app_version: '300090', caplv: '1', cmd: '2',
    defn, device: 'iPhone', encryptVer: '4.2', getpreviewinfo: '0',
    hevclv: '0', lang: 'zh-Hans_CN', livequeue: '0', logintype: '1',
    nettype: '1', newnettype: '1', newplatform: String(CK_PLATFORM),
    platform: String(CK_PLATFORM), sdtfrom: 'v3021', spacode: '23',
    spaudio: '1', spdemuxer: '6', spdrm: '2', spdynamicrange: '1',
    spflv: '1', spflvaudio: '1', sphdrfps: '60', sphttps: '1',
    spvcode: BK_H264, spvideo: '4', stream: '1', system: '1',
    sysver: 'ios18.2.1', uhd_flag: '0', cKey: t.cKey, guid: t.guid,
    fntick: String(t.ts), flowid: t.flowId, playbacktime: '0',
  });
  const res = await rawGet('https://bkliveinfo.ysp.cctv.cn/?' + q, {
    headers: { 'User-Agent': 'qqlive', Accept: 'application/json' },
  });
  const p = JSON.parse(res.body.toString('utf8'));
  if (Number(p.iretcode) !== 0) throw new Error('bk: iretcode=' + p.iretcode + ' ' + (p.errinfo || ''));
  let urls = [];
  if (p.playurl) urls.push(p.playurl);
  const bu = p.backurl_list || p.backurlList || p.backurl;
  if (Array.isArray(bu)) urls.push(...bu.map((it) => (typeof it === 'string' ? it : (it.url || it.playurl || ''))));
  else if (typeof bu === 'string') urls.push(...bu.split(/[;,]/).filter((s) => s.trim()));
  urls = [...new Set(urls)].filter((u) => u && u.includes('.cctv.'));
  if (!urls.length) throw new Error('bk: no playurl');
  // 注意: 名字里带 bklive- 的 CDN 实测对分片返回 403，别名 CDN(hlsliveali/bkhlsliveali) 才可用，
  // 所以这里不按名字排序，改为逐个探测(见 probeBkUrl)，谁真能拉到分片就用谁。
  return urls;
}

// ------------------------------------------------------------------ 频道表

// slug, 名称, sid(=cnlid), pid(=livepid), 清晰度
export const CHANNELS = [
  ['cctv1', 'CCTV-1 综合', '2024078201', '600001859', 'fhd'],
  ['cctv2', 'CCTV-2 财经', '2024075401', '600001800', 'fhd'],
  ['cctv3', 'CCTV-3 综艺', '2024068501', '600001801', 'fhd'],
  ['cctv4', 'CCTV-4 中文国际', '2029797101', '600001814', 'fhd'],
  ['cctv5', 'CCTV-5 体育', '2024078401', '600001818', 'fhd'],
  ['cctv5p', 'CCTV-5+ 体育赛事', '2024078001', '600001817', 'fhd'],
  ['cctv6', 'CCTV-6 电影', '2013693901', '600108442', 'fhd'],
  ['cctv7', 'CCTV-7 国防军事', '2024072001', '600004092', 'fhd'],
  ['cctv8', 'CCTV-8 电视剧', '2029793001', '600001803', 'fhd'],
  ['cctv9', 'CCTV-9 纪录', '2024078601', '600004078', 'fhd'],
  ['cctv10', 'CCTV-10 科教', '2024078701', '600001805', 'fhd'],
  ['cctv11', 'CCTV-11 戏曲', '2027248701', '600001806', 'fhd'],
  ['cctv12', 'CCTV-12 社会与法', '2027248801', '600001807', 'fhd'],
  ['cctv13', 'CCTV-13 新闻', '2029797201', '600001811', 'fhd'],
  ['cctv14', 'CCTV-14 少儿', '2027248901', '600001809', 'fhd'],
  ['cctv15', 'CCTV-15 音乐', '2027249001', '600001815', 'fhd'],
  ['cctv16', 'CCTV-16 奥林匹克', '2027249101', '600098637', 'fhd'],
  ['cctv164k', 'CCTV-16 4K', '2027249301', '600099502', 'fhd'],
  ['cctv17', 'CCTV-17 农业农村', '2027249401', '600001810', 'fhd'],
  ['cctv4k', 'CCTV-4K 超高清', '2029810301', '600002264', 'fhd'],
  ['cctv8k', 'CCTV-8K 超高清', '2026774101', '600156816', 'fhd'],
  ['cgtn', 'CGTN', '2024181701', '600014550', 'fhd'],
  ['cgtnfr', 'CGTN 法语', '2024181801', '600084704', 'fhd'],
  ['cgtnru', 'CGTN 俄语', '2024181901', '600084758', 'fhd'],
  ['cgtnar', 'CGTN 阿拉伯语', '2024182001', '600084782', 'fhd'],
  ['cgtnes', 'CGTN 西班牙语', '2024182101', '600084744', 'fhd'],
  ['cgtndoc', 'CGTN 纪录', '2024182301', '600084781', 'fhd'],
  ['cctvfyjc', 'CCTV 风云剧场', '2025637103', '600099658', 'shd'],
  ['cctvdyjc', 'CCTV 第一剧场', '2026874203', '600099655', 'shd'],
  ['cctvhjjc', 'CCTV 怀旧剧场', '2026874303', '600099620', 'shd'],
  ['bjws', '北京卫视', '2024052703', '600002309', 'fhd'],
  ['jsws', '江苏卫视', '2024171103', '600002521', 'fhd'],
  ['dfws', '东方卫视', '2024054503', '600002483', 'fhd'],
  ['zjws', '浙江卫视', '2024054703', '600002520', 'fhd'],
  ['hnws', '湖南卫视', '2024054803', '600002475', 'fhd'],
  ['hbws', '湖北卫视', '2024171203', '600002508', 'fhd'],
  ['gdws', '广东卫视', '2024060903', '600002485', 'fhd'],
  ['gxws', '广西卫视', '2024060703', '600002509', 'fhd'],
  ['hljws', '黑龙江卫视', '2029797003', '600002498', 'fhd'],
  ['hainanws', '海南卫视', '2024055603', '600002506', 'fhd'],
  ['cqws', '重庆卫视', '2024061103', '600002531', 'fhd'],
  ['szws', '深圳卫视', '2024061303', '600002480', 'shd'],
  ['scws', '四川卫视', '2024061403', '600002516', 'fhd'],
  ['henanws', '河南卫视', '2029797303', '600002525', 'fhd'],
  ['dnws', '东南卫视', '2024061503', '600002484', 'fhd'],
  ['gzws', '贵州卫视', '2024061603', '600002490', 'fhd'],
  ['jxws', '江西卫视', '2024061703', '600002503', 'fhd'],
  ['lnws', '辽宁卫视', '2024171303', '600002505', 'fhd'],
  ['ahws', '安徽卫视', '2024171403', '600002532', 'fhd'],
  ['hebws', '河北卫视', '2024171503', '600002493', 'fhd'],
  ['sdws', '山东卫视', '2029787903', '600002513', 'fhd'],
  ['tjws', '天津卫视', '2019927003', '600152137', 'fhd'],
  ['jlws', '吉林卫视', '2025561503', '600190405', 'fhd'],
  ['saxws', '陕西卫视', '2029795103', '600190400', 'fhd'],
  ['nxws', '宁夏卫视', '2025608503', '600190737', 'fhd'],
  ['nmgws', '内蒙古卫视', '2025561203', '600190401', 'fhd'],
  ['ynws', '云南卫视', '2025561303', '600190402', 'fhd'],
  ['shanxiws', '山西卫视', '2025560803', '600190407', 'fhd'],
  ['qhws', '青海卫视', '2025559103', '600190406', 'fhd'],
  ['xizangws', '西藏卫视', '2025558003', '600190403', 'fhd'],
  ['xjws', '新疆卫视', '2019927403', '600152138', 'fhd'],
  ['cetv1', 'CETV-1', '2022823801', '600171827', 'fhd'],
  ['guoxue', '国学频道', '2029360403', '600213139', 'fhd'],
];

export const CHANNEL_MAP = new Map(CHANNELS.map((c) => [c[0], { slug: c[0], name: c[1], sid: c[2], pid: c[3], defn: c[4] }]));

// 客户端时钟修正：播放器用它自己的 UTC 时钟来决定"最新直播"的位置，
// 如果客户端时钟和服务器差了几十秒，画面就会跟着差几十秒。这里允许前端上报偏差，
// 由服务端在请求央视时移接口时补上，两个源都会被修正。
let _skewMs = 0;
export function setClockSkew(ms) {
  const v = Number(ms);
  if (Number.isFinite(v) && Math.abs(v) < 3600_000) _skewMs = v;
  return _skewMs;
}
export function clockSkew() { return _skewMs; }

// 央视官网 tv.cctv.com/live/<id> 与央视频 yangshipin.cn 的频道标识 -> 本工具 slug
export const CCTV_PATH_MAP = {
  cctv1: 'cctv1', cctv2: 'cctv2', cctv3: 'cctv3', cctv4: 'cctv4', cctv5: 'cctv5',
  cctv5plus: 'cctv5p', cctv5p: 'cctv5p', cctv6: 'cctv6', cctv7: 'cctv7', cctv8: 'cctv8',
  cctv9: 'cctv9', cctv10: 'cctv10', cctv11: 'cctv11', cctv12: 'cctv12', cctv13: 'cctv13',
  cctv14: 'cctv14', cctv15: 'cctv15', cctv16: 'cctv16', cctv164k: 'cctv164k',
  cctv17: 'cctv17', cctv4k: 'cctv4k', cctv8k: 'cctv8k',
  cgtn: 'cgtn', cgtnfr: 'cgtnfr', cgtnru: 'cgtnru', cgtnar: 'cgtnar', cgtnes: 'cgtnes',
  cgtndoc: 'cgtndoc', cctvfyjc: 'cctvfyjc', cctvdyjc: 'cctvdyjc', cctvhjjc: 'cctvhjjc',
  bjws: 'bjws', jsws: 'jsws', dfws: 'dfws', zjws: 'zjws', hnws: 'hnws', hbws: 'hbws',
  gdws: 'gdws', gxws: 'gxws', hljws: 'hljws', hainanws: 'hainanws', cqws: 'cqws',
  szws: 'szws', scws: 'scws', henanws: 'henanws', dnws: 'dnws', gzws: 'gzws', jxws: 'jxws',
  lnws: 'lnws', ahws: 'ahws', hebws: 'hebws', sdws: 'sdws', tjws: 'tjws', jlws: 'jlws',
  saxws: 'saxws', nxws: 'nxws', nmgws: 'nmgws', ynws: 'ynws', shanxiws: 'shanxiws',
  qhws: 'qhws', xizangws: 'xizangws', xjws: 'xjws', cetv1: 'cetv1', guoxue: 'guoxue',
};

/**
 * 把用户输入变成频道 slug。支持：
 *  - slug:            cctv5p / bjws
 *  - 频道名:          "CCTV-5+ 体育赛事" / "CCTV5+" / "cctv5plus"
 *  - 央视直播页链接:  https://tv.cctv.com/live/cctv5plus/
 *  - 央视频链接:      https://www.yangshipin.cn/tv/home?pid=600001817
 */
export function resolveChannelSlug(input) {
  if (!input) return null;
  const raw = String(input).trim();
  // 0) 常见别名
  const norm = raw.toLowerCase().replace(/[\s·（）()【】]+/g, '');
  if (/^(cctv)?5(plus|\+)$/.test(norm)) return 'cctv5p';
  if (/^(cctv)?16(4k)$/.test(norm)) return 'cctv164k';
  if (/^(cctv)?4k$/.test(norm)) return 'cctv4k';
  if (/^(cctv)?8k$/.test(norm)) return 'cctv8k';
  // 1) 链接
  const m = raw.match(/(?:tv\.cctv\.com\/live\/|yangshipin\.cn[^\s]*?)([a-z0-9_+-]+)/i);
  if (m && CCTV_PATH_MAP[m[1].toLowerCase()]) return CCTV_PATH_MAP[m[1].toLowerCase()];
  const pid = raw.match(/[?&]pid=(\d+)/);
  if (pid) {
    for (const c of CHANNELS) if (c[3] === pid[1]) return c[0];
  }
  // 2) slug / 去掉分隔符的频道名
  const k = raw.toLowerCase().replace(/[\s·（）()【】]+/g, '').replace(/plus/g, '+');
  const k2 = k.replace(/[-_+]/g, '');
  // 先按"央视官网写法"匹配，避免 cctv5+ 被吃成 cctv5
  if (CCTV_PATH_MAP[k2]) return CCTV_PATH_MAP[k2];
  if (CCTV_PATH_MAP[k]) return CCTV_PATH_MAP[k];
  if (CHANNEL_MAP.has(k2)) return k2;
  for (const c of CHANNELS) {
    const nameKey = c[1].toLowerCase().replace(/[\s·（）()【】]+/g, '');
    if (nameKey === k) return c[0];
    if (nameKey === k2) return c[0];
    if (nameKey.includes(k) && k.length >= 3) return c[0];
  }
  return null;
}

// JCE 对这些频道返回坏 CDN 域名，直接走 bkliveinfo
export const FORCE_BK = new Set(['cctv11', 'cctv12', 'cctv14', 'cctv15', 'cctv16', 'cctv164k', 'cctv17', 'cctv4k', 'cctvfyjc', 'cctvdyjc', 'cctvhjjc']);

// ------------------------------------------------------------------ 频道状态机

const WINDOW = 300;        // 每次 JCE 时移请求回看多少秒
const PLAY_SEGS = 8;       // 下发给播放器的窗口分片数（约等于播放器缓冲）
const MAX_KEEP_JCE = 90;   // JCE 内部缓存上限（约 540 秒）
const MAX_KEEP_BK = 300;   // bkliveinfo 分片 5 秒，多留一些历史给"延迟"用
const STALE_SEC = 20;      // 最新分片超过这么久没到就算旧窗口，多试几次
const REFRESH_MS = 4000;   // 后台刷新间隔（越小越贴近实时）
const IDLE_MS = 90000;     // 无访问后停止刷新
const BK_TTL_MS = 600000;  // bkliveinfo 地址缓存

const HDRS_CCTV = { 'User-Agent': UA_QQLIVE, Referer: 'https://live.cctv.cn/', Accept: 'application/vnd.apple.mpegurl,application/json,*/*' };

export class YspChannel {
  constructor(ch) {
    Object.assign(this, ch);
    this.mode = FORCE_BK.has(ch.slug) ? 'bk' : 'jce';
    // bk 分片 5 秒、JCE 分片 6~7 秒，缓存上限按模式给
    this.buffer = new SegmentBuffer({ maxKeep: this.mode === 'bk' ? MAX_KEEP_BK : MAX_KEEP_JCE, seqBase: 1 });
    this.bkUrls = [];
    this.bkUrlsTime = 0;
    this.bkUrl = '';             // 已探测可用(能真正拉到分片)的 CDN 地址
    this.bkPlaylist = null;      // {text, baseUrl}
    this.lastError = '';
    this.lastEdgeAge = null;
    this.lastAccess = 0;
    this.timer = null;
    this.refreshing = false;
    this.startedAt = null;
    this.stats = { refreshes: 0, errors: 0, added: 0 };
  }

  touch() {
    this.lastAccess = Date.now();
    // 关键：绝不能在这里重排刷新定时器——播放器每几秒就来取一次清单，
    // 重排会让后台刷新永远轮不到（踩过的坑）。
    if (!this.startedAt) this.start();
  }

  start() {
    this.startedAt = Date.now();
    this.lastAccess = Date.now();
    this.refreshOnce().catch(() => {});
    this.arm();
  }

  arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), REFRESH_MS);
  }

  async tick() {
    this.timer = null;
    if (!this.startedAt) return;
    if (Date.now() - this.lastAccess > IDLE_MS) {
      this.startedAt = null;
      return;
    }
    await this.refreshOnce().catch(() => {});
    if (this.startedAt) this.arm();
  }

  async refreshOnce() {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      if (this.mode === 'bk') await this.refreshBk();
      else {
        try { await this.refreshJce(); }
        catch (e) {
          if (e instanceof DeadHostError) { this.mode = 'bk'; await this.refreshBk(); }
          else throw e;
        }
      }
      this.lastError = '';
      this.stats.refreshes++;
      return true;
    } catch (e) {
      this.stats.errors++;
      this.lastError = (e && e.message ? e.message : String(e)).slice(0, 160);
      return false;
    } finally { this.refreshing = false; }
  }

  async refreshJce() {
    // 央视 CDN 的不同边缘节点缓存新旧不一，同一时刻可能返回几分钟前的窗口。
    // 所以多试几次，取"最新分片墙钟最靠前"的那次结果；实在都旧也用最好的那个。
    const attempts = 3;
    let best = null, bestAge = Infinity;
    for (let i = 0; i < attempts; i++) {
      const now = Math.floor((Date.now() + _skewMs) / 1000);
      const url = await jceTimeshiftUrl(this.pid, this.sid, now - WINDOW, now, this.defn);
      const { text } = await httpGetText(url, { headers: { 'User-Agent': UA_DEFAULT } });
      const segs = parseSegments(text, url);
      if (!segs.length) continue;
      const lastPdt = [...segs].reverse().find((s) => s.pdt);
      const age = lastPdt ? (Date.now() - Date.parse(lastPdt.pdt)) / 1000 : Infinity;
      if (age < bestAge) { bestAge = age; best = segs; }
      if (age < STALE_SEC) break;      // 够新就不用再试
    }
    if (!best) throw new Error('jce: empty playlist');
    this.lastEdgeAge = Math.round(bestAge);
    const added = this.buffer.addAll(best.map((s) => ({
      key: s.pdt ? 'pdt:' + s.pdt : s.url.split('?')[0],
      dur: s.dur, pdt: s.pdt, url: s.url,
    })));
    if (added) this.stats.added += added;
  }

  async refreshBk() {
    const now = Date.now();
    if (!this.bkUrl || now - this.bkUrlsTime > BK_TTL_MS) {
      this.bkUrl = await probeBkUrl(this.sid, this.pid, this.defn);
      this.bkUrlsTime = now;
    }
    let text, url, seq0;
    try {
      const r = await httpGetText(this.bkUrl, { headers: HDRS_CCTV });
      text = r.text; url = r.url;
      if (!text.includes('#EXTM3U')) throw new Error('bk: 清单内容异常');
    } catch (e) {
      // 地址可能过期/被限流，重新探测一次
      this.bkUrl = await probeBkUrl(this.sid, this.pid, this.defn);
      this.bkUrlsTime = Date.now();
      const r = await httpGetText(this.bkUrl, { headers: HDRS_CCTV });
      text = r.text; url = r.url;
      if (!text.includes('#EXTM3U')) throw new Error('bk: 清单内容异常');
    }
    seq0 = mediaSequence(text);
    this.bkPlaylist = { text, baseUrl: url };
    const segs = parseSegments(text, url, seq0);
    // 媒体序号整体回退很多 -> 视为流重启，清空缓冲
    const epoch = (this.buffer.epoch === null || seq0 === null) ? null
      : (seq0 + 50 < this.buffer.epoch ? seq0 : this.buffer.epoch);
    const added = this.buffer.addAll(segs.map((s, i) => ({
      key: 'bk:' + (s.seq !== null ? s.seq : url + '#' + i),
      dur: s.dur, pdt: s.pdt, url: s.url,
    })), epoch);
    if (added) this.stats.added += added;
  }

  /** 观测信息：缓冲里最新分片的墙钟滞后、可用的最大延迟 */
  snapshot() {
    const buf = this.buffer;
    return {
      mode: this.mode, error: this.lastError,
      buffered: buf.size,
      newestAgeSec: buf.newestAgeSec,
      bufferSpanSec: buf.spanSec(),
      maxDelaySec: this.maxDelay(),
      lastPdt: buf.newestPdt(),
      refreshes: this.stats.refreshes, errCount: this.stats.errors, added: this.stats.added,
      alive: !!this.startedAt, hasTimer: !!this.timer, refreshing: this.refreshing,
      lastAccessAgo: Math.round((Date.now() - this.lastAccess) / 1000),
    };
  }

  /** 本频道当前能提供的最大延迟（秒）：留出播放窗口后剩下的缓冲 */
  maxDelay() {
    const span = this.buffer.spanSec();
    return Math.max(0, span - PLAY_SEGS * 6);
  }

  /**
   * 生成给播放器的 m3u8（分片地址指向本代理）。
   * @param delaySec 画面相对"最新的分片"再往后推多少秒（0 = 最新）
   */
  playlist(origin, delaySec = 0) {
    const win = this.buffer.window(delaySec, PLAY_SEGS);
    let segs = SegmentBuffer.contiguous(win);
    if (!segs.length) return null;
    const target = Math.max(2, Math.max(...segs.map((s) => Math.round(s.dur))));
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + target,
      '#EXT-X-MEDIA-SEQUENCE:' + (segs[0].seq ?? 0), '#EXT-X-INDEPENDENT-SEGMENTS'];    for (const s of segs) {
      if (s.pdt) out.push('#EXT-X-PROGRAM-DATE-TIME:' + s.pdt);
      else if (s.t0) out.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(s.t0).toISOString());
      out.push('#EXTINF:' + (s.dur || 6).toFixed(3) + ',');
      out.push(proxyUrl(s.url, origin));
    }
    return out.join('\n') + '\n';
  }
}

/** 从末尾往前保留时间戳连续的一段（防止不同 CDN 缓存拼出跳跃的时间轴） */
function mediaSequence(text) {
  const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * 解析 m3u8 分片。
 * @param seq0 如果给了媒体序号，则每个分片带上递增的 seq（B站/央视备用协议用）
 */
function parseSegments(text, baseUrl, seq0 = null) {
  const out = [];
  let dur = 6.0, pdt = '', idx = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const v = parseFloat(line.slice(8).split(',')[0]);
      dur = Number.isFinite(v) ? v : 6.0;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pdt = line.slice(25).trim();
    } else if (!line.startsWith('#')) {
      out.push({
        dur, pdt, url: new URL(line, baseUrl).toString(),
        seq: seq0 === null ? null : seq0 + idx,
      });
      idx++; pdt = '';
    }
  }
  return out;
}

export function proxyUrl(u, origin) {
  return origin + '/seg/' + encodeURIComponent(Buffer.from(u, 'utf8').toString('base64url'));
}

export { HDRS_CCTV, UA_QQLIVE };

/**
 * 探测 bkliveinfo 返回的多个 CDN 地址，返回第一个"清单能读、分片也能真拉到"的地址。
 * 实测部分 CDN(名字含 bklive- 的)对分片直接 403，必须实际试拉一次才能确定。
 */
export async function probeBkUrl(sid, pid, defn) {
  const urls = await bkPlayurls(sid, pid, defn);
  const errs = [];
  for (const u of urls) {
    try {
      const { text, url } = await httpGetText(u, { headers: HDRS_CCTV });
      if (!text.includes('#EXTM3U')) { errs.push('no m3u8'); continue; }
      // 解出第一个已解析地址；若它仍是清单(变体流)，继续往里走
      let base = url, txt = text;
      for (let depth = 0; depth < 3; depth++) {
        const first = parseSegments(txt, base)[0];
        if (!first) { errs.push('empty'); break; }
        if (first.url.includes('.m3u8')) {
          const r = await httpGetText(first.url, { headers: HDRS_CCTV });
          base = r.url; txt = r.text;
          continue;
        }
        const seg = await rawGet(first.url, { headers: HDRS_CCTV });
        if (seg.status !== 200) { errs.push('seg ' + seg.status); break; }
        if (!seg.body.length) { errs.push('seg empty'); break; }
        return u;
      }
    } catch (e) { errs.push(e.message || String(e)); }
  }
  throw new Error('bk: 所有 CDN 地址均不可用 (' + errs.slice(0, 3).join('; ') + ')');
}

export async function fetchSeg(url) {
  // 只允许代理这几家官方 CDN 的地址：本服务虽然是绑定 127.0.0.1 的，
  // 但也不该被当成任意 URL 的转发器（SSRF 面）。分片地址由我们自己的清单生成，
  // 所以白名单不会影响正常播放。
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error('bad seg url'); }
  if (!SEG_HOST_ALLOW.some((s) => host === s || host.endsWith('.' + s))) {
    const err = new Error('seg host not allowed: ' + host);
    err.statusCode = 403;
    throw err;
  }
  const isCctv = /ysp\.cctv\.cn|cctv\.com|cctv\.cn/.test(url);
  const headers = isCctv ? { 'User-Agent': UA_QQLIVE, Referer: 'https://live.cctv.cn/' }
                         : { 'User-Agent': UA_DEFAULT, Referer: 'https://live.bilibili.com/' };
  const r = await rawGet(url, { headers, timeout: 30000 });
  if (r.status !== 200 || !r.body.length) throw new Error('seg http ' + r.status);
  return r;
}

// 允许代理的分片来源
const SEG_HOST_ALLOW = [
  'ysp.cctv.cn', 'cctv.cn', 'cctv.com',
  'bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'hdslb.com',
];
