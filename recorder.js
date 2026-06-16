const mixCanvas = document.getElementById("mixCanvas");
const ctx = mixCanvas.getContext("2d", { alpha: false });
const screenVideo = document.getElementById("screenPreview");
const cameraVideo = document.getElementById("cameraPreview");
const pipOverlay = document.getElementById("pipDragOverlay");

const message = document.getElementById("message");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const timer = document.getElementById("timer");

const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");

const micToggle = document.getElementById("micToggle");
const cameraToggle = document.getElementById("cameraToggle");
const ffmpegStatus = document.getElementById("ffmpegStatus");
const ffmpegBar = document.getElementById("ffmpegBar");
const ffmpegLabel = document.getElementById("ffmpegLabel");

/** 获取用户当前选择的输出格式 */
function getOutputFormat() {
  const checked = document.querySelector('input[name="outputFormat"]:checked');
  return checked ? checked.value : "webm";
}

// ── ffmpeg 本地文件路径（vendor 目录预置，不依赖 CDN）────────────────────────
const VENDOR_BASE = chrome.runtime.getURL("vendor");

let ffmpegInstance = null;     // 已加载的 FFmpeg 实例（懒加载后复用）
let ffmpegLoading = false;     // 防止并发重复加载

function setFfmpegProgress(percent, label) {
  ffmpegStatus.classList.remove("hidden");
  ffmpegBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  ffmpegLabel.textContent = label;
}

function hideFfmpegStatus() {
  ffmpegStatus.classList.add("hidden");
  ffmpegBar.style.width = "0%";
  ffmpegLabel.textContent = "准备中...";
}

/**
 * 动态插入 <script src> 加载 UMD 脚本，返回 Promise。
 * UMD 格式会把导出挂到 window 上，用 script 标签是最兼容的方式。
 * MV3 的 script-src 允许 'self'，插件内部文件均视为 self。
 */
function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`脚本加载失败: ${url}`));
    document.head.appendChild(script);
  });
}

async function loadFfmpeg() {
  if (ffmpegInstance) {
    return ffmpegInstance;
  }
  if (ffmpegLoading) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (!ffmpegLoading) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    return ffmpegInstance;
  }

  ffmpegLoading = true;
  setFfmpegProgress(0, "正在加载 ffmpeg（首次使用约需几秒）...");

  try {
    // 加载 UMD 脚本，会把 FFmpeg / fetchFile 挂到 window 上
    setFfmpegProgress(10, "正在加载 ffmpeg.js...");
    await loadScript(`${VENDOR_BASE}/ffmpeg.js`);

    setFfmpegProgress(25, "正在加载 ffmpeg-util.js...");
    await loadScript(`${VENDOR_BASE}/ffmpeg-util.js`);

    // UMD 格式：window.FFmpegWASM.FFmpeg / window.FFmpegUtil.fetchFile
    const FFmpeg = window.FFmpegWASM?.FFmpeg || window.FFmpeg?.FFmpeg;
    const fetchFile = window.FFmpegUtil?.fetchFile || window.FFmpegWASM?.fetchFile;

    if (!FFmpeg) {
      throw new Error("ffmpeg.js 加载后未找到 FFmpeg 构造函数，请检查 vendor/ffmpeg.js");
    }
    if (!fetchFile) {
      throw new Error("ffmpeg-util.js 加载后未找到 fetchFile，请检查 vendor/ffmpeg-util.js");
    }

    const ffmpeg = new FFmpeg();

    ffmpeg.on("progress", ({ progress }) => {
      const pct = Math.round(progress * 100);
      setFfmpegProgress(pct, `转码中... ${pct}%`);
    });

    setFfmpegProgress(50, "正在初始化 ffmpeg 核心（首次加载 ~31MB wasm）...");
    await ffmpeg.load({
      coreURL: `${VENDOR_BASE}/ffmpeg-core.js`,
      wasmURL: `${VENDOR_BASE}/ffmpeg-core.wasm`
    });

    setFfmpegProgress(100, "ffmpeg 加载完成 ✓");
    ffmpegInstance = { ffmpeg, fetchFile };
    return ffmpegInstance;
  } finally {
    ffmpegLoading = false;
  }
}

async function convertToMp4(webmBlob) {
  const { ffmpeg, fetchFile } = await loadFfmpeg();

  setFfmpegProgress(0, "正在写入源文件...");
  await ffmpeg.writeFile("input.webm", await fetchFile(webmBlob));

  setFfmpegProgress(5, "开始转码为 MP4...");
  // -c:v libx264: 转为 H.264，QuickTime / iOS / 微信全平台兼容
// -preset ultrafast: 最快编码速度（牺牲少量压缩率）
// -crf 23: 画质控制（0=无损, 51=最差，23 是默认平衡值）
// -c:a aac: 音频转 AAC
// -movflags +faststart: MP4 头部前置，支持边下边播
await ffmpeg.exec([
  "-i", "input.webm",
  "-c:v", "libx264",
  "-preset", "ultrafast",
  "-crf", "23",
  "-c:a", "aac",
  "-movflags", "+faststart",
  "output.mp4"
]);

  setFfmpegProgress(98, "正在读取输出文件...");
  const data = await ffmpeg.readFile("output.mp4");

  // 清理临时文件
  try {
    await ffmpeg.deleteFile("input.webm");
    await ffmpeg.deleteFile("output.mp4");
  } catch (_) {}

  setFfmpegProgress(100, "转码完成");
  return new Blob([data.buffer], { type: "video/mp4" });
}

let screenStream = null;
let cameraStream = null;
let micStream = null;
let mixedStream = null;
let audioCtx = null;       // AudioContext 用于多路混音
let audioDestNode = null;  // MediaStreamAudioDestinationNode
let recorder = null;
let chunks = [];
let drawReq = null;
let timerId = null;
let status = "idle";

let startedAt = null;
let pausedDuration = 0;
let pausedAt = null;

// ── PiP 拖动状态 ──────────────────────────────────────────────────────────
// pipPos 存储的是「画布坐标系」中 pip 左上角的位置，取值范围 [0, 1)（归一化）
// 默认右下角，距边缘约 2%
const PIP_DEFAULT = { rx: 0.75, ry: 0.73 }; // 右下归一化基准（以画布宽高为 1）

let pipNormX = PIP_DEFAULT.rx; // pip 左上角 x / canvasWidth
let pipNormY = PIP_DEFAULT.ry; // pip 左上角 y / canvasHeight

let isDragging = false;
let dragOffsetNormX = 0; // 按下点相对 pip 左上角的偏移（归一化）
let dragOffsetNormY = 0;

/** 返回当前 pip 在画布中的像素矩形 */
function getPipRect() {
  const cw = mixCanvas.width;
  const ch = mixCanvas.height;
  const pipWidth = Math.floor(cw * 0.23);
  const pipHeight = Math.floor((pipWidth * 9) / 16);
  const x = Math.round(pipNormX * cw);
  const y = Math.round(pipNormY * ch);
  return { x, y, w: pipWidth, h: pipHeight };
}

/** 把 overlay 上的 clientXY 转换为画布像素坐标 */
function overlayToCanvas(clientX, clientY) {
  const rect = mixCanvas.getBoundingClientRect();
  const scaleX = mixCanvas.width / rect.width;
  const scaleY = mixCanvas.height / rect.height;
  return {
    cx: (clientX - rect.left) * scaleX,
    cy: (clientY - rect.top) * scaleY
  };
}

/** 判断画布点 (cx, cy) 是否落在 pip 区域内 */
function isInPip(cx, cy) {
  const { x, y, w, h } = getPipRect();
  return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
}

/** 钳位：确保 pip 不超出画布边界 */
function clampPipPos(nx, ny) {
  const cw = mixCanvas.width;
  const ch = mixCanvas.height;
  const { w, h } = getPipRect();
  const maxNx = (cw - w) / cw;
  const maxNy = (ch - h) / ch;
  return {
    nx: Math.max(0, Math.min(nx, maxNx)),
    ny: Math.max(0, Math.min(ny, maxNy))
  };
}

function initPipDrag() {
  pipOverlay.addEventListener("pointermove", (e) => {
    if (!cameraStream) {
      pipOverlay.style.cursor = "default";
      return;
    }
    const { cx, cy } = overlayToCanvas(e.clientX, e.clientY);
    if (!isDragging) {
      pipOverlay.style.cursor = isInPip(cx, cy) ? "grab" : "default";
      return;
    }
    // 拖动中：更新 pip 位置
    const cw = mixCanvas.width;
    const ch = mixCanvas.height;
    const newNx = (cx - dragOffsetNormX * cw) / cw;
    const newNy = (cy - dragOffsetNormY * ch) / ch;
    const clamped = clampPipPos(newNx, newNy);
    pipNormX = clamped.nx;
    pipNormY = clamped.ny;
  });

  pipOverlay.addEventListener("pointerdown", (e) => {
    if (!cameraStream) {
      return;
    }
    const { cx, cy } = overlayToCanvas(e.clientX, e.clientY);
    if (!isInPip(cx, cy)) {
      return;
    }
    isDragging = true;
    pipOverlay.setPointerCapture(e.pointerId);
    pipOverlay.style.cursor = "grabbing";
    const { x, y } = getPipRect();
    const cw = mixCanvas.width;
    const ch = mixCanvas.height;
    dragOffsetNormX = (cx - x) / cw;
    dragOffsetNormY = (cy - y) / ch;
    e.preventDefault();
  });

  const stopDrag = (e) => {
    if (!isDragging) {
      return;
    }
    isDragging = false;
    pipOverlay.releasePointerCapture(e.pointerId);
    pipOverlay.style.cursor = "grab";
  };

  pipOverlay.addEventListener("pointerup", stopDrag);
  pipOverlay.addEventListener("pointercancel", stopDrag);
}

function sendState(statePatch) {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: statePatch }, () => {
    void chrome.runtime.lastError;
  });
}

function setStatus(next, error = null) {
  status = next;

  statusDot.className = `dot ${next === "recording" ? "recording" : next === "paused" ? "paused" : "idle"}`;

  if (next === "idle") {
    statusText.textContent = "空闲";
  } else if (next === "preparing") {
    statusText.textContent = "准备中";
  } else if (next === "recording") {
    statusText.textContent = "录制中";
  } else if (next === "paused") {
    statusText.textContent = "已暂停";
  } else {
    statusText.textContent = "异常";
  }

  const patch = {
    status: next,
    startedAt,
    error
  };
  sendState(patch);

  const isIdle = next === "idle";
  const isRecording = next === "recording";
  const isPaused = next === "paused";
  const isPreparing = next === "preparing";

  startBtn.disabled = isRecording || isPaused || isPreparing;
  pauseBtn.disabled = !isRecording && !isPaused;
  stopBtn.disabled = isIdle || isPreparing;

  pauseBtn.textContent = isPaused ? "继续" : "暂停";
}

function formatMs(ms) {
  const sec = Math.floor(Math.max(ms, 0) / 1000);
  const min = String(Math.floor(sec / 60)).padStart(2, "0");
  const remain = String(sec % 60).padStart(2, "0");
  return `${min}:${remain}`;
}

function updateTimer() {
  if (!startedAt) {
    timer.textContent = "00:00";
    return;
  }

  const now = Date.now();
  const endTime = pausedAt || now;
  timer.textContent = formatMs(endTime - startedAt - pausedDuration);
}

function stopTimerLoop() {
  if (!timerId) {
    return;
  }
  clearInterval(timerId);
  timerId = null;
}

function startTimerLoop() {
  stopTimerLoop();
  timerId = setInterval(updateTimer, 1000);
}

function drawFrame() {
  const cw = mixCanvas.width;
  const ch = mixCanvas.height;

  ctx.fillStyle = "#0a0e15";
  ctx.fillRect(0, 0, cw, ch);

  if (screenVideo.readyState >= 2) {
    ctx.drawImage(screenVideo, 0, 0, cw, ch);
  }

  const shouldDrawCamera = Boolean(cameraStream && cameraToggle.checked && cameraVideo.readyState >= 2);
  if (shouldDrawCamera) {
    const { x, y, w: pipWidth, h: pipHeight } = getPipRect();

    // 阴影背景
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 2, y - 2, pipWidth + 4, pipHeight + 4);
    ctx.restore();

    ctx.drawImage(cameraVideo, x, y, pipWidth, pipHeight);

    // 拖动时显示高亮边框，其余时间显示普通白边
    ctx.strokeStyle = isDragging ? "rgba(43,102,255,0.95)" : "rgba(255,255,255,0.8)";
    ctx.lineWidth = isDragging ? 3 : 2;
    ctx.strokeRect(x, y, pipWidth, pipHeight);

    // 拖动提示角标（仅摄像头存在且未录制时显示，录制时不展示 UI 文字）
    if (!isDragging && status !== "recording" && status !== "paused") {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x, y + pipHeight - 20, pipWidth, 20);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = `${Math.max(10, Math.floor(pipHeight * 0.07))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("可拖动", x + pipWidth / 2, y + pipHeight - 6);
      ctx.textAlign = "left";
    }
  }

  drawReq = requestAnimationFrame(drawFrame);
}

function stopDrawLoop() {
  if (!drawReq) {
    return;
  }
  cancelAnimationFrame(drawReq);
  drawReq = null;
}

function stopTrackList(stream) {
  if (!stream) {
    return;
  }
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (error) {
      void error;
    }
  });
}

function releaseMedia() {
  stopTrackList(screenStream);
  stopTrackList(cameraStream);
  stopTrackList(micStream);
  stopTrackList(mixedStream);

  screenStream = null;
  cameraStream = null;
  micStream = null;
  mixedStream = null;

  // 关闭 AudioContext，释放音频引擎资源
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {});
  }
  audioCtx = null;
  audioDestNode = null;

  screenVideo.srcObject = null;
  cameraVideo.srcObject = null;
}

function resetRuntimeState() {
  stopDrawLoop();
  stopTimerLoop();
  releaseMedia();
  // 重置 canvas 尺寸回默认，避免下次录制前尺寸残留
  mixCanvas.width = 1280;
  mixCanvas.height = 720;

  // 重置 pip 位置到右下角默认值
  pipNormX = PIP_DEFAULT.rx;
  pipNormY = PIP_DEFAULT.ry;
  isDragging = false;

  recorder = null;
  chunks = [];
  startedAt = null;
  pausedDuration = 0;
  pausedAt = null;

  updateTimer();
  setStatus("idle");
  message.textContent = "等待开始录制。";
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename, saveAs: true },
      () => {
        const err = chrome.runtime.lastError;
        URL.revokeObjectURL(url);
        if (err) {
          reject(new Error(err.message));
        } else {
          resolve();
        }
      }
    );
  });
}

async function saveRecording() {
  if (!chunks.length) {
    message.textContent = "没有可保存的视频数据。";
    resetRuntimeState();
    return;
  }

  const webmBlob = new Blob(chunks, { type: "video/webm" });
  const format = getOutputFormat();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // 锁定按钮，防止重复触发
  startBtn.disabled = true;
  stopBtn.disabled = true;

  if (format === "webm") {
    message.textContent = "录制完成，正在触发下载...";
    try {
      await downloadBlob(webmBlob, `snapcast-${timestamp}.webm`);
      message.textContent = "WebM 文件已下载。";
    } catch (err) {
      message.textContent = `下载失败：${err.message}`;
    }
    hideFfmpegStatus();
    resetRuntimeState();
    return;
  }

  // MP4 路径：先下载 WebM 兜底，再转码
  message.textContent = "正在加载 ffmpeg，请稍候...";
  try {
    const mp4Blob = await convertToMp4(webmBlob);
    message.textContent = "转码完成，正在触发下载...";
    await downloadBlob(mp4Blob, `snapcast-${timestamp}.mp4`);
    message.textContent = "MP4 文件已下载。";
  } catch (err) {
    message.textContent = `MP4 转码失败（${err.message}），已改为下载原始 WebM。`;
    try {
      await downloadBlob(webmBlob, `snapcast-${timestamp}.webm`);
    } catch (_) {}
  } finally {
    hideFfmpegStatus();
    resetRuntimeState();
  }
}

async function prepareStreams() {
  message.textContent = "正在请求屏幕权限...";
  setStatus("preparing");

  const requestedScreen = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 30 }
    },
    audio: true
  });

  screenStream = requestedScreen;
  screenVideo.srcObject = screenStream;
  await screenVideo.play();

  // ── o5: 动态对齐 canvas 分辨率到屏幕实际分辨率 ──────────────────────
  const screenVideoTrack = screenStream.getVideoTracks()[0];
  if (screenVideoTrack) {
    const settings = screenVideoTrack.getSettings();
    if (settings.width && settings.height) {
      mixCanvas.width = settings.width;
      mixCanvas.height = settings.height;
    }
    // ── o2: 监听屏幕共享停止（用户点浏览器自带「停止共享」按钮）──────────
    screenVideoTrack.onended = () => {
      if (status === "recording" || status === "paused" || status === "preparing") {
        stopRecording();
      }
    };
  }

  // ── 用 AudioContext 做多路混音 ─────────────────────────────────────────
  // 原因：
  //   1. getDisplayMedia audio:true 在录制窗口/标签页时经常无音频轨道
  //   2. MediaRecorder 只录第一条音轨，多条需要手动 mix
  // 解决：把所有音频源接入 AudioContext destination，输出单一混音轨道
  audioCtx = new AudioContext();
  audioDestNode = audioCtx.createMediaStreamDestination();

  // 接入屏幕系统音频（用户选择录屏时勾选「分享系统音频」才有）
  const screenAudioTracks = screenStream.getAudioTracks();
  if (screenAudioTracks.length > 0) {
    const screenAudioStream = new MediaStream(screenAudioTracks);
    const screenSource = audioCtx.createMediaStreamSource(screenAudioStream);
    screenSource.connect(audioDestNode);
  }

  // 摄像头请求（audio:false，仅取视频）
  if (cameraToggle.checked) {
    message.textContent = "正在请求摄像头权限...";
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 }
        },
        audio: false
      });
      cameraVideo.srcObject = cameraStream;
      await cameraVideo.play();
    } catch (error) {
      cameraStream = null;
      message.textContent = "摄像头未授权，继续纯屏幕录制。";
    }
  }

  // 接入麦克风（单独申请，与摄像头无关）
  if (micToggle.checked) {
    message.textContent = "正在请求麦克风权限...";
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        },
        video: false
      });
      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(audioDestNode);
    } catch (error) {
      message.textContent = "麦克风未授权，将只录制系统声音（如有）。";
    }
  }

  // 取混音后的单一音轨
  const mixedAudioTrack = audioDestNode.stream.getAudioTracks()[0];

  // ── 用 canvas 输出视频轨道 + 混音音轨合成最终流 ──────────────────────
  const captureStream = mixCanvas.captureStream(30);
  const mixedVideoTrack = captureStream.getVideoTracks()[0];

  if (!mixedVideoTrack) {
    throw new Error("无法生成混合视频轨道");
  }

  const finalTracks = [mixedVideoTrack];
  if (mixedAudioTrack) {
    finalTracks.push(mixedAudioTrack);
  }
  mixedStream = new MediaStream(finalTracks);
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

function startRecorder() {
  const mimeType = pickMimeType();
  recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder.onerror = (event) => {
    const err = event.error ? event.error.message : "录制器发生未知错误";
    message.textContent = err;
    setStatus("error", err);
  };

  recorder.onstop = () => {
    saveRecording().catch((err) => {
      message.textContent = `保存失败：${err && err.message ? err.message : String(err)}`;
      hideFfmpegStatus();
      resetRuntimeState();
    });
  };

  recorder.start(1000);
}

async function startRecording() {
  if (status === "recording" || status === "paused" || status === "preparing") {
    return;
  }

  try {
    chunks = [];
    await prepareStreams();

    drawFrame();
    startRecorder();

    startedAt = Date.now();
    pausedDuration = 0;
    pausedAt = null;

    startTimerLoop();
    updateTimer();

    setStatus("recording");
    message.textContent = "正在录制，点击停止后自动下载。";
  } catch (error) {
    const text = error && error.message ? error.message : "启动录制失败";
    message.textContent = text;
    setStatus("error", text);
    releaseMedia();
    stopDrawLoop();
  }
}

function pauseRecording() {
  if (!recorder) {
    return;
  }

  if (status === "recording") {
    recorder.pause();
    pausedAt = Date.now();
    setStatus("paused");
    message.textContent = "录制已暂停。";
    return;
  }

  if (status === "paused") {
    recorder.resume();
    pausedDuration += Date.now() - pausedAt;
    pausedAt = null;
    setStatus("recording");
    message.textContent = "已恢复录制。";
  }
}

function stopRecording() {
  if (!recorder) {
    resetRuntimeState();
    return;
  }

  if (status === "paused" && pausedAt) {
    pausedDuration += Date.now() - pausedAt;
    pausedAt = null;
  }

  // ── o3: 先停止 draw/timer，再调 recorder.stop()；
  //        releaseMedia 移到 onstop（saveRecording）之后，确保最后一帧数据能写入 ──
  stopDrawLoop();
  stopTimerLoop();

  setStatus("idle");
  message.textContent = "正在整理视频并下载...";

  if (recorder.state !== "inactive") {
    recorder.stop();
    // releaseMedia 由 onstop → saveRecording → resetRuntimeState 负责
  } else {
    releaseMedia();
  }
}

function onControlCommand(command) {
  if (command === "start") {
    startRecording().catch((error) => {
      const text = error && error.message ? error.message : "启动录制失败";
      message.textContent = text;
      setStatus("error", text);
    });
    return;
  }

  if (command === "pause" || command === "resume") {
    pauseRecording();
    return;
  }

  if (command === "stop") {
    stopRecording();
  }
}

chrome.runtime.onMessage.addListener((messagePayload, sender, sendResponse) => {
  if (!messagePayload || messagePayload.type !== "RECORDER_CONTROL") {
    return;
  }

  onControlCommand(messagePayload.command);
  sendResponse({ ok: true });
});

startBtn.addEventListener("click", () => {
  startRecording().catch((error) => {
    const text = error && error.message ? error.message : "启动录制失败";
    message.textContent = text;
    setStatus("error", text);
  });
});

pauseBtn.addEventListener("click", () => {
  pauseRecording();
});

stopBtn.addEventListener("click", () => {
  stopRecording();
});

window.addEventListener("beforeunload", () => {
  try {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  } catch (error) {
    void error;
  }

  stopDrawLoop();
  stopTimerLoop();
  releaseMedia();
});

chrome.runtime.sendMessage({ type: "RECORDER_READY" }, () => {
  void chrome.runtime.lastError;
});

initPipDrag();
setStatus("idle");
updateTimer();
