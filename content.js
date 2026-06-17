/**
 * SnapCast — Content Script
 *
 * 注入到用户当前浏览的页面，负责：
 *  1. 渲染悬浮录制工具栏（计时器、暂停、停止）
 *  2. 渲染摄像头画中画圆形泡泡（可拖动）
 *  3. 调用 getDisplayMedia 获取屏幕流（在目标页面调用，避免 recorder 窗口出现在选择列表中）
 *  4. 通过 canvas 混合屏幕流 + 摄像头流，用 MediaRecorder 录制
 *  5. 标注工具：录制过程中可在屏幕上实时绘制标注（画笔/荧光笔/箭头/圆形高亮），直接合入录制画面
 *     - 快捷键 Alt+A（Mac：⌥A）切换标注模式开/关
 *     - 标注激活时 drawOverlay 拦截鼠标事件，同时在覆盖层上实时渲染供用户预览
 *     - annotationCanvas（离屏）同步绘制同样内容，最终合入录制视频
 *  6. 录制完成后通知 background 下载
 *
 * 架构说明（方案 B）：
 *  - initSnapCast() 只执行一次（首次注入），负责注册 chrome.runtime.onMessage 监听
 *  - createRecorder(config) 每次录制创建一个 Recorder 实例，持有全部 DOM、监听器、媒体资源
 *  - Recorder.destroy() 完整清理所有 DOM 节点 + removeEventListener，无任何资源泄漏
 *  - SC_START 到来时：若已有旧实例先 destroy()，再创建新实例并启动录制
 */

// ── 防止重复注入 ──────────────────────────────────────────────────────────────
if (!window.__snapcastInjected) {
  window.__snapcastInjected = true;
  initSnapCast();
}

function initSnapCast() {
  // 注入样式（只注入一次，由 initSnapCast 持有引用，destroy 时按需移除）
  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("content.css");
  document.head.appendChild(styleLink);

  // 当前活跃的录制器实例（方案 B：每次录制新建，停止后 destroy）
  let activeRecorder = null;

  // ── 消息监听（生命周期与 content script 相同，永不移除） ──────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "SC_START") {
      // 若有上一次未完全销毁的实例，先清理
      if (activeRecorder) {
        activeRecorder.destroy();
        activeRecorder = null;
      }
      const config = msg.config || {};
      activeRecorder = createRecorder(config);
      activeRecorder.start();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_PAUSE") {
      if (activeRecorder) {
        activeRecorder.showToolbar();
        activeRecorder.pauseRecording();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_STOP") {
      if (activeRecorder) {
        activeRecorder.showToolbar();
        activeRecorder.stopRecording();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_TOGGLE_ANNOT") {
      if (activeRecorder) {
        activeRecorder.toggleAnnotation();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_GET_STATUS") {
      // 注入标志始终为 true（此监听器从不移除）；返回当前录制状态
      sendResponse({ ok: true, status: activeRecorder ? activeRecorder.getStatus() : "idle" });
      return;
    }
  });

  // 注入完成，通知 background
  chrome.runtime.sendMessage({ type: "CONTENT_READY" }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// createRecorder — 每次录制创建一个隔离的录制器实例
// ══════════════════════════════════════════════════════════════════════════════
function createRecorder(recConfig) {

  // ── 状态 ────────────────────────────────────────────────────────────────
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
  let savingOrCleaning = false;

  // Canvas 合成层相关
  let annotationCanvas = null;
  let annotationCtx = null;
  let screenVideoEl = null;
  let rafId = null;

  // 区域录制相关
  let cropRegion = null;
  let fullVideoWidth  = 0;
  let fullVideoHeight = 0;

  // ── 标注状态 ──────────────────────────────────────────────────────────
  const annotations = [];
  let currentStroke = null;
  let annotTool  = "pen";
  let annotColor = "#ff4d6d";
  let annotSize  = "medium";
  let annotActive = false;

  const SIZE_MAP = { thin: 3, medium: 6, thick: 14 };
  const MARKER_OPACITY = 0.45;

  // ── 平台检测 ────────────────────────────────────────────────────────────
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const isMac = platform.toUpperCase().includes("MAC");
  const shortcutPause  = isMac ? "⇧⌘P" : "⇧⌥P";
  const shortcutStop   = isMac ? "⇧⌘S" : "⇧⌥S";
  const shortcutAnnot  = isMac ? "⇧⌘A" : "⇧⌥A";

  // ── 悬浮工具栏 DOM ──────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.id = "snapcast-toolbar";
  toolbar.innerHTML = `
    <span class="sc-drag-handle" title="拖动">⠿</span>
    <span class="sc-dot" id="sc-dot"></span>
    <span class="sc-timer" id="sc-timer">00:00</span>
    <span class="sc-sep"></span>
    <button class="sc-btn sc-pause" id="sc-pause-btn" title="暂停 (${shortcutPause})" disabled>⏸</button>
    <button class="sc-btn sc-stop"  id="sc-stop-btn"  title="停止并下载 (${shortcutStop})" disabled>⏹</button>
    <span class="sc-shortcut-hint" id="sc-shortcut-hint">${shortcutPause} 暂停 · ${shortcutStop} 停止 · ${shortcutAnnot} 标注</span>
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

  // ── 标注工具栏 DOM ──────────────────────────────────────────────────────
  const annotBar = document.createElement("div");
  annotBar.id = "snapcast-annot-bar";
  annotBar.innerHTML = `
    <div class="sc-annot-tool-group">
      <button class="sc-annot-btn sc-annot-tool active" data-tool="pen"    title="画笔">✏️</button>
      <button class="sc-annot-btn sc-annot-tool"        data-tool="marker" title="荧光笔">🖊️</button>
      <button class="sc-annot-btn sc-annot-tool"        data-tool="arrow"  title="箭头">➜</button>
      <button class="sc-annot-btn sc-annot-tool"        data-tool="circle" title="圆形高亮">⭕</button>
    </div>
    <div class="sc-annot-sep"></div>
    <div class="sc-annot-colors">
      <button class="sc-annot-btn sc-annot-color active" data-color="#ff4d6d" style="background:#ff4d6d;" title="红色"></button>
      <button class="sc-annot-btn sc-annot-color"        data-color="#ffd166" style="background:#ffd166;" title="黄色"></button>
      <button class="sc-annot-btn sc-annot-color"        data-color="#06d6a0" style="background:#06d6a0;" title="绿色"></button>
      <button class="sc-annot-btn sc-annot-color"        data-color="#4cc9f0" style="background:#4cc9f0;" title="蓝色"></button>
      <button class="sc-annot-btn sc-annot-color"        data-color="#ffffff" style="background:#ffffff;" title="白色"></button>
    </div>
    <div class="sc-annot-sep"></div>
    <div class="sc-annot-sizes">
      <button class="sc-annot-btn sc-annot-size" data-size="thin"   title="细">─</button>
      <button class="sc-annot-btn sc-annot-size active" data-size="medium" title="中">━</button>
      <button class="sc-annot-btn sc-annot-size" data-size="thick"  title="粗">▬</button>
    </div>
    <div class="sc-annot-sep"></div>
    <button class="sc-annot-btn sc-annot-undo"  id="sc-annot-undo"  title="撤销 (Ctrl+Z)">↩</button>
    <button class="sc-annot-btn sc-annot-clear" id="sc-annot-clear" title="清除全部">🗑</button>
    <div class="sc-annot-sep"></div>
    <button class="sc-annot-btn sc-annot-close" id="sc-annot-close" title="关闭标注 (${shortcutAnnot})">✕</button>
  `;
  annotBar.classList.add("sc-hidden");
  document.body.appendChild(annotBar);

  // 透明绘图覆盖层
  const drawOverlay = document.createElement("canvas");
  drawOverlay.id = "snapcast-draw-overlay";
  document.body.appendChild(drawOverlay);

  // ── 具名事件处理器（destroy 时可 removeEventListener） ──────────────────
  function onMouseMove(e) {
    if (status !== "recording" && status !== "paused") return;
    if (e.clientY < 56) showToolbar();
  }

  function onKeyDown(e) {
    const isAnnotKey = isMac
      ? (e.shiftKey && e.metaKey  && (e.key === "a" || e.key === "A"))
      : (e.shiftKey && e.altKey   && (e.key === "a" || e.key === "A"));
    if (isAnnotKey) {
      if (status === "recording" || status === "paused") {
        setAnnotActive(!annotActive);
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      if (annotActive && (status === "recording" || status === "paused")) {
        for (let i = annotations.length - 1; i >= 0; i--) {
          if (annotations[i].type !== "click") { annotations.splice(i, 1); break; }
        }
        redrawOverlay();
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  function onClickCapture(e) {
    if (status !== "recording" && status !== "paused") return;
    if (annotBar.contains(e.target) || toolbar.contains(e.target)) return;
    if (!annotActive) return;

    const pos = viewportToOverlay(e.clientX, e.clientY);
    const clickAnn = {
      type: "click", x: pos.x, y: pos.y,
      color: "#ffffff", baseRadius: 20,
      startTime: Date.now(), duration: 600
    };
    annotations.push(clickAnn);
    setTimeout(() => {
      const idx = annotations.indexOf(clickAnn);
      if (idx !== -1) { annotations.splice(idx, 1); redrawOverlay(); }
    }, 600);
    function animateClick() {
      if (annotations.indexOf(clickAnn) === -1) return;
      redrawOverlay();
      requestAnimationFrame(animateClick);
    }
    requestAnimationFrame(animateClick);
  }

  function onWindowResize() {
    // #4 修复：同时更新 drawOverlay 和 annotationCanvas 的尺寸
    drawOverlay.width  = window.innerWidth;
    drawOverlay.height = window.innerHeight;
    if (annotationCanvas) {
      // annotationCanvas 跟踪全屏流尺寸（不随视口变化），无需改变宽高；
      // 但 drawOverlay 坐标与视口绑定，重绘一次确保预览层正确
    }
    redrawOverlay();
  }

  // ── 注册全局事件（具名函数，destroy 时可移除） ──────────────────────────
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("click", onClickCapture, true);
  window.addEventListener("resize", onWindowResize);

  // ── 工具栏自动隐藏 ──────────────────────────────────────────────────────
  let autoHideTimer = null;

  function showToolbar() {
    toolbar.classList.remove("sc-hidden");
    toolbar.classList.add("sc-peek");
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(() => {
      if (status === "recording" || status === "paused") hideToolbar();
    }, 2500);
  }

  function hideToolbar() {
    toolbar.classList.add("sc-hidden");
    toolbar.classList.remove("sc-peek");
  }

  toolbar.addEventListener("mouseenter", () => { clearTimeout(autoHideTimer); });
  toolbar.addEventListener("mouseleave", () => {
    if (status === "recording" || status === "paused") {
      autoHideTimer = setTimeout(hideToolbar, 1200);
    }
  });

  // ── 工具栏拖动 ──────────────────────────────────────────────────────────
  (function initToolbarDrag() {
    const handle = toolbar.querySelector(".sc-drag-handle");
    let dragging = false;
    let ox = 0, oy = 0;
    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      const rect = toolbar.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      toolbar.style.transform = "none";
      toolbar.style.left = `${rect.left}px`;
      toolbar.style.top  = `${rect.top}px`;
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      toolbar.style.left = `${e.clientX - ox}px`;
      toolbar.style.top  = `${e.clientY - oy}px`;
    });
    const stopDrag = () => { dragging = false; };
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
  })();

  // ── 摄像头泡泡拖动 ──────────────────────────────────────────────────────
  (function initBubbleDrag() {
    let dragging = false;
    let ox = 0, oy = 0;
    camBubble.addEventListener("pointerdown", (e) => {
      dragging = true;
      camBubble.setPointerCapture(e.pointerId);
      const rect = camBubble.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
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

  // ── 按钮事件 ────────────────────────────────────────────────────────────
  const pauseBtn = toolbar.querySelector("#sc-pause-btn");
  const stopBtn  = toolbar.querySelector("#sc-stop-btn");
  const dot      = toolbar.querySelector("#sc-dot");
  const timerEl  = toolbar.querySelector("#sc-timer");

  pauseBtn.addEventListener("click", () => pauseRecording());
  stopBtn.addEventListener("click",  () => stopRecording());

  // ── 标注工具栏事件 ──────────────────────────────────────────────────────
  annotBar.querySelectorAll(".sc-annot-tool").forEach(btn => {
    btn.addEventListener("click", () => {
      annotBar.querySelectorAll(".sc-annot-tool").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotTool = btn.dataset.tool;
    });
  });
  annotBar.querySelectorAll(".sc-annot-color").forEach(btn => {
    btn.addEventListener("click", () => {
      annotBar.querySelectorAll(".sc-annot-color").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotColor = btn.dataset.color;
    });
  });
  annotBar.querySelectorAll(".sc-annot-size").forEach(btn => {
    btn.addEventListener("click", () => {
      annotBar.querySelectorAll(".sc-annot-size").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotSize = btn.dataset.size;
    });
  });

  annotBar.querySelector("#sc-annot-undo").addEventListener("click", () => {
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (annotations[i].type !== "click") { annotations.splice(i, 1); break; }
    }
    redrawOverlay();
  });
  annotBar.querySelector("#sc-annot-clear").addEventListener("click", () => {
    annotations.length = 0;
    currentStroke = null;
    redrawOverlay();
  });
  annotBar.querySelector("#sc-annot-close").addEventListener("click", () => {
    setAnnotActive(false);
  });

  // ── 绘图覆盖层初始化 ────────────────────────────────────────────────────
  drawOverlay.width  = window.innerWidth;
  drawOverlay.height = window.innerHeight;

  drawOverlay.addEventListener("pointerdown", (e) => {
    if (!annotActive) return;
    if (status !== "recording" && status !== "paused") return;
    if (e.button !== 0) return;
    const pos = viewportToOverlay(e.clientX, e.clientY);
    const lineWidth = SIZE_MAP[annotSize] || SIZE_MAP.medium;
    const opacity   = annotTool === "marker" ? MARKER_OPACITY : 1;
    currentStroke = { type: annotTool, color: annotColor, lineWidth, opacity, points: [pos] };
    drawOverlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  drawOverlay.addEventListener("pointermove", (e) => {
    if (!currentStroke) return;
    const pos = viewportToOverlay(e.clientX, e.clientY);
    if (annotTool === "pen" || annotTool === "marker") {
      currentStroke.points.push(pos);
    } else {
      currentStroke.points = [currentStroke.points[0], pos];
    }
    redrawOverlay();
  });
  const endStroke = () => {
    if (!currentStroke) return;
    if (currentStroke.points.length >= 1) annotations.push(currentStroke);
    currentStroke = null;
    redrawOverlay();
  };
  drawOverlay.addEventListener("pointerup",     endStroke);
  drawOverlay.addEventListener("pointercancel", endStroke);

  // ── 工具函数 ────────────────────────────────────────────────────────────
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

    if (next === "recording" || next === "paused") hideToolbar();
    if (next === "idle") {
      clearTimeout(autoHideTimer);
      setAnnotActive(false);
    }

    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: next, startedAt } }).catch(() => {});
  }

  function setAnnotActive(active) {
    annotActive = active;
    if (active) {
      annotBar.classList.remove("sc-hidden");
      drawOverlay.classList.add("sc-annot-active");
    } else {
      annotBar.classList.add("sc-hidden");
      drawOverlay.classList.remove("sc-annot-active");
      currentStroke = null;
      redrawOverlay();
    }
  }

  // ── 媒体工具 ────────────────────────────────────────────────────────────
  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
  }

  function releaseMedia() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopTracks(screenStream);
    stopTracks(cameraStream);
    stopTracks(micStream);
    stopTracks(mixedStream);
    screenStream = cameraStream = micStream = mixedStream = null;
    if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {});
    audioCtx = null;
    if (screenVideoEl) {
      screenVideoEl.pause();
      screenVideoEl.srcObject = null;
      screenVideoEl.remove();
      screenVideoEl = null;
    }
    annotationCanvas = null;
    annotationCtx = null;
    cropRegion = null;
    fullVideoWidth  = 0;
    fullVideoHeight = 0;
  }

  function stopTimerLoop() {
    if (!timerId) return;
    clearInterval(timerId);
    timerId = null;
  }

  // ── 坐标转换 ────────────────────────────────────────────────────────────
  function viewportToOverlay(clientX, clientY) {
    return { x: clientX, y: clientY };
  }

  // ── 核心绘制函数 ─────────────────────────────────────────────────────────
  function renderAnnotations(ctx, annList, live, scaleX, scaleY) {
    const now = Date.now();
    for (const ann of annList) {
      if (ann.type === "click") {
        const elapsed = now - ann.startTime;
        if (elapsed > ann.duration) continue;
        const progress = elapsed / ann.duration;
        const radius   = ann.baseRadius * scaleX * (1 + progress * 1.8);
        const opacity  = (1 - progress) * 0.7;
        ctx.save();
        ctx.beginPath();
        ctx.arc(ann.x * scaleX, ann.y * scaleY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = ann.color;
        ctx.lineWidth   = 3 * scaleX;
        ctx.globalAlpha = opacity;
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (!ann.points || ann.points.length === 0) continue;
      drawStroke(ctx, ann, scaleX, scaleY);
    }
    if (live) drawStroke(ctx, live, scaleX, scaleY);
  }

  function drawStroke(ctx, ann, scaleX, scaleY) {
    if (!ann.points || ann.points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.lineWidth   = ann.lineWidth * scaleX;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1;
    const pts = ann.points;
    const sx = scaleX, sy = scaleY;

    if (ann.type === "pen" || ann.type === "marker") {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * sx, pts[0].y * sy);
      for (let i = 1; i < pts.length; i++) {
        if (i < pts.length - 1) {
          const mx = (pts[i].x + pts[i + 1].x) / 2 * sx;
          const my = (pts[i].y + pts[i + 1].y) / 2 * sy;
          ctx.quadraticCurveTo(pts[i].x * sx, pts[i].y * sy, mx, my);
        } else {
          ctx.lineTo(pts[i].x * sx, pts[i].y * sy);
        }
      }
      ctx.stroke();
    } else if (ann.type === "arrow") {
      if (pts.length < 2) { ctx.restore(); return; }
      const p0 = pts[0], p1 = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(p0.x * sx, p0.y * sy);
      ctx.lineTo(p1.x * sx, p1.y * sy);
      ctx.stroke();
      const angle  = Math.atan2((p1.y - p0.y) * sy, (p1.x - p0.x) * sx);
      const hLen   = Math.max(ann.lineWidth * sx * 3.5, 14);
      const hAngle = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(p1.x * sx, p1.y * sy);
      ctx.lineTo(p1.x * sx - hLen * Math.cos(angle - hAngle), p1.y * sy - hLen * Math.sin(angle - hAngle));
      ctx.moveTo(p1.x * sx, p1.y * sy);
      ctx.lineTo(p1.x * sx - hLen * Math.cos(angle + hAngle), p1.y * sy - hLen * Math.sin(angle + hAngle));
      ctx.stroke();
    } else if (ann.type === "circle") {
      if (pts.length < 2) { ctx.restore(); return; }
      const p0 = pts[0], p1 = pts[pts.length - 1];
      const rx = Math.abs(p1.x - p0.x) / 2 * sx;
      const ry = Math.abs(p1.y - p0.y) / 2 * sy;
      const cx = (p0.x + p1.x) / 2 * sx;
      const cy = (p0.y + p1.y) / 2 * sy;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 区域录制模式下的标注合成 ──────────────────────────────────────────────
  function renderAnnotationsCropped(ctx, annList, live, sx, sy, offX, offY) {
    const now = Date.now();
    for (const ann of annList) {
      if (ann.type === "click") {
        const elapsed = now - ann.startTime;
        if (elapsed > ann.duration) continue;
        const progress = elapsed / ann.duration;
        const cx = ann.x * sx - offX;
        const cy = ann.y * sy - offY;
        if (cx < 0 || cy < 0) continue;
        const radius  = ann.baseRadius * sx * (1 + progress * 1.8);
        const opacity = (1 - progress) * 0.7;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = ann.color;
        ctx.lineWidth   = 3 * sx;
        ctx.globalAlpha = opacity;
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (!ann.points || ann.points.length === 0) continue;
      drawStrokeCropped(ctx, ann, sx, sy, offX, offY);
    }
    if (live) drawStrokeCropped(ctx, live, sx, sy, offX, offY);
  }

  function drawStrokeCropped(ctx, ann, sx, sy, offX, offY) {
    if (!ann.points || ann.points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.lineWidth   = ann.lineWidth * sx;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1;
    const pts = ann.points;

    if (ann.type === "pen" || ann.type === "marker") {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * sx - offX, pts[0].y * sy - offY);
      for (let i = 1; i < pts.length; i++) {
        if (i < pts.length - 1) {
          const mx = (pts[i].x + pts[i + 1].x) / 2 * sx - offX;
          const my = (pts[i].y + pts[i + 1].y) / 2 * sy - offY;
          ctx.quadraticCurveTo(pts[i].x * sx - offX, pts[i].y * sy - offY, mx, my);
        } else {
          ctx.lineTo(pts[i].x * sx - offX, pts[i].y * sy - offY);
        }
      }
      ctx.stroke();
    } else if (ann.type === "arrow") {
      if (pts.length < 2) { ctx.restore(); return; }
      const p0x = pts[0].x * sx - offX, p0y = pts[0].y * sy - offY;
      const p1x = pts[pts.length - 1].x * sx - offX, p1y = pts[pts.length - 1].y * sy - offY;
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.lineTo(p1x, p1y);
      ctx.stroke();
      const angle  = Math.atan2(p1y - p0y, p1x - p0x);
      const hLen   = Math.max(ann.lineWidth * sx * 3.5, 14);
      const hAngle = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p1x - hLen * Math.cos(angle - hAngle), p1y - hLen * Math.sin(angle - hAngle));
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p1x - hLen * Math.cos(angle + hAngle), p1y - hLen * Math.sin(angle + hAngle));
      ctx.stroke();
    } else if (ann.type === "circle") {
      if (pts.length < 2) { ctx.restore(); return; }
      const p0x = pts[0].x * sx - offX, p0y = pts[0].y * sy - offY;
      const p1x = pts[pts.length - 1].x * sx - offX, p1y = pts[pts.length - 1].y * sy - offY;
      const rx = Math.abs(p1x - p0x) / 2;
      const ry = Math.abs(p1y - p0y) / 2;
      ctx.beginPath();
      ctx.ellipse((p0x + p1x) / 2, (p0y + p1y) / 2, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 重绘 drawOverlay ────────────────────────────────────────────────────
  function redrawOverlay() {
    const ctx = drawOverlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, drawOverlay.width, drawOverlay.height);
    if (!annotActive) return;
    renderAnnotations(ctx, annotations, currentStroke, 1, 1);
  }

  // ── 区域选择 UI ──────────────────────────────────────────────────────────
  function showRegionSelector() {
    return new Promise((resolve, reject) => {
      const container = document.createElement("div");
      container.id = "snapcast-region-container";
      document.body.appendChild(container);

      const maskTop    = document.createElement("div");
      const maskBottom = document.createElement("div");
      const maskLeft   = document.createElement("div");
      const maskRight  = document.createElement("div");
      maskTop.className    = "sc-region-mask sc-region-mask-top";
      maskBottom.className = "sc-region-mask sc-region-mask-bottom";
      maskLeft.className   = "sc-region-mask sc-region-mask-left";
      maskRight.className  = "sc-region-mask sc-region-mask-right";
      maskTop.style.cssText    = "top:0;left:0;right:0;height:100%";
      maskBottom.style.cssText = "bottom:0;left:0;right:0;height:0";
      maskLeft.style.cssText   = "top:0;left:0;width:0;bottom:0";
      maskRight.style.cssText  = "top:0;right:0;width:0;bottom:0";
      container.appendChild(maskTop);
      container.appendChild(maskBottom);
      container.appendChild(maskLeft);
      container.appendChild(maskRight);

      const selBox = document.createElement("div");
      selBox.id = "snapcast-region-selbox";
      container.appendChild(selBox);

      const sizeHint = document.createElement("div");
      sizeHint.id = "snapcast-region-size-hint";
      container.appendChild(sizeHint);

      const guide = document.createElement("div");
      guide.id = "snapcast-region-guide";
      guide.innerHTML = `<span>拖拽选择录制区域</span><small>按 Esc 取消</small>`;
      container.appendChild(guide);

      const actionBar = document.createElement("div");
      actionBar.id = "snapcast-region-actionbar";
      actionBar.innerHTML = `
        <button id="sc-region-cancel" class="sc-region-btn sc-region-btn-cancel">取消</button>
        <span id="sc-region-warn" class="sc-region-warn"></span>
        <button id="sc-region-confirm" class="sc-region-btn sc-region-btn-confirm">开始录制</button>
      `;
      actionBar.style.display = "none";
      container.appendChild(actionBar);

      let dragging = false;
      let startX = 0, startY = 0;
      let currentRegion = null;

      function updateUI(r) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x2 = r.x + r.w;
        const y2 = r.y + r.h;
        maskTop.style.cssText    = `top:0;left:0;right:0;height:${r.y}px`;
        maskBottom.style.cssText = `bottom:0;left:0;right:0;top:${y2}px`;
        maskLeft.style.cssText   = `top:${r.y}px;left:0;width:${r.x}px;height:${r.h}px`;
        maskRight.style.cssText  = `top:${r.y}px;right:0;left:${x2}px;height:${r.h}px`;
        selBox.style.cssText = `display:block;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
        sizeHint.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
        const hintX = Math.min(r.x + r.w + 6, vw - 90);
        const hintY = Math.max(r.y - 24, 4);
        sizeHint.style.cssText = `display:block;left:${hintX}px;top:${hintY}px`;
        const barY = Math.min(y2 + 10, vh - 52);
        const barX = Math.max(Math.min(r.x + r.w - 220, vw - 226), 6);
        actionBar.style.cssText = `display:flex;left:${barX}px;top:${barY}px`;
        const warnEl = container.querySelector("#sc-region-warn");
        if (r.w < 160 || r.h < 90) {
          warnEl.textContent = "选区过小";
          container.querySelector("#sc-region-confirm").disabled = true;
        } else {
          warnEl.textContent = "";
          container.querySelector("#sc-region-confirm").disabled = false;
        }
      }

      container.addEventListener("pointerdown", (e) => {
        if (actionBar.contains(e.target)) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        currentRegion = { x: startX, y: startY, w: 0, h: 0 };
        guide.style.display = "none";
        actionBar.style.display = "none";
        selBox.style.display = "none";
        sizeHint.style.display = "none";
        container.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      container.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const x = Math.min(e.clientX, startX);
        const y = Math.min(e.clientY, startY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        currentRegion = { x, y, w, h };
        updateUI(currentRegion);
      });
      container.addEventListener("pointerup", () => { if (!dragging) return; dragging = false; });

      function doCancel() {
        container.remove();
        reject(new Error("用户取消区域选择"));
      }
      function doConfirm() {
        if (!currentRegion || currentRegion.w < 160 || currentRegion.h < 90) return;
        container.remove();
        resolve(currentRegion);
      }

      container.querySelector("#sc-region-cancel").addEventListener("click", doCancel);
      container.querySelector("#sc-region-confirm").addEventListener("click", doConfirm);

      function onEsc(e) {
        if (e.key === "Escape") {
          document.removeEventListener("keydown", onEsc);
          doCancel();
        }
      }
      document.addEventListener("keydown", onEsc);
    });
  }

  // ── 屏幕 + 音频混合流（含 Canvas 合成层） ────────────────────────────────
  async function buildMixedStream(cssRegion) {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: true
    });

    screenStream.getVideoTracks()[0].onended = () => {
      if (status === "recording" || status === "paused") stopRecording();
    };

    // #5 修复：创建 AudioContext 后立即 resume，避免 suspended 导致静音
    audioCtx = new AudioContext();
    audioCtx.resume().catch(() => {});
    audioDestNode = audioCtx.createMediaStreamDestination();

    const screenAudioTracks = screenStream.getAudioTracks();
    if (screenAudioTracks.length > 0) {
      const src = audioCtx.createMediaStreamSource(new MediaStream(screenAudioTracks));
      src.connect(audioDestNode);
    }

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

    // ── Canvas 合成层 ──────────────────────────────────────────────────
    const screenVideoTrack = screenStream.getVideoTracks()[0];
    const trackSettings    = screenVideoTrack.getSettings();
    fullVideoWidth  = trackSettings.width  || window.screen.width;
    fullVideoHeight = trackSettings.height || window.screen.height;

    cropRegion = null;
    if (cssRegion) {
      if (trackSettings.displaySurface === "monitor") {
        console.warn("SnapCast: 区域录制在全屏捕获模式下不支持，已自动降级为全屏录制");
      } else {
        const sx = fullVideoWidth  / window.innerWidth;
        const sy = fullVideoHeight / window.innerHeight;
        cropRegion = {
          x: Math.round(cssRegion.x * sx),
          y: Math.round(cssRegion.y * sy),
          w: Math.max(Math.round(cssRegion.w * sx), 1),
          h: Math.max(Math.round(cssRegion.h * sy), 1),
        };
      }
    }

    const outWidth  = cropRegion ? cropRegion.w : fullVideoWidth;
    const outHeight = cropRegion ? cropRegion.h : fullVideoHeight;

    annotationCanvas        = document.createElement("canvas");
    annotationCanvas.width  = outWidth;
    annotationCanvas.height = outHeight;
    annotationCtx           = annotationCanvas.getContext("2d");

    // 同步 drawOverlay 到当前视口尺寸
    drawOverlay.width  = window.innerWidth;
    drawOverlay.height = window.innerHeight;

    screenVideoEl = document.createElement("video");
    screenVideoEl.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    screenVideoEl.srcObject = new MediaStream([screenVideoTrack]);
    screenVideoEl.muted     = true;
    screenVideoEl.playsInline = true;
    document.body.appendChild(screenVideoEl);
    await screenVideoEl.play();

    function renderFrame() {
      if (!annotationCanvas || !annotationCtx || !screenVideoEl) return;

      if (cropRegion) {
        annotationCtx.drawImage(
          screenVideoEl,
          cropRegion.x, cropRegion.y, cropRegion.w, cropRegion.h,
          0, 0, outWidth, outHeight
        );
      } else {
        annotationCtx.drawImage(screenVideoEl, 0, 0, outWidth, outHeight);
      }

      if (annotActive) {
        if (cropRegion) {
          const streamScaleX = fullVideoWidth  / window.innerWidth;
          const streamScaleY = fullVideoHeight / window.innerHeight;
          renderAnnotationsCropped(annotationCtx, annotations, currentStroke,
            streamScaleX, streamScaleY, cropRegion.x, cropRegion.y);
        } else {
          const sx = outWidth  / window.innerWidth;
          const sy = outHeight / window.innerHeight;
          renderAnnotations(annotationCtx, annotations, currentStroke, sx, sy);
        }
      }

      rafId = requestAnimationFrame(renderFrame);
    }
    rafId = requestAnimationFrame(renderFrame);

    const canvasVideoTrack = annotationCanvas.captureStream(30).getVideoTracks()[0];
    const tracks = [canvasVideoTrack];
    if (mixedAudioTrack) tracks.push(mixedAudioTrack);
    mixedStream = new MediaStream(tracks);
  }

  // ── 录制控制 ─────────────────────────────────────────────────────────────
  function pickMime() {
    const list = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return list.find(m => MediaRecorder.isTypeSupported(m)) || "";
  }

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
        if (count <= 0) { overlay.remove(); resolve(); return; }
        const newNum = document.createElement("span");
        newNum.className = "sc-count-num";
        newNum.textContent = count;
        const old = ring.querySelector(".sc-count-num");
        if (old) ring.replaceChild(newNum, old); else ring.appendChild(newNum);
        count--;
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
      annotations.length = 0;
      currentStroke = null;
      cropRegion = null;

      let cssRegion = null;
      if (recConfig.enableCrop) {
        try {
          cssRegion = await showRegionSelector();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        } catch (_) {
          // 用户取消选区：重置状态并销毁本实例 DOM
          setStatus("idle");
          destroy();
          return;
        }
      }

      await buildMixedStream(cssRegion);

      hideToolbar();
      await showCountdown();

      const mime = pickMime();
      recorder = new MediaRecorder(mixedStream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => saveRecording();
      recorder.onerror = (e) => {
        const msg = e.error ? e.error.message : "录制器发生未知错误";
        chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "error", error: msg } }).catch(() => {});
        setStatus("idle");
        destroy();
      };
      recorder.start(1000);

      startedAt = Date.now();
      pausedDuration = 0;
      pausedAt = null;

      setStatus("recording");
      timerId = setInterval(updateTimer, 1000);
      updateTimer();

    } catch (error) {
      releaseMedia();
      const isCancelled = !error ||
        error.name === "NotAllowedError" ||
        (error.message && (error.message.includes("Permission denied") || error.message.includes("cancelled")));
      if (!isCancelled) {
        chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "error", error: error.message } }).catch(() => {});
      }
      setStatus("idle");
      destroy();
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
    if (savingOrCleaning) return;
    if (!recorder) {
      cleanup();
      return;
    }
    if (status === "paused" && pausedAt) {
      pausedDuration += Date.now() - pausedAt;
      pausedAt = null;
    }
    stopTimerLoop();

    // #6 修复：先更新 status 变量，避免 stop→onstop 窗口期内可重入
    // 通过局部变量捕获 recorder，防止 GC 前被置 null
    const rec = recorder;
    recorder = null;
    status = "idle";
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "idle", startedAt: null } }).catch(() => {});
    clearTimeout(autoHideTimer);
    setAnnotActive(false);

    if (rec.state !== "inactive") {
      rec.stop();
    } else {
      releaseMedia();
      destroy();
    }
  }

  // ── 保存 / 下载 ──────────────────────────────────────────────────────────
  async function saveRecording() {
    if (savingOrCleaning) return;
    savingOrCleaning = true;

    if (!chunks.length) { cleanup(); savingOrCleaning = false; return; }

    const webmBlob = new Blob(chunks, { type: "video/webm" });
    // 使用本地时区时间戳，避免 toISOString() 显示 UTC 时间让用户困惑
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
             + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const filename = `snapcast-${ts}.webm`;

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("文件读取失败，请重试"));
        reader.readAsDataURL(webmBlob);
      });
      await chrome.runtime.sendMessage({ type: "DOWNLOAD_RECORDING", dataUrl, filename });
    } catch (_err) {
      // 兜底：直接在页面内触发下载
      try {
        const url = URL.createObjectURL(webmBlob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      } catch (fallbackErr) {
        console.error("SnapCast: 下载完全失败", fallbackErr);
      }
    }

    releaseMedia();
    cleanup();
    savingOrCleaning = false;
    // destroy() 使用 destroyed 标志保证幂等，多次调用安全
    destroy();
  }

  function cleanup() {
    releaseMedia();
    stopTimerLoop();
    startedAt = null;
    pausedDuration = 0;
    pausedAt = null;
    recorder = null;
    chunks = [];
    annotations.length = 0;
    currentStroke = null;
  }

  // ── destroy：完整释放本实例的所有 DOM 和事件监听器 ───────────────────────
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;

    // 移除全局具名监听器（方案 B 的核心：不再泄漏）
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("resize", onWindowResize);

    clearTimeout(autoHideTimer);
    stopTimerLoop();
    releaseMedia();

    // 移除所有 DOM 节点
    try { toolbar.remove();     } catch (_) {}
    try { camBubble.remove();   } catch (_) {}
    try { annotBar.remove();    } catch (_) {}
    try { drawOverlay.remove(); } catch (_) {}
  }

  // ── 公开 API ─────────────────────────────────────────────────────────────
  return {
    start:            () => startRecording(),
    pauseRecording:   () => pauseRecording(),
    stopRecording:    () => stopRecording(),
    showToolbar:      () => showToolbar(),
    toggleAnnotation: () => {
      if (status === "recording" || status === "paused") setAnnotActive(!annotActive);
    },
    getStatus:        () => status,
    destroy:          () => destroy(),
  };
}
