# 🎬 SnapCast

> 本地录屏 + 摄像头画中画 Chrome 扩展，隐私优先，无需上传云端。

<p align="center">
  <img src="video-camera.png" alt="SnapCast" width="80" />
</p>

## 简介

SnapCast 是一款轻量级 **Chrome Manifest V3** 浏览器扩展，支持一键录制屏幕（全屏/窗口/标签页），叠加摄像头画中画，并直接保存到本地。所有数据仅在本地处理，**不上传任何服务器**，适合教程录制、Bug 复现演示、产品演示等场景。

## 核心功能

| 功能 | 说明 |
|------|------|
| 🖥 **屏幕录制** | 录制整个屏幕、应用窗口或浏览器标签页 |
| 🔊 **系统音频 + 麦克风** | AudioContext 多路混音，同时录制系统声音和麦克风 |
| 📷 **摄像头画中画** | 圆形摄像头泡泡叠加在屏幕角落，**可拖动**位置 |
| ⏯ **暂停 / 继续** | 录制过程中随时暂停和恢复 |
| 📥 **本地下载** | 录制完成自动触发下载，不上传云端 |
| 🔄 **格式转换** | WebM（秒下）或 MP4（ffmpeg.wasm 转码，兼容全平台） |
| ⌨️ **全局快捷键** | `⇧⌘P` 暂停/继续、`⇧⌘S` 停止录制（Mac）；Windows 使用 `Shift+Alt` |
| ⏳ **3 秒倒计时** | 开始录制前显示倒计时蒙层，确保录制从正确时刻开始 |
| 🎯 **悬浮工具栏** | 注入目标页面的浮动控制条，录制时自动隐藏，不污染画面 |
| 🌓 **暗色界面** | 精心设计的暗色 UI，状态指示清晰 |

## 架构设计

```
┌──────────────┐      消息通信       ┌──────────────┐
│  popup.html  │ ◄─────────────────► │ background.js│
│  (配置/启停) │    chrome.runtime   │ (状态管理)   │
└──────────────┘                     └──────┬───────┘
                                            │
                                    注入 content.js
                                            │
                                   ┌────────▼───────┐
                                   │  content.js     │
                                   │  (注入目标页面)  │
                                   │                 │
                                   │ • getDisplayMedia│
                                   │ • getUserMedia   │
                                   │ • Canvas 合成    │
                                   │ • MediaRecorder  │
                                   └─────────────────┘
```

### 为什么在 content script 中录制？

- **干净的屏幕选择器**：`getDisplayMedia` 在目标页面内调用，用户选择屏幕时不会看到扩展自身的 recorder 窗口
- **跨标签页稳定**：录制进程运行在目标页面中，不受 popup 关闭影响
- **避免 Offscreen API 的复杂性**：使用 content script 直接获取媒体流，更简洁可靠

### 模块划分

| 模块 | 文件 | 职责 |
|------|------|------|
| **弹出窗口** | `popup.html / popup.css / popup.js` | 配置录制选项、显示状态、发送控制指令 |
| **后台服务** | `background.js` | Service Worker，状态持久化、消息路由、快捷键处理、触发下载 |
| **内容脚本** | `content.js / content.css` | 注入目标页面，渲染悬浮工具栏和摄像头泡泡，执行实际录制 |
| **独立录制器**（旧版） | `recorder.html / recorder.css / recorder.js` | 独立窗口的录制方案（已保留，当前主流程使用 content.js 方案） |
| **转码引擎** | `vendor/ffmpeg*` | ffmpeg.wasm 核心文件和加载脚本，用于 WebM → MP4 转换 |

## 技术栈

- **平台**：Chrome Extension Manifest V3
- **语言**：原生 JavaScript (ES6+)
- **API**：
  - `navigator.mediaDevices.getDisplayMedia()` — 屏幕捕获
  - `navigator.mediaDevices.getUserMedia()` — 摄像头/麦克风
  - `canvas.captureStream()` — Canvas 视频合成
  - `MediaRecorder` — 视频录制
  - `AudioContext` — 多路音频混音
  - `chrome.downloads` — 文件下载
  - `chrome.commands` — 全局快捷键
- **转码**：ffmpeg.wasm（约 32MB，按需懒加载）

## 安装使用

### 开发模式安装

1. 克隆仓库：
   ```bash
   git clone <repo-url>
   cd SnapCast
   ```

2. 打开 Chrome，访问 `chrome://extensions/`

3. 打开右上角「开发者模式」

4. 点击「加载已解压的扩展程序」，选择 SnapCast 目录

5. 点击工具栏中的 SnapCast 图标即可使用

### 使用流程

1. **配置选项**：在 popup 中设置麦克风、摄像头、输出格式
2. **开始录制**：点击「开始录制」，在弹出的对话框中选择录制范围
3. **倒计时**：选择屏幕后显示 3 秒倒计时
4. **录制中**：悬浮工具栏自动隐藏，鼠标移到页面顶部可查看
5. **暂停 / 停止**：通过快捷键或悬浮工具栏控制
6. **自动下载**：停止录制后自动下载到本地

## 快捷键

| 操作 | Mac | Windows/Linux |
|------|-----|---------------|
| 暂停 / 继续 | `Shift + ⌘ + P` | `Shift + Alt + P` |
| 停止录制 | `Shift + ⌘ + S` | `Shift + Alt + S` |

## 浏览器兼容性

- Chrome 90+
- Edge 90+
- 理论上兼容所有基于 Chromium 的浏览器

## 隐私特性

- ✅ 所有录制数据**仅在本地处理**
- ✅ **不上传**任何数据到云端
- ✅ 无需注册账号
- ✅ 不需要网络连接（除首次 ffmpeg 加载外）

## 项目结构

```
SnapCast/
├── manifest.json          # 扩展清单（权限、资源声明）
├── background.js          # Service Worker（状态管理、消息路由）
├── popup.html             # 弹出窗口 UI
├── popup.css              # 弹出窗口样式
├── popup.js               # 弹出窗口逻辑
├── content.js             # 内容脚本（核心录制逻辑）
├── content.css            # 悬浮工具栏样式
├── recorder.html          # 独立录制器页面（旧版方案）
├── recorder.css           # 录制器样式
├── recorder.js            # 录制器逻辑（含 ffmpeg MP4 转码）
├── video-camera.png       # 扩展图标
├── vendor/                # ffmpeg.wasm 依赖
│   ├── ffmpeg.js          # FFmpeg UMD 入口
│   ├── ffmpeg-util.js     # fetchFile 工具
│   ├── ffmpeg-core.js     # ffmpeg 核心 JS
│   ├── ffmpeg-core.wasm   # ffmpeg 核心 WASM (~32MB)
│   └── 814.ffmpeg.js      # ffmpeg worker
├── LoomLite.md            # 设计文档（架构、PRD）
├── Optimize.md            # 架构优化建议（Code Review）
└── README.md              # 本文件
```

## 已知限制

- ffmpeg.wasm 转码 MP4 时首次加载较慢（约 32MB 的 WASM 文件）
- 部分网站（如 chrome:// 页面）无法注入内容脚本，不支持录制
- Service Worker 休眠后需要从 storage 恢复状态

## 许可

MIT
