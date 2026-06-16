/**
 * SnapCast — Content Script
 *
 * 注入到用户当前浏览的页面，负责：
 *  1. 渲染悬浮录制工具栏（计时器、暂停、停止）
 *  2. 渲染摄像头画中画圆形泡泡（可拖动）
 *  3. 调用 getDisplayMedia 获取屏幕流（在目标页面调用，避免 recorder 窗口出现在选择列表中）
 *  4. 通过 canvas 混合屏幕流 + 摄像头流，用 MediaRecorder 录制
 *  5. 录制完成后通知 background 下载
 *
 * 架构说明：
 *  - getDisplayMedia 在 content script 中调用，此时插件 popup 已关闭，
 *    用户看到的选择列表是纯净的屏幕/窗口列表，不含 recorder 窗口
 *  - 所有 DOM 元素加 #snapcast- 前缀，不污染宿主页面
 */

// ── 防止重复注入 ──────────────────────────────────────────────────────────────
if (window.__snapcastInjected) {
  // 已注入，仅响应启动命令
} else {
  window.__snapcastInjected = true;
  initSnapCast();
}

function initSnapCast() {
  // ── 样式注入 ─────────────────────────────────────────────────────────────
  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("content.css");
  document.head.appendChild(styleLink);

  // ── 状态 ─────────────────────────────────────────────────────────────────
  let status = "idle"; // idle | preparing | recording | paused
  let screenStream = null;
  let cameraStream = null;
  let micStream = null;
  let audioCtx = null;
  let audioDestNode = null;
  let mixedStream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = null;
  let pausedAt = null;
  let pausedDuration = 0;
  let timerId = null;
  let drawReq = null;

  // 录制配置（由 popup 通过消息传入）
  let recConfig = {
    mic: true,
    camera: true,
    format: "webm"
  };

  // ── 悬浮工具栏 DOM ────────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.id = "snapcast-toolbar";
  // Mac: ⇧⌘P / ⇧⌘S，Win/Linux: Shift+Alt+P / Shift+Alt+S
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const shortcutPause = isMac ? "⇧⌘P" : "⇧⌥P";
  const shortcutStop  = isMac ? "⇧⌘S" : "⇧⌥S";

  toolbar.innerHTML = `
    <span class="sc-drag-handle" title="拖动">⠿</span>
    <span class="sc-dot" id="sc-dot"></span>
    <span class="sc-timer" id="sc-timer">00:00</span>
    <span class="sc-sep"></span>
    <button class="sc-btn sc-pause" id="sc-pause-btn" title="暂停 (${shortcutPause})" disabled>⏸</button>
    <button class="sc-btn sc-stop"  id="sc-stop-btn"  title="停止并下载 (${shortcutStop})" disabled>⏹</button>
    <span class="sc-shortcut-hint" id="sc-shortcut-hint">${shortcutPause} 暂停 · ${shortcutStop} 停止</span>
  `;
  document.body.appendChild(toolbar);

  // 摄像头泡泡
  const camBubble = document.createElement("div");
  camBubble.id = "snapcast-cam-bubble";
  const camVideo = document.createElement("video");
  camVideo.autoplay = true;
  camVideo.muted = true;
  camVideo.playsInline = true;
  camBubble.appendChild(camVideo);
  document.body.appendChild(camBubble);

  // ── 工具栏拖动 ────────────────────────────────────────────────────────────
  (function initToolbarDrag() {
    const handle = toolbar.querySelector(".sc-drag-handle");
    let dragging = false;
    let ox = 0, oy = 0;
    // 拖动时用 left/top 替代 transform
    let tbLeft = null, tbTop = null;

    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      const rect = toolbar.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      toolbar.style.transform = "none";
      toolbar.style.left = `${rect.left}px`;
      toolbar.style.top  = `${rect.top}px`;
      tbLeft = rect.left; tbTop = rect.top;
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      tbLeft = e.clientX - ox;
      tbTop  = e.clientY - oy;
      toolbar.style.left = `${tbLeft}px`;
      toolbar.style.top  = `${tbTop}px`;
    });

    const stopDrag = () => { dragging = false; };
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
  })();

  // ── 摄像头泡泡拖动 ────────────────────────────────────────────────────────
  (function initBubbleDrag() {
    let dragging = false;
    let ox = 0, oy = 0;

    camBubble.addEventListener("pointerdown", (e) => {
      dragging = true;
      camBubble.setPointerCapture(e.pointerId);
      const rect = camBubble.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      // 切换为 left/top 定位
      camBubble.style.bottom = "auto";
      camBubble.style.right  = "auto";
      camBubble.style.left   = `${rect.left}px`;
      camBubble.style.top    = `${rect.top}px`;
      e.preventDefault();
    });

    camBubble.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      camBubble.style.left = `${e.clientX - ox}px`;
      camBubble.style.top  = `${e.clientY - oy}px`;
    });

    const stopDrag = () => { dragging = false; };
    camBubble.addEventListener("pointerup", stopDrag);
    camBubble.addEventListener("pointercancel", stopDrag);
  })();

  // ── 工具栏自动隐藏逻辑 ───────────────────────────────────────────────────
  // 录制时工具栏完全隐藏，不出现在录制画面中
  // 鼠标移到页面顶部 48px 区域内，或触发快捷键时，短暂浮现后自动收回
  let autoHideTimer = null;

  function showToolbar() {
    toolbar.classList.remove("sc-hidden");
    toolbar.classList.add("sc-peek");
    clearTimeout(autoHideTimer);
    // 2.5 秒后自动收回
    autoHideTimer = setTimeout(() => {
      if (status === "recording" || status === "paused") {
        hideToolbar();
      }
    }, 2500);
  }

  function hideToolbar() {
    toolbar.classList.add("sc-hidden");
    toolbar.classList.remove("sc-peek");
  }

  // 鼠标滑到顶部边缘触发显示
  document.addEventListener("mousemove", (e) => {
    if (status !== "recording" && status !== "paused") return;
    if (e.clientY < 56) {
      showToolbar();
    }
  });

  // 鼠标进入工具栏本身时保持显示
  toolbar.addEventListener("mouseenter", () => {
    clearTimeout(autoHideTimer);
  });
  toolbar.addEventListener("mouseleave", () => {
    if (status === "recording" || status === "paused") {
      autoHideTimer = setTimeout(hideToolbar, 1200);
    }
  });

  // ── 按钮事件 ─────────────────────────────────────────────────────────────
  const pauseBtn = document.getElementById("sc-pause-btn");
  const stopBtn  = document.getElementById("sc-stop-btn");
  const dot      = document.getElementById("sc-dot");
  const timerEl  = document.getElementById("sc-timer");

  pauseBtn.addEventListener("click", () => pauseRecording());
  stopBtn.addEventListener("click",  () => stopRecording());

  // ── 工具函数 ─────────────────────────────────────────────────────────────
  function formatMs(ms) {
    const sec = Math.floor(Math.max(ms, 0) / 1000);
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }

  function updateTimer() {
    if (!startedAt) { timerEl.textContent = "00:00"; return; }
    const end = pausedAt || Date.now();
    timerEl.textContent = formatMs(end - startedAt - pausedDuration);
  }

  function setStatus(next) {
    status = next;
    dot.className = `sc-dot ${next === "recording" ? "recording" : next === "paused" ? "paused" : ""}`;
    pauseBtn.disabled = (next !== "recording" && next !== "paused");
    stopBtn.disabled  = (next === "idle" || next === "preparing");
    pauseBtn.textContent = next === "paused" ? "▶" : "⏸";
    pauseBtn.title       = next === "paused" ? "继续" : "暂停";

    // 录制开始 → 立即隐藏工具栏（不录进视频）
    if (next === "recording") {
      hideToolbar();
    }
    // 暂停状态 → 同样保持隐藏，快捷键触发时再短暂浮现
    if (next === "paused") {
      hideToolbar();
    }
    // 录制结束 → 彻底从页面移除工具栏和摄像头泡泡
    if (next === "idle") {
      clearTimeout(autoHideTimer);
      destroyToolbar();
    }

    // 同步状态给 background / popup
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: next, startedAt } }).catch(() => {});
  }

  // ── 媒体工具 ─────────────────────────────────────────────────────────────
  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
  }

  function releaseMedia() {
    stopTracks(screenStream);
    stopTracks(cameraStream);
    stopTracks(micStream);
    stopTracks(mixedStream);
    screenStream = cameraStream = micStream = mixedStream = null;
    if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {});
    audioCtx = audioDestNode = null;
    camVideo.srcObject = null;
    camBubble.classList.remove("visible");
  }

  function stopDrawLoop() {
    if (!drawReq) return;
    cancelAnimationFrame(drawReq);
    drawReq = null;
  }

  function stopTimerLoop() {
    if (!timerId) return;
    clearInterval(timerId);
    timerId = null;
  }

  // ── 屏幕 + 音频混合流 ─────────────────────────────────────────────────────
  async function buildMixedStream() {
    // 屏幕流 —— 在 content script 中调用，popup 已关闭，选择器干净
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: true
    });

    // 监听用户点击浏览器自带「停止共享」
    screenStream.getVideoTracks()[0].onended = () => {
      if (status === "recording" || status === "paused") stopRecording();
    };

    audioCtx = new AudioContext();
    audioDestNode = audioCtx.createMediaStreamDestination();

    // 混入屏幕系统音频
    const screenAudioTracks = screenStream.getAudioTracks();
    if (screenAudioTracks.length > 0) {
      const src = audioCtx.createMediaStreamSource(new MediaStream(screenAudioTracks));
      src.connect(audioDestNode);
    }

    // 摄像头（仅视频）
    if (recConfig.camera) {
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 640 } },
          audio: false
        });
        camVideo.srcObject = cameraStream;
        await camVideo.play();
        camBubble.classList.add("visible");
      } catch (_) {
        cameraStream = null;
      }
    }

    // 麦克风
    if (recConfig.mic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
          video: false
        });
        const src = audioCtx.createMediaStreamSource(micStream);
        src.connect(audioDestNode);
      } catch (_) {}
    }

    const mixedAudioTrack = audioDestNode.stream.getAudioTracks()[0];

    // ── canvas 混合屏幕 + 摄像头 ──────────────────────────────────────────
    const offscreen = document.createElement("canvas");
    const screenVid = document.createElement("video");
    screenVid.srcObject = screenStream;
    screenVid.autoplay = true;
    screenVid.muted = true;
    await screenVid.play();

    // 等待视频尺寸就绪
    await new Promise((res) => {
      if (screenVid.videoWidth) { res(); return; }
      screenVid.onloadedmetadata = res;
    });

    offscreen.width  = screenVid.videoWidth  || 1280;
    offscreen.height = screenVid.videoHeight || 720;
    const octx = offscreen.getContext("2d", { alpha: false });

    // 摄像头帧尺寸（右下角圆形，实际录制为方形 PiP）
    const PIP_SIZE = Math.floor(offscreen.width * 0.22);

    function drawMix() {
      octx.fillStyle = "#000";
      octx.fillRect(0, 0, offscreen.width, offscreen.height);
      if (screenVid.readyState >= 2) {
        octx.drawImage(screenVid, 0, 0, offscreen.width, offscreen.height);
      }
      if (cameraStream && camVideo.readyState >= 2) {
        const cx = offscreen.width  - PIP_SIZE - 16;
        const cy = offscreen.height - PIP_SIZE - 16;
        // 圆形裁剪
        octx.save();
        octx.beginPath();
        octx.arc(cx + PIP_SIZE / 2, cy + PIP_SIZE / 2, PIP_SIZE / 2, 0, Math.PI * 2);
        octx.clip();
        octx.drawImage(camVideo, cx, cy, PIP_SIZE, PIP_SIZE);
        octx.restore();
        // 白色描边
        octx.strokeStyle = "rgba(255,255,255,0.8)";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(cx + PIP_SIZE / 2, cy + PIP_SIZE / 2, PIP_SIZE / 2, 0, Math.PI * 2);
        octx.stroke();
      }
      drawReq = requestAnimationFrame(drawMix);
    }
    drawMix();

    const videoTrack = offscreen.captureStream(30).getVideoTracks()[0];
    const tracks = [videoTrack];
    if (mixedAudioTrack) tracks.push(mixedAudioTrack);
    mixedStream = new MediaStream(tracks);
  }

  // ── 录制控制 ─────────────────────────────────────────────────────────────
  function pickMime() {
    const list = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return list.find(m => MediaRecorder.isTypeSupported(m)) || "";
  }

  // 3 秒倒计时蒙层：显示 3→2→1，结束后自动移除
  function showCountdown() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.id = "snapcast-countdown";
      const ring = document.createElement("div");
      ring.className = "sc-count-ring";
      const num = document.createElement("span");
      num.className = "sc-count-num";
      ring.appendChild(num);
      overlay.appendChild(ring);
      document.body.appendChild(overlay);

      let count = 3;

      function tick() {
        if (count <= 0) {
          // 所有数字播完，移除蒙层并 resolve
          overlay.remove();
          resolve();
          return;
        }

        // 替换数字节点以重置 CSS 动画
        const newNum = document.createElement("span");
        newNum.className = "sc-count-num";
        newNum.textContent = count;
        const old = ring.querySelector(".sc-count-num");
        if (old) ring.replaceChild(newNum, old); else ring.appendChild(newNum);

        count--;
        // 每 1 秒切换下一个数字（动画时长 0.9s，刚好一个完整 tick-out）
        setTimeout(tick, 1000);
      }

      tick();
    });
  }

  async function startRecording() {
    if (status !== "idle") return;
    setStatus("preparing");

    try {
      chunks = [];

      // 先选屏幕（此时 toolbar 还可见，用户可以看到选择界面）
      await buildMixedStream();

      // 选屏幕成功后：隐藏工具栏，展示 3 秒倒计时
      hideToolbar();
      await showCountdown();

      // 倒计时结束，正式开始录制
      const mime = pickMime();
      recorder = new MediaRecorder(mixedStream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => saveRecording();
      recorder.onerror = (e) => {
        const msg = e.error ? e.error.message : "录制器发生未知错误";
        setStatus("idle");
        chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "error", error: msg } }).catch(() => {});
      };
      recorder.start(1000);

      startedAt = Date.now();
      pausedDuration = 0;
      pausedAt = null;

      setStatus("recording"); // → hideToolbar() 再次确保隐藏
      timerId = setInterval(updateTimer, 1000);
      updateTimer();

    } catch (error) {
      releaseMedia();
      stopDrawLoop();
      setStatus("idle");
      // 用户取消选择，静默处理
      const isCancelled = !error ||
        error.name === "NotAllowedError" ||
        (error.message && (error.message.includes("Permission denied") || error.message.includes("cancelled")));
      if (!isCancelled) {
        chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "error", error: error.message } }).catch(() => {});
      }
    }
  }

  function pauseRecording() {
    if (!recorder) return;
    if (status === "recording") {
      recorder.pause();
      pausedAt = Date.now();
      setStatus("paused");
    } else if (status === "paused") {
      recorder.resume();
      pausedDuration += Date.now() - pausedAt;
      pausedAt = null;
      setStatus("recording");
    }
  }

  function stopRecording() {
    if (!recorder) {
      cleanup();
      destroyToolbar();
      return;
    }
    if (status === "paused" && pausedAt) {
      pausedDuration += Date.now() - pausedAt;
      pausedAt = null;
    }
    stopDrawLoop();
    stopTimerLoop();
    status = "idle"; // 直接更新状态，不经过 setStatus（避免 destroyToolbar 提前删除 DOM）
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "idle", startedAt: null } }).catch(() => {});
    clearTimeout(autoHideTimer);

    if (recorder.state !== "inactive") {
      recorder.stop(); // onstop → saveRecording → cleanup → destroyToolbar
    } else {
      releaseMedia();
      destroyToolbar();
    }
  }

  // ── 保存 / 下载 ───────────────────────────────────────────────────────────
  async function saveRecording() {
    if (!chunks.length) { cleanup(); return; }
    const webmBlob = new Blob(chunks, { type: "video/webm" });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");

    // 通知 background 下载（content script 无法直接用 chrome.downloads）
    const reader = new FileReader();
    reader.onload = () => {
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RECORDING",
        dataUrl: reader.result,
        filename: `snapcast-${ts}.webm`,
        format: recConfig.format
      }).catch(() => {});
    };
    reader.readAsDataURL(webmBlob);
    releaseMedia();
    cleanup();
    destroyToolbar();
  }

  // 彻底销毁工具栏和摄像头泡泡 DOM，并重置注入标记
  // 这样下次点击「开始录制」时可以重新注入
  function destroyToolbar() {
    try { toolbar.remove(); } catch (_) {}
    try { camBubble.remove(); } catch (_) {}
    try { document.querySelector("link[href*='content.css']")?.remove(); } catch (_) {}
    window.__snapcastInjected = false;
  }

  function cleanup() {
    releaseMedia();
    stopDrawLoop();
    stopTimerLoop();
    startedAt = null;
    pausedDuration = 0;
    pausedAt = null;
    recorder = null;
    chunks = [];
  }

  // ── 监听来自 background / popup 的消息 ───────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "SC_START") {
      if (msg.config) recConfig = { ...recConfig, ...msg.config };
      startRecording();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_PAUSE") {
      showToolbar(); // 快捷键操作时短暂浮现，让用户看到状态变化
      pauseRecording();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_STOP") {
      showToolbar(); // 停止时浮现，显示"正在下载"状态
      stopRecording();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_GET_STATUS") {
      sendResponse({ ok: true, status });
      return;
    }
  });

  // ── 注入完成，通知 background ─────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: "CONTENT_READY" }).catch(() => {});
}
