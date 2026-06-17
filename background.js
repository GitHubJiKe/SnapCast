/**
 * SnapCast — Background Service Worker (v2)
 *
 * 新架构（Screenity 风格）：
 *  - 不再创建独立 recorder 窗口
 *  - popup 点击「开始录制」→ background 向当前 tab 注入 content.js
 *  - content.js 在目标页面内调用 getDisplayMedia + 渲染悬浮工具栏
 *  - background 负责：状态管理、消息路由、文件下载
 */

// ── 状态 ──────────────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  status: "idle",
  startedAt: null,
  error: null,
  targetTabId: null,
  lastUpdated: Date.now()
};

let runtimeState = { ...DEFAULT_STATE };
let targetTabId  = null; // 正在录制的 tab（同时持久化到 storage，防止 SW 休眠后丢失）

// ── 持久化 ────────────────────────────────────────────────────────────────────
function mergeState(patch) {
  runtimeState = { ...runtimeState, ...patch, lastUpdated: Date.now() };
  chrome.storage.local.set({ snapCastState: runtimeState });
  // 广播给 popup
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state: runtimeState }).catch(() => {});
}

// targetTabId 持久化：Service Worker 随时可能休眠，内存变量会丢失
// 快捷键触发时 SW 刚被唤醒，必须从 storage 恢复 targetTabId
function saveTargetTabId(tabId) {
  targetTabId = tabId;
  chrome.storage.local.set({ snapCastTargetTabId: tabId });
}

async function getTargetTabId() {
  if (targetTabId !== null) return targetTabId;
  // 内存里没有，从 storage 恢复
  const result = await chrome.storage.local.get(["snapCastTargetTabId"]);
  targetTabId = result.snapCastTargetTabId ?? null;
  return targetTabId;
}

function loadStateFromStorage() {
  chrome.storage.local.get(["snapCastState", "snapCastTargetTabId"], (result) => {
    const stored = result.snapCastState;
    if (stored && typeof stored === "object") {
      runtimeState = { ...DEFAULT_STATE, ...stored, status: "idle", error: null };
    }
    // 恢复 targetTabId（录制中途 SW 重启时保持快捷键可用）
    if (result.snapCastTargetTabId) {
      targetTabId = result.snapCastTargetTabId;
    }
    chrome.storage.local.set({ snapCastState: runtimeState });
  });
}

// ── Tab 监听：录制 tab 关闭时重置状态 ────────────────────────────────────────
// #3 修复：SW 重启后内存变量 targetTabId 为 null，必须从 storage 异步读取再比较，
// 否则关闭录制 tab 时永远命中不到，popup 会一直显示"录制中"。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const storedId = await getTargetTabId();
  if (tabId !== storedId) return;
  saveTargetTabId(null);
  chrome.storage.local.remove("snapCastTargetTabId");
  mergeState({ ...DEFAULT_STATE });
});

// ── 工具：向 content script 发送消息 ─────────────────────────────────────────
function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(resp);
    });
  });
}

// ── 工具：注入 content script（如果尚未注入） ─────────────────────────────────
async function ensureContentInjected(tabId) {
  // 先探测是否已注入（发消息，有响应说明已注入）
  try {
    const resp = await sendToContent(tabId, { type: "SC_GET_STATUS" });
    if (resp && resp.ok) return; // 已注入，直接返回
  } catch (_) {}

  // 尚未注入：先注册 CONTENT_READY 监听器，再注入脚本
  // 顺序必须是：先监听 → 再注入，否则 content.js 发出信号时监听器还未就绪
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onReady);
      // 超时兜底：再尝试一次轮询，避免因消息时序问题误报超时
      sendToContent(tabId, { type: "SC_GET_STATUS" })
        .then(resp => {
          if (resp && resp.ok) resolve();
          else reject(new Error("content.js 注入后无响应，请刷新页面重试"));
        })
        .catch(() => reject(new Error("content.js 注入后无响应，请刷新页面重试")));
    }, 4000);

    function onReady(msg, sender) {
      // 必须验证是来自目标 tab 的消息
      if (msg && msg.type === "CONTENT_READY" && sender.tab && sender.tab.id === tabId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onReady);
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(onReady);
  });

  // 注入脚本（监听器已就绪，不会错过 CONTENT_READY）
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  // 等待 CONTENT_READY 或超时兜底
  await readyPromise;
}

// ── 安装初始化 ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ snapCastState: { ...DEFAULT_STATE } });
});

// ── 全局快捷键处理 ────────────────────────────────────────────────────────────
// 注意：SW 被快捷键唤醒时内存变量可能已被清空，必须从 storage 异步读取 targetTabId
chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await getTargetTabId();
  if (!tabId) {
    console.warn("SnapCast: 快捷键触发但无可用录制标签页");
    return;
  }

  if (command === "toggle-pause") {
    sendToContent(tabId, { type: "SC_PAUSE" }).catch((e) => console.warn("SnapCast: 快捷键暂停失败", e));
  } else if (command === "stop-recording") {
    sendToContent(tabId, { type: "SC_STOP" }).catch((e) => console.warn("SnapCast: 快捷键停止失败", e));
  } else if (command === "toggle-annotation") {
    sendToContent(tabId, { type: "SC_TOGGLE_ANNOT" }).catch((e) => console.warn("SnapCast: 快捷键标注切换失败", e));
  }
});

// ── 消息路由 ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  // ── popup → 开始录制 ───────────────────────────────────────────────────
  if (message.type === "OPEN_RECORDER") {
    const config  = message.config  || {};
    const tabId   = message.tabId;
    const tabUrl  = message.tabUrl  || "";

    // popup 已在发送前查好 tabId，这里直接使用
    if (!tabId) {
      mergeState({ status: "error", error: "未收到目标标签页 ID" });
      sendResponse({ ok: false, error: "未收到目标标签页 ID", state: runtimeState });
      return;
    }

    // 不允许在扩展页面、chrome:// 页面注入
    if (tabUrl.startsWith("chrome://") || tabUrl.startsWith("chrome-extension://")) {
      mergeState({ status: "error", error: "无法在此页面录制，请切换到普通网页" });
      sendResponse({ ok: false, error: "无法在此页面录制", state: runtimeState });
      return;
    }

    saveTargetTabId(tabId);
    mergeState({ status: "preparing", targetTabId: tabId });

    // 异步注入并启动（不阻塞 sendResponse）
    ensureContentInjected(tabId)
      .then(() => sendToContent(tabId, { type: "SC_START", config }))
      .then(() => {
        sendResponse({ ok: true, state: runtimeState });
      })
      .catch((err) => {
        mergeState({ status: "error", error: err.message });
        sendResponse({ ok: false, error: err.message, state: runtimeState });
      });

    return true; // 异步响应
  }

  // ── popup → 查询状态 ───────────────────────────────────────────────────
  if (message.type === "REQUEST_STATE") {
    sendResponse({ ok: true, state: runtimeState });
    return;
  }

  // ── content → 上报状态变化 ────────────────────────────────────────────
  if (message.type === "STATE_UPDATE") {
    if (message.state && typeof message.state === "object") {
      mergeState(message.state);
    }
    sendResponse({ ok: true });
    return;
  }

  // ── popup → 暂停/继续/停止 ────────────────────────────────────────────
  if (message.type === "CONTROL_RECORDING") {
    const cmd = message.command;
    const msgType = cmd === "pause"  ? "SC_PAUSE"
                  : cmd === "resume" ? "SC_PAUSE"  // content 内部自动切换
                  : cmd === "stop"   ? "SC_STOP"
                  : null;

    if (!msgType) { sendResponse({ ok: false, error: "未知命令" }); return; }

    // 从 storage 读取以应对 SW 重启后内存变量丢失的场景
    getTargetTabId().then(tabId => {
      if (!tabId) {
        sendResponse({ ok: false, error: "没有正在录制的标签页" });
        return;
      }
      sendToContent(tabId, { type: msgType })
        .then(() => sendResponse({ ok: true, state: runtimeState }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
    });

    return true;
  }

  // ── content → 下载录制文件 ────────────────────────────────────────────
  // content script 无法直接调用 chrome.downloads，委托给 background
  if (message.type === "DOWNLOAD_RECORDING") {
    const { dataUrl, filename } = message;
    if (!dataUrl || !filename) { sendResponse({ ok: false }); return; }

    chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        sendResponse({ ok: false, error: err.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
      // 下载触发后重置状态
      mergeState({ ...DEFAULT_STATE });
      saveTargetTabId(null);
      chrome.storage.local.remove("snapCastTargetTabId");
    });

    return true;
  }

  // ── content → 注入完成信号（在 ensureContentInjected 内处理，这里兜底） ─
  if (message.type === "CONTENT_READY") {
    sendResponse({ ok: true });
    return;
  }
});

// ── 初始化 ────────────────────────────────────────────────────────────────────
loadStateFromStorage();
