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
| ⌨️ **全局快捷键** | `⇧⌘P` 暂停/继续、`⇧⌘S` 停止录制、`⇧⌘A` 切换标注（Mac）；Windows 使用 `Shift+Alt+P/S/A` |
| ⏳ **3 秒倒计时** | 开始录制前显示倒计时蒙层，确保录制从正确时刻开始 |
| 🎯 **悬浮工具栏** | 注入目标页面的浮动控制条，录制时自动隐藏，不污染画面 |
| 🌓 **暗色界面** | 精心设计的暗色 UI，状态指示清晰 |
| ✏️ **屏幕标注工具** | 录制中实时绘制标注（画笔、荧光笔、箭头、圆形高亮），标注**直接合入录制画面** |
| 📐 **区域录制** | 开始录制前拖拽选择矩形区域，只录制该区域内容，而非整个屏幕 |

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
| **内容脚本** | `content.js / content.css` | 注入目标页面，渲染悬浮工具栏和摄像头泡泡，执行实际录制；包含 Canvas 合成层、标注工具、区域选择逻辑 |

## 技术栈

- **平台**：Chrome Extension Manifest V3
- **语言**：原生 JavaScript (ES6+)
- **API**：
  - `navigator.mediaDevices.getDisplayMedia()` — 屏幕捕获
  - `navigator.mediaDevices.getUserMedia()` — 摄像头/麦克风
  - `canvas.captureStream()` — Canvas 视频合成
  - `MediaRecorder` — 视频录制
  - `AudioContext` — 多路音频混音
  - `PointerEvent` — 标注工具触摸/鼠标事件捕获
  - `chrome.downloads` — 文件下载
  - `chrome.commands` — 全局快捷键
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

1. **配置选项**：在 popup 中设置麦克风、摄像头；可开启「📐 指定录制区域」
2. **区域选择**（可选）：开启区域录制后，进入全屏蒙层拖拽绘制矩形选区，确认后继续
3. **开始录制**：点击「开始录制」，在弹出的对话框中选择录制范围
4. **倒计时**：选择屏幕后显示 3 秒倒计时
5. **录制中**：悬浮工具栏自动隐藏，鼠标移到页面顶部可查看
6. **屏幕标注**：录制中可使用左侧悬浮标注工具栏实时绘制标注，`Ctrl+Z` 撤销最后一笔
7. **暂停 / 停止**：通过快捷键或悬浮工具栏控制
8. **自动下载**：停止录制后自动下载到本地（所有标注已合入画面）

## 快捷键

| 操作 | Mac | Windows/Linux |
|------|-----|---------------|
| 暂停 / 继续录制 | `Shift + ⌘ + P` | `Shift + Alt + P` |
| 停止录制并下载 | `Shift + ⌘ + S` | `Shift + Alt + S` |
| 开启 / 关闭标注模式 | `Shift + ⌘ + A` | `Shift + Alt + A` |
| 撤销最后一笔标注 | `⌘ + Z`（标注激活时） | `Ctrl + Z`（标注激活时） |
| 取消区域选择 | `Esc` | `Esc` |

## 浏览器兼容性

- Chrome 90+
- Edge 90+
- 理论上兼容所有基于 Chromium 的浏览器

## 隐私特性

- ✅ 所有录制数据**仅在本地处理**
- ✅ **不上传**任何数据到云端
- ✅ 无需注册账号
- ✅ 完全离线运行，不需要任何网络连接

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
├── video-camera.png       # 扩展图标
└── README.md              # 本文件
```

## 已知限制

- 输出格式仅支持 **WebM**（Chrome MediaRecorder 原生格式），不支持 MP4
- 部分网站（如 chrome:// 页面）无法注入内容脚本，不支持录制
- Service Worker 休眠后需要从 storage 恢复状态
- 摄像头背景虚化依赖 Chrome 94+ 的 `backgroundBlur` 约束，低版本浏览器不可用
- 区域录制在 Retina 屏（devicePixelRatio = 2）下依赖 DPR 坐标换算，截取精度受系统缩放比影响

## 许可

MIT
