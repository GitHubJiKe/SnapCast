const statusBadge = document.getElementById("statusBadge");
const elapsed = document.getElementById("elapsed");
const hint = document.getElementById("hint");

const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");

let currentState = {
  status: "idle",
  startedAt: null,
  error: null,
  hasRecorder: false
};

let ticker = null;

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "00:00";
  }
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function setBadge(status) {
  const map = {
    idle: { text: "空闲", className: "idle" },
    preparing: { text: "准备中", className: "preparing" },
    recording: { text: "录制中", className: "recording" },
    paused: { text: "已暂停", className: "paused" },
    error: { text: "异常", className: "error" }
  };
  const target = map[status] || map.idle;
  statusBadge.textContent = target.text;
  statusBadge.className = `badge ${target.className}`;
}

function updateElapsed() {
  if (currentState.status === "recording" || currentState.status === "paused") {
    if (currentState.startedAt) {
      elapsed.textContent = formatMs(Date.now() - currentState.startedAt);
    }
    return;
  }
  elapsed.textContent = "00:00";
}

function ensureTicker() {
  if (ticker) {
    return;
  }
  ticker = setInterval(updateElapsed, 1000);
}

function stopTicker() {
  if (!ticker) {
    return;
  }
  clearInterval(ticker);
  ticker = null;
}

function applyState(state) {
  currentState = {
    ...currentState,
    ...state
  };

  setBadge(currentState.status);

  if (currentState.status === "recording" || currentState.status === "paused") {
    ensureTicker();
  } else {
    stopTicker();
  }

  updateElapsed();

  const isIdle = currentState.status === "idle";
  const isRecording = currentState.status === "recording";
  const isPaused = currentState.status === "paused";
  const isPreparing = currentState.status === "preparing";

  startBtn.disabled = isRecording || isPaused || isPreparing;
  pauseBtn.disabled = !isRecording && !isPaused;
  stopBtn.disabled = isIdle || isPreparing;

  pauseBtn.textContent = isPaused ? "继续" : "暂停";

  if (currentState.status === "error") {
    hint.textContent = currentState.error || "发生异常，请重试。";
  } else if (isPreparing) {
    hint.textContent = "请在新打开的录制窗口中授权屏幕/摄像头权限。";
  } else if (isIdle) {
    hint.textContent = "点击开始录制后会打开独立录制窗口。";
  } else {
    hint.textContent = "录制中可随时暂停或停止，停止后将自动下载。";
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response || response.ok !== true) {
        reject(new Error(response && response.error ? response.error : "请求失败"));
        return;
      }
      resolve(response);
    });
  });
}

async function initializeState() {
  try {
    const response = await sendMessage({ type: "REQUEST_STATE" });
    applyState(response.state || {});
  } catch (error) {
    applyState({ status: "error", error: error.message });
  }
}

startBtn.addEventListener("click", async () => {
  applyState({ status: "preparing", error: null });
  try {
    const response = await sendMessage({ type: "OPEN_RECORDER", autoStart: true });
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

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "STATE_CHANGED") {
    return;
  }
  applyState(message.state || {});
});

initializeState();
