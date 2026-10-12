// http.mjs — 用 Node 原生 http/https 发起请求。
// 背景: 央视部分 CDN 会对 undici(fetch) 的请求指纹返回 403，换成原生 https + 常规请求头即 200。
// 所有"取媒体/清单"的请求都走这里。

import http from 'node:http';
import https from 'node:https';

const DEFAULT_HEADERS = {
  'User-Agent': 'qqlive',
  Referer: 'https://live.cctv.cn/',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
  Connection: 'close',
};

/**
 * 发起一次 HTTP(S) 请求。
 * @returns {Promise<{status:number, headers:object, body:Buffer, url:string}>}
 */
export function rawRequest(url, { headers = {}, timeout = 25000, maxBytes = 0, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, { method, headers: { ...DEFAULT_HEADERS, ...headers } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        chunks.push(c); size += c.length;
        if (maxBytes && size >= maxBytes) { req.destroy(); }
      });
      let settled = false;
      const done = () => {
        if (settled) return; settled = true;
        resolve({
          status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks), url: (res.url && /^https?:/.test(res.url)) ? res.url : url,
        });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    });
    req.on('error', (e) => {
      // maxBytes 主动断开时 body 已经拿到，交给上层处理
      if (e && e.code === 'ERR_STREAM_PREMATURE_CLOSE') return resolve({ status: 200, headers: {}, body: Buffer.alloc(0), url });
      reject(e);
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout ' + url.slice(0, 80))); });
    if (body) req.write(body);
    req.end();
  });
}

export function rawGet(url, opts = {}) { return rawRequest(url, opts); }

export async function getText(url, opts = {}) {
  const r = await rawGet(url, opts);
  return { text: r.body.toString('utf8'), status: r.status, url: r.url, headers: r.headers };
}

export async function getJson(url, opts = {}) {
  const r = await rawGet(url, { ...opts, headers: { ...(opts.headers || {}) } });
  return { data: JSON.parse(r.body.toString('utf8')), status: r.status, url: r.url };
}

export const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
