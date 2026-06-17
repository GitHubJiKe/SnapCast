# SnapCast 功能待办路线图

> **产品理念**：单一职责的录屏工具，功能聚焦于"录制过程本身"，不引入服务端、不引入 AI、不做录后剪辑。每个功能做到满分，而不是堆砌平庸的功能集合。

---

## 功能优先级总览

| # | 功能 | 优先级 | 估算工作量 | 依赖关系 | 状态 |
|---|------|--------|-----------|---------|------|

| F1 | 屏幕标注工具 | 🔴 P0 | L（大） | 无 | ✅ 已完成 |
| F2 | ~~MP4 转码性能优化~~ | — | — | — | ❌ 已移除 |
| F3 | 区域录制 | 🟡 P1 | M（中） | 无 | ✅ 已完成 |
| F4 | GIF 导出 | 🟡 P1 | M（中） | 无 | 待实现 |
| F5 | 自定义摄像头样式 | 🟢 P2 | M（中） | 无 | 待实现 |
| F6 | 多摄像头切换 | 🟢 P2 | S（小） | 无 | 待实现 |
| F7 | 录制模板 | 🟢 P2 | S（小） | F3 已完成更佳 | 待实现 |

---

## F1 — 屏幕标注工具 ✅ 已完成

**优先级**：🔴 P0（核心差异化功能，Loom/Screencast-O-Matic 的核心卖点）

### 需求描述

录制进行中，用户可以在屏幕上实时绘制标注（箭头、荧光笔、圆形高亮），标注内容**直接合入录制画面**，停止录制后自动清除所有标注图层。

### 技术方案

**关键判断**：当前 `content.js` 主流程直接使用屏幕流的原始视频轨道（`screenStream.getVideoTracks()[0]`），**不经过 Canvas 合成**。要实现标注，必须在录制路径中插入一个 Canvas 合成层。

**实现路径**：

```
当前路径：screenVideoTrack  →  mixedStream  →  MediaRecorder
目标路径：screenVideoTrack  →  Canvas合成（叠加标注层）→  canvas.captureStream()  →  MediaRecorder
```

**分步实现**：

**Step 1 — 在 content.js 中引入 Canvas 合成层**

在 `buildMixedStream()` 函数中，将原本直接使用 `screenVideoTrack` 的方式替换为：

```javascript
// 1. 创建一个离屏 canvas，尺寸与屏幕流分辨率一致
const annotationCanvas = document.createElement('canvas');
const annotationCtx = annotationCanvas.getContext('2d');

// 2. 创建一个隐藏的 <video> 元素接收屏幕流
const screenVideoEl = document.createElement('video');
screenVideoEl.srcObject = new MediaStream([screenVideoTrack]);
screenVideoEl.play();

// 3. requestAnimationFrame 循环：每帧先绘屏幕帧，再叠加标注图层
function renderFrame() {
  annotationCtx.drawImage(screenVideoEl, 0, 0);
  drawAnnotations(annotationCtx); // 绘制当前标注图层
  requestAnimationFrame(renderFrame);
}
renderFrame();

// 4. 用 canvas.captureStream(30) 替代原始 screenVideoTrack
const canvasVideoTrack = annotationCanvas.captureStream(30).getVideoTracks()[0];
```

**Step 2 — 标注图层数据结构**

```javascript
// 每条标注笔迹是一个对象
const annotations = []; // { type, color, size, points: [{x,y}] }
let currentStroke = null; // 当前正在绘制的笔迹
```

**Step 3 — 注入标注工具栏 DOM（在 content.css 中定义样式）**

```
悬浮标注工具栏（独立于录制控制工具栏）：
  ├── 画笔工具（自由绘制）
  ├── 荧光笔（半透明宽线条）
  ├── 箭头工具
  ├── 圆形高亮
  ├── 颜色选择器（预设 5 色：红/黄/绿/蓝/白）
  ├── 粗细选择（细/中/粗）
  └── 撤销最后一笔（Ctrl+Z）
```

**Step 4 — 事件拦截**

标注激活时，在 `document` 上覆盖一层透明的 `pointer-events: all` 画布，捕获 `pointerdown/pointermove/pointerup` 事件转为笔迹坐标。非标注状态下，此覆盖层 `pointer-events: none`，不影响正常页面交互。

**Step 5 — 点击高亮效果（Click Highlight）**

监听 `click` 事件，在点击位置绘制一个扩散消失的圆形波纹动画，持续约 600ms 后自动从 `annotations` 中移除。

**注意事项**：
- `recorder.js`（旧版方案）中已有 Canvas 合成逻辑（`drawFrame()`），可以作为参考，但新功能应在 `content.js` 主流程中实现
- 标注工具栏需要和现有的录制控制工具栏区分开，建议标注栏固定在页面**左侧**，避免与顶部录制栏重叠
- 标注笔迹坐标必须归一化（相对 canvas 宽高的百分比），保证在不同分辨率录制下坐标一致

---

## F2 — ~~MP4 转码性能优化~~ ❌ 已移除

> **移除原因**：Chrome 扩展消息传递存在 **64MB 硬限制**，录制产生的 WebM 文件经 base64 编码后极易超出此限制。ffmpeg.wasm 在浏览器端运行具有根本性局限（单线程转码慢、消息体积限制），无法提供可接受的体验。项目仅支持 **WebM 格式**输出，停止录制后立即下载，零等待。

---

## F3 — 区域录制 ✅ 已完成

**优先级**：🟡 P1（高频需求，尤其是只想录制页面某个组件的开发者）

### 需求描述

用户可以在开始录制前，拖拽选择一个矩形区域，只录制该区域内的内容，而非整个屏幕/窗口。

### 技术方案

**关键约束**：`getDisplayMedia()` 本身不支持区域裁剪，只能录制整个屏幕/窗口/标签页。因此区域裁剪必须在**录制后通过 Canvas 裁切实现**。

**实现路径**：

**Step 1 — 区域选择 UI**

在用户点击「开始录制」后，进入屏幕选择流程之前，注入一个全屏半透明蒙层让用户绘制选区：

```
全屏遮罩（rgba(0,0,0,0.5)）
  └── 用户拖拽绘制矩形选区
       ├── 选区内：透明（展示真实页面内容）
       ├── 选区边框：高亮白色虚线 + 四角调节手柄
       └── 确认/取消 按钮
```

用 `clip-path` 或双层 canvas 实现选区内透明效果。

**Step 2 — 记录选区坐标**

```javascript
// 选区坐标：相对于页面视口，需要考虑 devicePixelRatio
const cropRegion = {
  x: Math.round(selectionLeft * devicePixelRatio),
  y: Math.round(selectionTop * devicePixelRatio),
  w: Math.round(selectionWidth * devicePixelRatio),
  h: Math.round(selectionHeight * devicePixelRatio),
};
```

**Step 3 — Canvas 裁切合成**

在 F1 已有 Canvas 合成层的基础上（若 F1 未完成则单独引入），修改 `drawFrame()` 逻辑：

```javascript
// 不再 drawImage 整个屏幕，而是只绘制选区部分
annotationCtx.drawImage(
  screenVideoEl,
  cropRegion.x, cropRegion.y,   // 源图裁切起点
  cropRegion.w, cropRegion.h,   // 源图裁切尺寸
  0, 0,                          // 目标 canvas 起点
  annotationCanvas.width,        // 目标 canvas 宽（等于选区宽）
  annotationCanvas.height        // 目标 canvas 高（等于选区高）
);
```

同时将 `annotationCanvas` 的尺寸设为选区尺寸，而非全屏尺寸。

**Step 4 — popup 中新增区域录制开关**

在配置面板新增一个 Toggle：「📐 指定录制区域」，默认关闭（保持全屏录制行为不变）。

**注意事项**：
- 区域选择蒙层本身会出现在 `getDisplayMedia` 选择的屏幕内容中，因此必须在**选区确认后**再调用 `getDisplayMedia`，然后在 Canvas 合成阶段裁切
- `devicePixelRatio` 在 Retina 屏幕上为 2，坐标换算必须考虑

---

## F4 — GIF 导出

**优先级**：🟡 P1（开发者 Bug 报告、文档嵌入的高频格式）

### 需求描述

录制完成后，除 WebM/MP4 外，增加 GIF 格式导出选项。GIF 导出应该：
- 支持设置帧率（建议默认 10fps，最高 15fps，避免文件过大）
- 支持设置尺寸缩放比例（100% / 75% / 50%）
- 显示预估文件大小

### 技术方案

**方案选择**：使用纯前端的 `gif.js` 库实现，无需额外服务端。

**推荐库**：[gif.js](https://github.com/jnordberg/gif.js)，MIT 协议，约 60KB，在 Web Worker 中运行，不阻塞主线程。

**实现路径**：

**Step 1 — 录制时采集帧数据**

当用户选择 GIF 格式时，在 Canvas `drawFrame()` 循环中**额外**按设定帧率采集帧快照（不影响 WebM 主录制流）：

```javascript
const GIF_FPS = 10;
const GIF_FRAME_INTERVAL = 1000 / GIF_FPS; // 100ms
let lastGifFrameTime = 0;

function drawFrame() {
  // ... 现有绘制逻辑 ...
  
  // GIF 帧采集（仅当用户选择 GIF 格式时启用）
  if (outputFormat === 'gif') {
    const now = Date.now();
    if (now - lastGifFrameTime >= GIF_FRAME_INTERVAL) {
      gifFrames.push(annotationCtx.getImageData(0, 0, canvas.width, canvas.height));
      lastGifFrameTime = now;
    }
  }
  
  requestAnimationFrame(drawFrame);
}
```

**Step 2 — 录制停止后编码 GIF**

```javascript
async function encodeGif(frames, width, height, fps) {
  const gif = new GIF({
    workers: 2,
    quality: 10, // 1=最佳质量，越大越快
    width,
    height,
    workerScript: chrome.runtime.getURL('vendor/gif.worker.js')
  });

  for (const frame of frames) {
    gif.addFrame(frame, { delay: 1000 / fps });
  }

  return new Promise((resolve) => {
    gif.on('finished', (blob) => resolve(blob));
    gif.render();
  });
}
```

**Step 3 — vendor 目录新增文件**

需要在 `vendor/` 目录中添加：
- `gif.js`（主库）
- `gif.worker.js`（Web Worker 编码器）

同时在 `manifest.json` 的 `web_accessible_resources` 中注册这两个文件。

**注意事项**：
- GIF 格式**不支持音频**，导出时应在 UI 中明确提示
- 长时间录制（>1分钟）导出 GIF 会导致文件极大，建议在 UI 中显示预估大小警告
- 建议帧数据存为 `ImageData` 而非 `Blob`，避免内存中存储大量 Blob 对象

---

## F5 — 自定义摄像头样式

**优先级**：🟢 P2（差异化体验，提升产品精致感）

### 需求描述

用户可以自定义摄像头画中画的外观：
- **形状**：圆形（默认）/ 圆角矩形 / 正方形
- **边框**：无边框 / 细边框（颜色可选）/ 发光效果
- **背景虚化**：开启时对摄像头背景进行模糊处理（视频流层面实现）

### 技术方案

**形状裁切（`clip-path` 实现）**

当前 `content.js` 的摄像头泡泡 `camBubble` 使用 CSS `border-radius: 50%` 实现圆形。要支持多种形状，改为：

```css
/* 圆形 */
.sc-cam-shape-circle  { clip-path: circle(50%); }

/* 圆角矩形 */
.sc-cam-shape-rounded { clip-path: inset(0 round 16px); }

/* 正方形 */
.sc-cam-shape-square  { clip-path: inset(0); }
```

通过给 `camBubble` 动态切换 class 实现形状切换，无需修改录制逻辑。

**边框样式**

CSS `outline` 或 `box-shadow` 实现，颜色通过 CSS 变量控制：

```css
.sc-cam-border-glow {
  box-shadow: 0 0 0 3px var(--cam-border-color), 0 0 12px var(--cam-border-color);
}
```

**背景虚化**

`getUserMedia` 不直接支持背景虚化，需要通过 `MediaStreamTrack.applyConstraints()` 的 `backgroundBlur` 约束实现（Chrome 94+ 支持）：

```javascript
const videoTrack = cameraStream.getVideoTracks()[0];
if ('applyConstraints' in videoTrack) {
  await videoTrack.applyConstraints({
    advanced: [{ backgroundBlur: true }]
  });
}
```

注意：此 API 目前支持度有限，需要做能力检测，不支持时优雅降级（隐藏该选项）。

**UI 实现**

在 `popup.html` 的配置区，摄像头开关下方展开一个折叠面板「摄像头样式」，包含形状选择（三个图标按钮）和边框颜色选择（色块）。配置通过 `chrome.storage.local` 持久化，随 `SC_START` 消息传递给 content script。

---

## F6 — 多摄像头切换

**优先级**：🟢 P2（外接摄像头、虚拟摄像头用户需求）

### 需求描述

当用户有多个摄像头设备时（如内置摄像头 + 外接 USB 摄像头），可以在录制前选择使用哪个摄像头。

### 技术方案

改动范围最小，主要集中在 `popup.html` 和 `popup.js`。

**Step 1 — 枚举设备列表**

```javascript
async function getCameraDevices() {
  // 必须先请求一次权限，否则 label 为空字符串
  await navigator.mediaDevices.getUserMedia({ video: true });
  
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}
```

**Step 2 — popup 中新增摄像头选择下拉框**

摄像头 Toggle 开关打开后，展示摄像头设备列表 `<select>`：

```html
<select id="cameraDeviceSelect">
  <option value="">默认摄像头</option>
  <!-- 动态填充 -->
</select>
```

**Step 3 — 传递 deviceId 给 content script**

在 `SC_START` 消息的 `config` 对象中增加 `cameraDeviceId` 字段：

```javascript
// popup.js getConfig() 中增加：
cameraDeviceId: cameraDeviceSelect.value || undefined,
```

在 `content.js` 的 `buildMixedStream()` 中使用：

```javascript
cameraStream = await navigator.mediaDevices.getUserMedia({
  video: {
    deviceId: recConfig.cameraDeviceId ? { exact: recConfig.cameraDeviceId } : undefined,
    width: { ideal: 640 }, height: { ideal: 640 }
  },
  audio: false
});
```

**注意事项**：
- `enumerateDevices()` 在未授权前 `label` 为空，需要先请求一次权限触发授权弹窗，再枚举设备
- 设备列表应在 popup 每次打开时刷新（`DOMContentLoaded` 时调用）

---

## F7 — 录制模板

**优先级**：🟢 P2（提升专业用户效率）

### 需求描述

用户可以将当前的配置（分辨率约束、帧率、格式、摄像头开关、麦克风开关）保存为「模板」，下次一键应用，不需要每次重新配置。内置 3 个预设模板：「高质量演示」「快速分享」「开发者调试」。

### 技术方案

**数据结构**

```javascript
// 保存在 chrome.storage.local 的 'snapCastTemplates' 键下
const template = {
  id: 'uuid-xxx',
  name: '高质量演示',
  isBuiltin: true, // 内置模板不可删除
  config: {
    mic: true,
    camera: true,
    format: 'mp4',
    frameRate: 30,
    resolution: '1080p',   // '720p' | '1080p' | 'native'
    cameraDeviceId: null,
    cropRegion: null,      // 区域录制配置（F3 完成后启用）
  }
};
```

**内置预设**

| 模板名 | 分辨率 | 帧率 | 格式 | 摄像头 | 麦克风 |
|--------|--------|------|------|--------|--------|
| 高质量演示 | native | 30 | MP4 | 开 | 开 |
| 快速分享 | 720p | 24 | WebM | 关 | 开 |
| 开发者调试 | native | 60 | WebM | 关 | 关 |

**UI 实现**

在 popup 配置区顶部增加模板选择行：

```
[模板：自定义 ▾]  [保存当前] [删除]
```

选择模板后，下方所有配置项自动更新为模板值；用户修改任何选项后，模板选择器自动切换为「自定义」。

**分辨率约束传递**

`getUserMedia` 支持通过 `width/height` 约束限制摄像头分辨率；`getDisplayMedia` 的分辨率受系统控制，无法直接约束，但可以在 Canvas 合成时缩放输出尺寸来降低录制分辨率：

```javascript
// 在 buildMixedStream() 中，根据模板配置决定 canvas 输出尺寸
if (recConfig.resolution === '720p') {
  annotationCanvas.width = 1280;
  annotationCanvas.height = 720;
} else {
  // native：使用屏幕实际分辨率
  annotationCanvas.width = screenTrackSettings.width;
  annotationCanvas.height = screenTrackSettings.height;
}
```

---

## 实施顺序建议

```
第一阶段（核心差异化）✅ 已完成
  F1 屏幕标注  →  Canvas 合成层 + 标注工具 UI + 交互（画笔、箭头、荧光笔）

第二阶段（功能完善）✅ 已完成
  F3 区域录制  →  依赖 F1 的 Canvas 合成层，已具备实施基础
  F6 多摄像头  →  改动小，可随时插入

第三阶段（格式扩展）
  F4 GIF 导出  →  需要引入 gif.js 依赖，单独一个迭代

第四阶段（精致化）
  F5 摄像头样式
  F7 录制模板
```

---

## 技术约束备忘

- **无服务端**：所有功能必须纯前端实现，转码/编码均在浏览器内完成
- **无 AI**：不引入任何 AI/ML 能力
- **无剪辑**：不实现录后时间线剪辑，录完即是成品
- **MV3 兼容**：所有新增脚本必须符合 Manifest V3 的 CSP 规则（`script-src 'self'`），不允许 `eval()`，不允许 WASM unsafe eval
- **隔离性**：content script 注入的所有 DOM 元素必须使用 `#snapcast-` 前缀，不污染宿主页面
- **vendor 目录**：新增的第三方库（gif.js 等）统一放入 `vendor/`，并在 `manifest.json` 的 `web_accessible_resources` 中注册
- **输出格式**：仅支持 WebM，不引入任何音视频转码依赖（已移除 ffmpeg.wasm）
