# AGENTS.md — 给 AI 协作者的项目说明

> 这份文档是写给**接手这个项目的 AI（Codex / 其他 agent）**的，不是写给最终用户的。
> 用户看的说明在 [README.md](README.md)。先读这里，再动代码。
> 最后更新：2026-10-12

---

## 1. 这是什么

`avsync` 是一个**本机运行的小工具**，解决一个很具体的需求：

> 用户想**用央视频看画面、用 B站听声音**（比如央视有画面、B站有解说），
> 但两条直播流的时间轴差几十秒，需要把它们对齐。

做法三件事：**取流 → 同源代理 → 按延迟切分片窗口下发**。
所有流量都只经过 `127.0.0.1`，不经过任何第三方服务器。

技术栈：**纯 Node.js 标准库，零第三方依赖**（`package.json` 都没有）。
前端是原生 JS + 本地内置的 **hls.js 1.5.17**（`public/vendor/hls.min.js`，离线可用）。

运行环境已实测：**Windows + Node v22.23.2 + Edge**。

```
E:\clone\deepseek-harness\avsync\
├─ 启动.cmd                 双击启动（纯 ASCII 引导 → 交给 start.ps1）
├─ start.ps1                启动实现（UTF-8 带 BOM，中文提示都在这里）
├─ 停止.cmd                 双击停止（同上，交给 stop.ps1）
├─ stop.ps1                 停止实现
├─ server.mjs               HTTP 服务：路由 + 同源代理 + 延迟窗口
├─ ysp.mjs                  央视频取流（JCE 时移 / bkliveinfo+cKey）+ 分片缓冲
├─ bili.mjs                 B站取流（房间号→playurl）+ 房间轮询缓冲
├─ http.mjs                 原生 http/https 请求（很重要，见 §3.2）
├─ AGENTS.md                本文件（给 AI）
├─ README.md                给用户的说明
├─ config.example.json      可选配置（B站 Cookie / 播放器路径）
├─ docs/screenshot.png
├─ run.log / run.err        运行时日志（start.ps1 写出，已在 .gitignore）
└─ public/                  前端（index.html / app.js / style.css / vendor/hls.min.js）
```

**入口只有 4 个文件，不要再加中间层。** 曾经是
`启动.cmd → start.cmd → start.ps1` 三层，其中 `start.cmd` / `stop.cmd` 纯属多余，
已于 2026-10-12 删除。分工固定：

- `启动.cmd` / `停止.cmd`：**唯一入口**，纯 ASCII + CRLF，只做引导（切代码页、切目录、查 node、转交）
- `start.ps1` / `stop.ps1`：**唯一实现**，UTF-8 带 BOM，所有中文提示

**大致规模**（只给个量级，避免写死后过期）：后端约 1750 行，前端约 1050 行，
其中 `ysp.mjs` 和 `public/app.js` 各占大头。要看准确值：

```powershell
Get-ChildItem -Recurse -File -Include *.mjs,*.js,*.html,*.css |
  ForEach-Object { "{0,5} {1}" -f (Get-Content $_.FullName).Count, $_.Name }
```

不是 git 仓库。改动请**只在这个目录内**。

---

## 2. 先跑起来 / 怎么验

```powershell
cd E:\clone\deepseek-harness\avsync
$env:PORT='8799'; node server.mjs      # 前台跑，看日志
```

然后 `http://127.0.0.1:8799/`。用户日常是双击 `启动.cmd`。

### 关键接口（用于自检）

| 接口 | 说明 |
| --- | --- |
| `GET /api/channels` | 63 路频道列表，最常用作"服务活着吗"探针 |
| `GET /api/config` | 含 `maxAudioDelay`（B站声音延迟硬上限，目前 15） |
| `GET /api/resolve-channel?q=` | 链接/频道名 → slug（认 `tv.cctv.com/live/*`、yangshipin、`CCTV5+` 等） |
| `GET /api/ysp/debug?slug=cctv5p` | **最有用的调试口**：缓冲片数、跨度、`maxDelaySec`、最新片墙钟滞后、刷新/错误计数 |
| `GET /api/bili/status/<room>` | B站房间缓冲与延迟上限 |
| `GET /api/debug` | 上面两个的合集 |
| `GET /ysp/<slug>.m3u8?delay=N` | 画面清单，`delay` 秒 = 相对最新分片再往后推 |
| `GET /bili/<room>.m3u8?delay=N` | 声音清单，同上 |
| `GET /seg/b<room>:<base64url>[?g=...]` | 分片代理；B站的带房间号前缀用于过期重建签名 |
| `GET /api/time` / `GET /api/settime?skew=<ms>` | 客户端时钟偏差校正（见 §3.8） |

自检建议直接照着上面的接口打一遍；`delay` 是否真的生效，**看清单里第一片的
`#EXT-X-PROGRAM-DATE-TIME` 与 `delay=0` 时的差值**（不是看 `EXTINF`）。

### 可选配置 `config.json`（放在本项目根目录，**不要提交/外传**）

参考 `config.example.json`。键名以 `bili.mjs: loadCookieFile()` 实际读取的为准：

| 键 | 作用 |
| --- | --- |
| `biliCookie` | B站 登录 Cookie（如 `"SESSDATA=xxx;"`），用于更高清晰度 |
| `potplayerPath` / `vlcPath` | 自动探测不到播放器时手写完整路径 |

没有 `config.json` 也能正常跑，清晰度约 1080p 以内。

---

## 3. 硬约束（改代码前必读，全是踩出来的）

### 3.1 这个项目**不建依赖、不装包**

只用 Node 标准库 + `public/vendor/hls.min.js`。不要引入 `jquery`/`hls.js` npm 版之类。
前端拿不到网络 CDN（要能离线跑），所以库必须是本地文件。

### 3.2 取媒体**必须用 `http.mjs` 的 `rawGet`，不要用 `fetch`**

**部分央视 CDN 会对 Node 内置 `fetch`（undici）的请求指纹返回 403**，
换原生 `https` 模块就 200。这是 `http.mjs` 存在的唯一原因。

已实测：`live-dtocnc-cdn.ysp.cctv.cn` 同一分片 URL，`fetch` → 403，原生 https → 200。
所以所有"取清单/取分片"的请求都走 `rawGet`；`fetch` 只用于本地 `127.0.0.1` 和 B站普通 API。

### 3.3 央视频 bkliveinfo 的 CDN 要**实际探测**，不能按名字猜

`bkPlayurls()` 返回多个候选地址，但**名字里带 `bklive-` 的对分片可能返回 403**，
别名 CDN（`hlsliveali-cdn` 等）才可用，而且**每次请求给的候选不一样**。
所以必须用 `probeBkUrl()` 逐个试拉一次分片，谁真能拉到才用谁。

### 3.4 `#EXT-X-MEDIA-SEQUENCE` 必须**单调递增**（曾经导致"放一会儿卡住"）

这是本项目最隐蔽的一个 bug，务必不要改回去：

- 央视频时移分片**本身不带序号**，如果直接 `s.seq ?? 0`，会让下发的
  `EXT-X-MEDIA-SEQUENCE` **恒为 0**；
- 播放器靠这个序号判断"清单有没有前进"，序号不动就可能**不再取新分片** →
  表现就是"放一会儿画面卡住，把延迟归零一下又好了"；
- 现在由 `SegmentBuffer.addAll()` 给每个入缓冲的分片分配 `seqNext++`。

**推论**：任何"重新构造清单"的代码路径，都必须保证序号随时间单调递增。
不要再给 `SegmentBuffer` 外部塞手工序号。

### 3.5 B站分片地址**滚动过期**，所以声音延迟有硬上限

实测（room 6，fMP4 1 秒片）：

| 分片 | 失效时间 |
| --- | --- |
| 最新一片 | 约 **+36 秒** |
| 次新一片 | 约 **+60 秒** |

而且 URL 里的路径段（`/live-bvc/<数字>/`）**每次取清单都在换**，同一个分片
在两次清单里路径不同但文件名相同。

因此：

- `bili.mjs` 里 `URL_MAX_AGE_MS = 20000`，超过 20 秒的地址**不再下发**（`dropExpiredUrls`）；
- `BILI_MAX_DELAY_SEC = 15` 是**服务端硬上限**，并通过 `/api/config` 传给前端锁住滑块；
- **不要**把声音延迟上限调大来"满足用户"，那只会下发死链。用户的真实需求
  应该由**画面延迟**（央视频窗口 0~300 秒）来满足。

> 关于 `freshUrlFor()`：它重新取清单、**按文件名**找同分片的新地址。
> 注意不能用"旧目录 + 文件名"拼（路径段会换，必然 404）。

### 3.6 时移窗口只有 300 秒，且 CDN 缓存新旧不一

`jceTimeshiftUrl(pid, sid, now-300, now, defn)` 拿到的是**最近 300 秒**。
不同边缘节点返回的窗口新旧不一（实测能差几分钟），所以 `refreshJce()` 会
**取 3 次、挑"最新分片墙钟最靠前"的那次**。别把这段"重复请求"当成冗余删掉。

`SegmentBuffer` 按**时长**（`maxSpanSec`）而不是条数淘汰，避免慢速源塞爆。

### 3.7 静态清单里的分片地址要有 CDN 白名单

`fetchSeg()` 只允许 `ysp.cctv.cn / cctv.* / bilivideo.* / bilibili.com / hdslb.com`。
本服务虽绑 127.0.0.1，但也不该成为任意 URL 转发器（SSRF）。**不要放开**。

### 3.8 客户端时钟偏移必须校正

播放器用**本机 UTC 时钟**决定"最新直播"在哪（`hls.playingDate` 与 PDT 比较）。
用户机器时钟若偏几十秒，画面就会跟着偏几十秒，而且**两个源都会偏**。
所以前端启动时把自己的偏差通过 `GET /api/settime?skew=<ms>` 报给服务端，
服务端在 `jceTimeshiftUrl` 的 `now` 上补这个偏移。改取流时不要丢掉 `_skewMs`。

### 3.9 B站**不要**伪造 `#EXT-X-PROGRAM-DATE-TIME`

B站清单本身没有墙钟。早期实现用"缓冲到达时刻"编了一个 PDT，
结果让 `hls.playingDate` 算出的滞后完全错乱。现在 B站 清单**不发 PDT**，
前端对 B站 那条流改用 `seekable` 末端估算滞后（见 `app.js: naLatency`）。

### 3.10 已修掉的崩溃（不要改回去）

- **`new URL(req.url, ...)` 必须在 `try` 里**：handler 是 `async`，抛在 try 外面会变成
  unhandled rejection，Node 22 默认**直接终止进程**。一句畸形请求
  （`GET //[ HTTP/1.1`）就能打死服务。已验证过。
- **`fs.createReadStream().pipe(res)` 必须挂 `error`**：否则文件在 stat 与 open 之间
  消失会让整个进程退出。
- `process.on('uncaughtException' / 'unhandledRejection')` 是最后一道保险，打印但不退出。

---

## 4. Windows 文件编码（**这条最容易把项目搞坏**）

这个项目的文本文件被**反复写坏过**，务必遵守：

| 规则 | 原因 |
| --- | --- |
| **改文本文件用编辑工具，不要用 PowerShell 的 `Set-Content` / `Out-File`** | 它按本地代码页转换，会吃掉多字节字符的尾字节。本项目 `public/app.js` 曾被这样写坏 **77 个字符**（文件变成非法 UTF-8，连读取工具都打不开） |
| `.cmd`：**纯 ASCII 内容 + CRLF 行尾**，文件名也尽量 ASCII | cmd 按系统代码页解析；UTF-8 内容或 LF 行尾会让脚本在处理到中文行时报一堆"不是内部或外部命令"然后闪退（真实发生：用户双击后窗口一闪而过） |
| `.ps1`：**UTF-8 必须带 BOM** | Windows PowerShell 5.1 只有见到 BOM 才按 UTF-8 读脚本；否则按代码页读，中文标点的字节会被当成引号，**直接语法错误** |
| PowerShell 的 `\u` 转义**只在双引号字符串里生效** | 写在单引号里会原样输出 `\u2014` |
| 其它 `.mjs` / `.js` / `.md`：UTF-8 **不带 BOM** | 与 Node / 浏览器一致 |

自检（应全部通过）：`.cmd` 纯 ASCII 且含 CR，`.ps1` 是合法 UTF-8 且带 BOM。

如果文件已被写坏：用 Node 写脚本，以 **TextDecoder({fatal:true}) 逐字节定位非法序列**
（损坏模式通常是"多字节字符丢了最后一字节"），按上下文还原，再用 `Buffer.from(s,'utf8')` 落盘。

---

## 5. 前端约定（`public/`）

- **DOM id 是约定接口**：`app.js` 用 `$('id')` 取元素，`index.html` 必须有对应 id。
  现在 46 个 id 全部对应。加/删 id 时两边一起改，否则运行期才报错。
- **`attachHls()` 收 `hls` 和一个 `onFatal`**（早期版本的 `video`/`url` 参数已删）。
  接线统一走 `wireHls()`。
- **同一个 media 元素只能 `createMediaElementSource` 一次**，重复调用会抛
  `InvalidStateError` 并让音频失效。`startVU()` 用 `vuWired` 守着。
- `drawVU` 的 rAF 循环在暂停时通过 `stopVU()` 停掉，且复用 `vuBuf`（不要每帧 new）。
- 改延迟后会**重载对应播放器**（`applyVideoDelay` / `applyAudioDelay`，
  350ms 防抖）。因为服务端窗口会整体平移，重载是最干净的做法。
- 一键对齐 / 自动实时对齐在 `align()` / `autoTick()`：**大偏差改服务端延迟（要重载），
  小偏差只改 `playbackRate`（不打断）**。见下一节。

---

## 6. 对齐是怎么工作的（别误解它）

量的是**纯时间**，不看画面、不听声音：

```
diff = 画面滞后 − 声音滞后
  > 0 : 画面更慢 -> 把画面延迟调小
  < 0 : 画面更快 -> 把画面延迟调大
  0   : 对齐
```

- 「滞后」= 该流当前播放位置距它**自己的实时边缘**多远；
  央视频用清单里的真实 PDT（`hls.playingDate`），B站 用 `seekable` 末端估算。
- `align()`（一键）：等采样稳定 → 按上面规则改两边延迟 → 重载。
- `autoTick()`（自动实时，1s 一次）：两路连续稳定播放约 12 秒后才采样，使用较长中位数窗口并丢弃突跳值。
  - `|diff| < 0.7s`：恢复正常速率；
  - `0.7s ≤ |diff| ≤ 3.5s`：只改画面 `playbackRate`（约 ±0.3%~±2.5%），不打断；
  - `|diff| > 3.5s`：重算服务端延迟并重载，**间隔限流 30 秒**，单次最多调整 20 秒。

**它保证"两个播放位置在时间轴上对齐"，不保证"内容语义对齐"。**
机位不同、解说 vs 原声、语言不同都不影响它；但两条流若不是同一场事件，
数字会"看着合理而内容对不上"——这只能靠人耳。**改动对齐逻辑时不要加任何
依赖画面/音频内容的判断（如画面相似度），那会引入不可控的复杂度。**

---

## 7. 已知限制 / 未验证（接手时请注意）

| 项 | 状态 |
| --- | --- |
| 央视频匿名接口最高 1080p | 4K/HEVC 需要带设备签名的协议，本项目不含 |
| B站清晰度 | 不配 `config.json` 的 `biliCookie` 时约 1080p 以内 |
| B站搜索接口 | 有时返回 `412`（上游风控），属正常，接口会干净报错不崩 |
| 「一键对齐」的**听感** | **没有用真实解说验证过**（需要人耳）。机器侧只能验到"差值收敛到 ±0.5s 内" |
| 长时间卡顿 | 修了序号问题后连续 3 分钟以上稳定；更长时段未验证 |
| 全屏 | 标准 Fullscreen API，用户已确认可用；agent 无法代点（需用户手势） |
| 服务进程 | 用户**双击 `启动.cmd`** 起的服务不会被回收，可长期运行。agent 用受管后台作业（如 `run_in_background`）起的进程，其存活与 agent 会话绑定，**不要据此判断代码有问题**——曾经因此误判过一次（实测非受管方式起的 node 稳定存活 ≥2 分钟无异常，见 §7.1） |

### 7.1 关于"服务进程被杀"的排查结论（2026-10-12）

一度怀疑"环境会在几十秒后硬杀后台 node 进程"，**实测否定了这个假设**：
以普通方式（`Start-Process`，非受管作业）起的 `node server.mjs` 连续运行 120 秒、
12 次 `/api/channels` 全部 200，进程始终存活且 stderr 为空。

后来确认那几次"服务没了"的真实原因各不相同：一次是**用户自己双击 `停止.cmd` 停的**，
另外几次是 agent 自己清理进程时误伤。

**结论**：服务意外消失时，先看 `run.err` / `run.log` 有没有 JS 报错，再看是不是被人停了；
**不要**先归因于环境。真正的代码级崩溃都会在 `run.err` 留下 `[uncaught]` / `[unhandled]` 记录
（见 §3.10 的兜底处理器）。

---

## 8. 改动后的自检清单

1. `node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"`（前端语法）
2. 起服务后打一遍 `/api/channels`、`/api/config`、`/ysp/cctv5p.m3u8`、
   `/bili/<在播房间>.m3u8`
3. **`delay` 是否真生效**：比较 `delay=0` 与 `delay=60` 清单里第一片的 `PROGRAM-DATE-TIME`
4. **序号是否递增**：连续取 4 次 `delay=0`，`EXT-X-MEDIA-SEQUENCE` 必须增长
   （这是最容易回归的 bug）
5. `.cmd` / `.ps1` 的编码检查（见 §4）
6. 若动了 `server.mjs` 的路由：确认畸形请求（`GET //[`）之后服务仍存活
7. 若动了前端：`app.js` 引用的每个 DOM id 都要在 `index.html` 里存在（当前 46 个）

---

## 9. 协作偏好（来自项目所有者）

- 回复用**中文**；结论先行，少客套。
- **不要过度工程化**，不要为了"完整"引入依赖或抽象层。
- 改完给出**可核验的证据**（命令输出 / 实测数字），不要只说"应该可以"。
- 遇到平台硬限制（如 B站 声音延迟 15 秒），**如实说明**，不要用假实现糊过去
  （此前把手伸向"把上限调大好满足用户"是错的方向）。

## 10. 改完请顺手做

- 改了**用户能感觉到的行为**（按钮、延迟语义、平台限制）→ 同步更新 **README.md**，
  并在 §7 里把该条从"未验证"改成实测结论。
- 踩到新坑 / 修掉新 bug → 补到 **§3 或 §4**，写清"为什么"，别只写"改了什么"。
  §3.4（序号）、§4（编码）这两条尤其不要删。
- 文档与本文件都在项目内，改动请用编辑工具（原因见 §4）。

## 11. 近期协作记录（2026-10-12）

- `bili.mjs`：B站状态增加 `freshSpanSec`、`safeDelaySec`、`warmup`、`warmupRemainingSec`，用于显示分片预热进度；`BILI_MAX_DELAY_SEC` 仍为 15 秒安全上限，不要直接抬高。
- `public/index.html`：手动声音滑块固定为 0~15 秒；手动画面滑块为 0~300 秒；新增画面和声音两条只读的自动结果显示条，显示范围均为 0~300 秒。
- `public/app.js`：自动对齐等待两路稳定约 12 秒，过滤突跳采样；小偏差使用播放速率微调，大偏差每 30 秒最多粗调一次、单次最多调整 20 秒。两条自动结果使用 `requestAnimationFrame` 平滑动画，手动拖动不会改动自动结果条；显示条不使用手动声音滑块的 15 秒上限。
- `public/style.css`：新增画面/声音自动结果显示条、动画和状态样式。
- `README.md`：已补充B站预热原因、15秒安全上限、自动结果与手动滑块的区别。
- 本轮验证：`node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"` 通过；前端 46 个 DOM id 全部存在。当前环境曾出现央视/B站上游连接 `connect EACCES ...:443`，这是外部网络权限问题，不是链接解析错误。
- **启动脚本统一**（第二个 agent 收尾）：删掉多余的 `start.cmd` / `stop.cmd`，
  只剩 `启动.cmd → start.ps1` 和 `停止.cmd → stop.ps1` 四个文件（见 §1）。
  已在 GBK(936) 下实测两个入口：启动后 `/api/channels` 200、`/ysp/cctv5p.m3u8` 200，
  停止后端口释放。**不要再加中间层**。
