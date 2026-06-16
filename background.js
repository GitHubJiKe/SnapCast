const RECORDER_URL = chrome.runtime.getURL("recorder.html");

const DEFAULT_STATE = {
  status: "idle",
  startedAt: null,
  error: null,
  hasRecorder: false,
  lastUpdated: Date.now()
};

let runtimeState = { ...DEFAULT_STATE };
let recorderTabId = null;
let recorderWindowId = null;
let recorderReady = false;
let pendingStart = false;

// ── o4: Service Worker 生命周期修复 ─────────────────────────────────────────
// SW 可能被 Chrome 随时挂起（idle ~30s 后），挂起后内存变量全部丢失。
// 每次消息到来时先从 storage 重新同步 runtimeState，
// 同时通过 queryRecorderTab 检查 recorder 窗口是否仍然存在，恢复 recorderTabId。
let stateRestored = false;

async function ensureStateRestored() {
  if (stateRestored) {
    return;
  }
  stateRestored = true;

  await new Promise((resolve) => {
    chrome.storage.local.get(["snapCastState"], (result) => {
      if (result.snapCastState && typeof result.snapCastState === "object") {
        runtimeState = {
          ...DEFAULT_STATE,
          ...result.snapCastState,
          // 无法恢复实时流对象，将 hasRecorder 置为 false 再重新探测
          hasRecorder: false,
          lastUpdated: Date.now()
        };
      }
      resolve();
    });
  });

  // 重新探测 recorder 窗口是否还活着
  const existingTab = await queryRecorderTab();
  if (existingTab && typeof existingTab.id === "number") {
    recorderTabId = existingTab.id;
    recorderWindowId = existingTab.windowId;
    recorderReady = true;
    mergeState({ hasRecorder: true });
  } else {
    recorderTabId = null;
    recorderWindowId = null;
    recorderReady = false;
    // 若 storage 中记录了录制中状态但窗口已丢失，重置为 idle
    if (runtimeState.status !== "idle") {
      mergeState({ status: "idle", startedAt: null, hasRecorder: false, error: "录制窗口在后台已关闭" });
    }
  }
}

function mergeState(patch) {
  runtimeState = {
    ...runtimeState,
    ...patch,
    lastUpdated: Date.now()
  };

  chrome.storage.local.set({ snapCastState: runtimeState });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state: runtimeState }, () => {
    void chrome.runtime.lastError;
  });
}

function loadStateFromStorage() {
  chrome.storage.local.get(["snapCastState"], (result) => {
    const stored = result.snapCastState;
    if (stored && typeof stored === "object") {
      runtimeState = {
        ...DEFAULT_STATE,
        ...stored,
        hasRecorder: false,
        status: "idle",
        error: null,
        lastUpdated: Date.now()
      };
    }
    chrome.storage.local.set({ snapCastState: runtimeState });
  });
}

function queryRecorderTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: RECORDER_URL }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err || !Array.isArray(tabs) || tabs.length === 0) {
        resolve(null);
        return;
      }
      resolve(tabs[0]);
    });
  });
}

function focusRecorderWindow() {
  if (!recorderWindowId) {
    return;
  }
  chrome.windows.update(recorderWindowId, { focused: true }, () => {
    void chrome.runtime.lastError;
  });
}

function createRecorderWindow() {
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: RECORDER_URL,
        type: "popup",
        width: 520,
        height: 760,
        focused: true
      },
      (createdWindow) => {
        const err = chrome.runtime.lastError;
        if (err || !createdWindow) {
          reject(new Error(err ? err.message : "无法创建录制窗口"));
          return;
        }
        resolve(createdWindow);
      }
    );
  });
}

async function ensureRecorderWindow() {
  const existingTab = await queryRecorderTab();
  if (existingTab && typeof existingTab.id === "number") {
    recorderTabId = existingTab.id;
    recorderWindowId = existingTab.windowId;
    mergeState({ hasRecorder: true });
    focusRecorderWindow();
    return;
  }

  const createdWindow = await createRecorderWindow();
  recorderWindowId = createdWindow.id;
  recorderReady = false;

  const createdTab = Array.isArray(createdWindow.tabs) ? createdWindow.tabs[0] : null;
  if (createdTab && typeof createdTab.id === "number") {
    recorderTabId = createdTab.id;
  } else {
    const fallbackTab = await queryRecorderTab();
    recorderTabId = fallbackTab && typeof fallbackTab.id === "number" ? fallbackTab.id : null;
  }

  mergeState({ hasRecorder: true });
}

function sendCommandToRecorder(command) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "RECORDER_CONTROL",
        target: "recorder",
        command
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        if (!response || response.ok !== true) {
          reject(new Error(response && response.error ? response.error : "录制窗口无响应"));
          return;
        }
        resolve(response);
      }
    );
  });
}

function clearRecorderHandles() {
  recorderTabId = null;
  recorderWindowId = null;
  recorderReady = false;
  pendingStart = false;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ snapCastState: { ...DEFAULT_STATE } });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== recorderTabId) {
    return;
  }

  clearRecorderHandles();
  mergeState({
    status: "idle",
    startedAt: null,
    hasRecorder: false,
    error: "录制窗口已关闭"
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== recorderWindowId) {
    return;
  }

  clearRecorderHandles();
  mergeState({
    status: "idle",
    startedAt: null,
    hasRecorder: false,
    error: "录制窗口已关闭"
  });
});

// ── o4: SW 每次重新被激活（执行首行代码）时，stateRestored 就是 false，
//        因为 SW 重启后所有模块级变量都重置了，不需要额外重置。
//        只需在每个异步 handler 入口调用 ensureStateRestored() 即可。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "OPEN_RECORDER") {
    pendingStart = Boolean(message.autoStart);

    ensureStateRestored()
      .then(() => ensureRecorderWindow())
      .then(async () => {
        if (pendingStart && recorderReady) {
          await sendCommandToRecorder("start");
          pendingStart = false;
        }
        sendResponse({ ok: true, state: runtimeState });
      })
      .catch((error) => {
        mergeState({ status: "error", error: error.message });
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === "REQUEST_STATE") {
    ensureStateRestored()
      .then(() => {
        sendResponse({ ok: true, state: runtimeState });
      })
      .catch(() => {
        sendResponse({ ok: true, state: runtimeState });
      });
    return true;
  }

  if (message.type === "STATE_UPDATE") {
    if (message.state && typeof message.state === "object") {
      mergeState(message.state);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "RECORDER_READY") {
    recorderReady = true;
    stateRestored = true; // recorder 窗口刚启动，视为状态已恢复

    if (sender.tab && typeof sender.tab.id === "number") {
      recorderTabId = sender.tab.id;
      recorderWindowId = sender.tab.windowId;
    }

    mergeState({ hasRecorder: true });

    if (pendingStart) {
      sendCommandToRecorder("start")
        .then(() => {
          pendingStart = false;
          sendResponse({ ok: true, state: runtimeState });
        })
        .catch((error) => {
          pendingStart = false;
          mergeState({ status: "error", error: error.message });
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    sendResponse({ ok: true, state: runtimeState });
    return;
  }

  if (message.type === "CONTROL_RECORDING") {
    ensureStateRestored()
      .then(() => sendCommandToRecorder(message.command))
      .then((response) => {
        sendResponse({ ok: true, state: runtimeState, response });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }
});

loadStateFromStorage();
