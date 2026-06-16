// ── DOM ───────────────────────────────────────────────────────────────────────
const statusBadge   = document.getElementById("statusBadge");
const elapsed       = document.getElementById("elapsed");
const hint          = document.getElementById("hint");
const configSection = document.getElementById("configSection");

const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn  = document.getElementById("stopBtn");

const micToggle    = document.getElementById("micToggle");
const cameraToggle = document.getElementById("cameraToggle");

// ── 状态 ─────────────────────────────────────────────────────────────────────
let currentState = { status: "idle", startedAt: null, error: null };
let ticker = null;

// ── 工具 ─────────────────────────────────────────────────────────────────────
function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function getConfig() {
  const fmt = document.querySelector('input[name="outputFormat"]:checked');
  return {
    mic:    micToggle.checked,
    camera: cameraToggle.checked,
    format: fmt ? fmt.value : "webm"
  };
}

// ── 界面更新 ──────────────────────────────────────────────────────────────────
const BADGE_MAP = {
  idle:      { text: "空闲",  cls: "idle" },
  preparing: { text: "准备中", cls: "preparing" },
  recording: { text: "录制中", cls: "recording" },
  paused:    { text: "已暂停", cls: "paused" },
  error:     { text: "异常",  cls: "error" }
};

const isMac = navigator.platform.toUpperCase().includes("MAC");
const shortcutPause = isMac ? "⇧⌘P" : "Shift+Alt+P";
const shortcutStop  = isMac ? "⇧⌘S" : "Shift+Alt+S";

const HINT_MAP = {
  idle:      "配置好选项后，点击开始录制。",
  preparing: "请在弹出的屏幕共享选择器中选择录制范围。",
  recording: `工具栏录制时自动隐藏。快捷键：${shortcutPause} 暂停 · ${shortcutStop} 停止`,
  paused:    `录制已暂停。快捷键：${shortcutPause} 继续 · ${shortcutStop} 停止`,
  error:     null // 使用 error 字段
};

function applyState(state) {
  currentState = { ...currentState, ...state };
  const s = currentState.status;

  // Badge
  const badge = BADGE_MAP[s] || BADGE_MAP.idle;
  statusBadge.textContent = badge.text;
  statusBadge.className = `badge ${badge.cls}`;

  // Hint
  hint.textContent = s === "error"
    ? (currentState.error || "发生异常，请重试。")
    : (HINT_MAP[s] || HINT_MAP.idle);

  // 按钮状态
  const isIdle      = s === "idle";
  const isRecording = s === "recording";
  const isPaused    = s === "paused";
  const isPreparing = s === "preparing";

  startBtn.disabled = isRecording || isPaused || isPreparing;
  pauseBtn.disabled = !isRecording && !isPaused;
  stopBtn.disabled  = isIdle || isPreparing;
  pauseBtn.textContent = isPaused ? "继续" : "暂停";

  // 配置区：只在空闲时显示
  configSection.classList.toggle("hidden", !isIdle);

  // 计时器
  if (isRecording || isPaused) {
    if (!ticker) ticker = setInterval(updateElapsed, 1000);
  } else {
    if (ticker) { clearInterval(ticker); ticker = null; }
    elapsed.textContent = "00:00";
  }
  updateElapsed();
}

function updateElapsed() {
  if (currentState.status === "recording" || currentState.status === "paused") {
    if (currentState.startedAt) {
      elapsed.textContent = formatMs(Date.now() - currentState.startedAt);
    }
  }
}

// ── 消息发送 ──────────────────────────────────────────────────────────────────
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      if (!response || response.ok !== true) {
        reject(new Error(response && response.error ? response.error : "请求失败"));
        return;
      }
      resolve(response);
    });
  });
}

// ── 按钮事件 ──────────────────────────────────────────────────────────────────
startBtn.addEventListener("click", async () => {
  applyState({ status: "preparing", error: null });
  try {
    // 先查询当前激活的 tab，由 popup 负责传入，避免 background 查询时 popup 已关闭
    const tabs = await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, res));
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      applyState({ status: "error", error: "无法获取当前标签页" });
      return;
    }
    const response = await sendMessage({
      type: "OPEN_RECORDER",
      tabId: tab.id,
      tabUrl: tab.url,
      config: getConfig()
    });
    applyState(response.state || { status: "preparing" });
  } catch (error) {
    applyState({ status: "error", error: error.message });
  }
});

pauseBtn.addEventListener("click", async () => {
  const command = currentState.status === "paused" ? "resume" : "pause";
  try {
    const response = await sendMessage({ type: "CONTROL_RECORDING", command });
    applyState(response.state || {});
  } catch (error) {
    applyState({ status: "error", error: error.message });
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    const response = await sendMessage({ type: "CONTROL_RECORDING", command: "stop" });
    applyState(response.state || {});
  } catch (error) {
    applyState({ status: "error", error: error.message });
  }
});

// ── 被动接收状态推送 ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "STATE_CHANGED") {
    applyState(message.state || {});
  }
});

// ── 初始化 ────────────────────────────────────────────────────────────────────
async function initializeState() {
  try {
    const response = await sendMessage({ type: "REQUEST_STATE" });
    applyState(response.state || {});
  } catch (_) {
    applyState({ status: "idle" });
  }
}

initializeState();
