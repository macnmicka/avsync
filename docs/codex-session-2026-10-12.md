# Codex 协作记录（2026-10-12）

这不是平台聊天原文，而是本次 Codex 会话的项目内摘要，供后续 AI 接手。

## 用户目标

- 解释 B 站声音延迟约 15 秒上限和“预热”的原因。
- 改善一键对齐和自动实时对齐。
- 明确手动延迟与自动延迟的关系，避免用户误解滑块状态。
- 保留项目零依赖、原生 `rawGet` 取媒体、B 站 15 秒安全上限等硬约束。

## 已完成改动

### `bili.mjs`

- B 站房间状态增加 `freshSpanSec`、`safeDelaySec`、`warmup`、`warmupRemainingSec`。
- 仍保持 `BILI_MAX_DELAY_SEC = 15`。原因是 B 站分片签名地址滚动过期，且必须给播放器保留播放窗口；不能简单把上限调大。

### `public/index.html`

- 手动声音延迟滑块固定为 `0~15` 秒。
- 手动画面延迟滑块为 `0~300` 秒。
- 增加只读的“自动结果（画面）”显示条，范围 `0~300` 秒，用于显示一键对齐/自动粗调得到的画面服务端延迟。
- 后续 UI 补充：在画面自动结果条下面增加“自动结果（声音）”只读滑块，显示范围 `0~300` 秒；两条自动结果均用 `requestAnimationFrame` 平滑动画，播放速率微调时画面条也会实时向有效目标移动。显示范围与实际 B 站声音下发上限分离。

### `public/app.js`

- 自动对齐需两路连续稳定播放约 12 秒后才开始采样。
- 自动采样使用更长中位数窗口，并过滤突跳值。
- 差值小于 `0.7s` 时恢复正常速率。
- `0.7~3.5s` 时只调整画面 `playbackRate`，约 `±0.3%~±2.5%`。
- 大于 `3.5s` 时才重算服务端延迟并重载，至少间隔 30 秒，单次最多调整 20 秒。
- `setAutoReadout()` 记录一键对齐/自动粗调的画面和声音结果；手动拖动不会改动自动结果显示条。
- 手动改延迟、重载播放器后会清空旧自动采样，重新等待稳定。

### `public/style.css`

- 增加画面/声音自动结果显示条、平滑动画和自动状态提示的样式。

### `README.md`

- 补充 B 站分片预热机制、15 秒安全上限、自动结果显示与手动滑块的区别。
- 补充自动对齐的稳定采样、异常过滤和限流策略。

### `AGENTS.md`

- 更新自动对齐阈值和限流说明。
- 更新前端 DOM id 数量为 46。
- 增加“近期协作记录”章节和本次验证结果。

## 验证结果

- `node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"`：通过。
- 前端脚本引用的 46 个 DOM id 全部存在于 `public/index.html`。
- `/api/config`：HTTP 200，`maxAudioDelay: 15`。
- `/api/channels`：HTTP 200，频道列表正常。

## 已知环境问题

一次取流探测中，央视和 B 站均返回 `AggregateError`，展开后的子错误全部是：

```text
connect EACCES <upstream-ip>:443
```

这表示当前环境/防火墙/代理阻止 Node 对外 HTTPS 连接，不是链接解析失败，也不能据此判断直播间未开播。排查命令：

```powershell
netsh winhttp show proxy
Get-ChildItem Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY -ErrorAction SilentlyContinue
```

## 接手注意

- 项目不是 Git 仓库，以上文件修改没有 commit 记录。
- 原始 Codex 聊天记录不在项目文件系统中；本文件是项目内可移交的摘要。
- 不要把 B 站声音上限直接改大来满足 UI 需求；超过有效期会下发死链。
- 自动结果显示的是画面服务端延迟，声音仍受 15 秒安全上限约束。
