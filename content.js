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
 * 架构说明：
 *  - 所有 DOM 元素加 #snapcast- 前缀，不污染宿主页面
 *  - Canvas 合成层：screenVideoEl → annotationCanvas（叠加标注层）→ canvas.captureStream() → MediaRecorder
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
  let savingOrCleaning = false;

  // Canvas 合成层相关
  let annotationCanvas = null;
  let annotationCtx = null;
  let screenVideoEl = null;
  let rafId = null;

  // 录制配置（由 popup 通过消息传入）
  let recConfig = {
    mic: true,
    camera: true
  };


  // ── 悬浮工具栏 DOM ────────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.id = "snapcast-toolbar";
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const shortcutPause  = isMac ? "⇧⌘P" : "⇧⌥P";
  const shortcutStop   = isMac ? "⇧⌘S" : "⇧⌥S";
  const shortcutAnnot  = isMac ? "⇧⌘A" : "⇧⌥A";

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

  // ── 标注工具栏 DOM ────────────────────────────────────────────────────────
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
  // 默认隐藏：录制开始后仍隐藏，快捷键呼出
  annotBar.classList.add("sc-hidden");
  document.body.appendChild(annotBar);

  // 透明绘图覆盖层（Canvas，捕获绘制事件 & 实时预览）
  // 注意：初始 pointer-events:none，不拦截页面交互，仅标注激活时才开启
  const drawOverlay = document.createElement("canvas");
  drawOverlay.id = "snapcast-draw-overlay";
  // 始终挂载到 DOM，但通过 pointer-events 控制是否拦截事件
  // 用 CSS class sc-annot-active 切换
  document.body.appendChild(drawOverlay);

  // ── 标注状态 ─────────────────────────────────────────────────────────────
  const annotations = [];   // 已完成的笔迹
  let currentStroke = null; // 正在绘制的笔迹
  let annotTool  = "pen";
  let annotColor = "#ff4d6d";
  let annotSize  = "medium"; // thin | medium | thick
  // 标注激活状态（快捷键切换）
  let annotActive = false;

  const SIZE_MAP = { thin: 3, medium: 6, thick: 14 };
  const MARKER_OPACITY = 0.45;

  // ── 标注激活/关闭切换 ────────────────────────────────────────────────────
  function setAnnotActive(active) {
    annotActive = active;
    if (active) {
      annotBar.classList.remove("sc-hidden");
      // 开启覆盖层事件拦截
      drawOverlay.classList.add("sc-annot-active");
    } else {
      annotBar.classList.add("sc-hidden");
      // 关闭覆盖层事件拦截
      drawOverlay.classList.remove("sc-annot-active");
      currentStroke = null;
      // 强制清空覆盖层画布（annotActive 已为 false，redrawOverlay 会只做 clearRect）
      redrawOverlay();
    }
  }

  // ── 工具栏拖动 ────────────────────────────────────────────────────────────
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
  let autoHideTimer = null;

  function showToolbar() {
    toolbar.classList.remove("sc-hidden");
    toolbar.classList.add("sc-peek");
    clearTimeout(autoHideTimer);
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

  document.addEventListener("mousemove", (e) => {
    if (status !== "recording" && status !== "paused") return;
    if (e.clientY < 56) {
      showToolbar();
    }
  });

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

  // ── 标注工具栏事件 ────────────────────────────────────────────────────────
  // 工具切换
  annotBar.querySelectorAll(".sc-annot-tool").forEach(btn => {
    btn.addEventListener("click", () => {
      annotBar.querySelectorAll(".sc-annot-tool").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotTool = btn.dataset.tool;
    });
  });

  // 颜色切换
  annotBar.querySelectorAll(".sc-annot-color").forEach(btn => {
    btn.addEventListener("click", () => {
      annotBar.querySelectorAll(".sc-annot-color").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotColor = btn.dataset.color;
    });
  });

  // 粗细切换
  annotBar.querySelectorAll(".sc-annot-size").forEach(btn => {
    btn.addEventListener("click", () => {
      annotBar.querySelectorAll(".sc-annot-size").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotSize = btn.dataset.size;
    });
  });

  // 撤销
  document.getElementById("sc-annot-undo").addEventListener("click", () => {
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (annotations[i].type !== "click") {
        annotations.splice(i, 1);
        break;
      }
    }
    redrawOverlay();
  });

  // 清除全部
  document.getElementById("sc-annot-clear").addEventListener("click", () => {
    annotations.length = 0;
    currentStroke = null;
    redrawOverlay();
  });

  // 关闭标注按钮
  document.getElementById("sc-annot-close").addEventListener("click", () => {
    setAnnotActive(false);
  });

  // ── 全局快捷键 ────────────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    // Shift+Alt+A（Mac: ⇧⌘A）— 切换标注模式（keydown 作为备用，主要由 commands API 触发）
    // Mac: e.key 可能是 "å"（Option+A），也需兼容
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

    // Ctrl/Cmd+Z — 撤销（仅标注激活时）
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      if (annotActive && (status === "recording" || status === "paused")) {
        for (let i = annotations.length - 1; i >= 0; i--) {
          if (annotations[i].type !== "click") {
            annotations.splice(i, 1);
            break;
          }
        }
        redrawOverlay();
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

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

    if (next === "recording") {
      hideToolbar();
      // 录制开始时标注工具栏默认不显示，等待快捷键呼出
    }
    if (next === "paused") {
      hideToolbar();
    }
    if (next === "idle") {
      clearTimeout(autoHideTimer);
      // 关闭标注模式
      setAnnotActive(false);
      destroyToolbar();
    }

    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: next, startedAt } }).catch(() => {});
  }

  // ── 媒体工具 ─────────────────────────────────────────────────────────────
  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
  }

  function releaseMedia() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    stopTracks(screenStream);
    stopTracks(cameraStream);
    stopTracks(micStream);
    stopTracks(mixedStream);
    screenStream = cameraStream = micStream = mixedStream = null;
    if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {});
    if (screenVideoEl) {
      screenVideoEl.pause();
      screenVideoEl.srcObject = null;
      screenVideoEl.remove();
      screenVideoEl = null;
    }
    annotationCanvas = null;
    annotationCtx = null;
  }

  function stopTimerLoop() {
    if (!timerId) return;
    clearInterval(timerId);
    timerId = null;
  }

  // ── 坐标转换 ──────────────────────────────────────────────────────────────
  /**
   * 将视口 CSS 像素坐标转换为离屏 annotationCanvas 的像素坐标
   * annotationCanvas 尺寸 = 屏幕流实际分辨率
   * 视口尺寸 = window.innerWidth/Height（CSS 像素）
   */
  function viewportToCanvas(clientX, clientY) {
    if (!annotationCanvas) return { x: 0, y: 0 };
    return {
      x: clientX * (annotationCanvas.width  / window.innerWidth),
      y: clientY * (annotationCanvas.height / window.innerHeight)
    };
  }

  /**
   * 将视口 CSS 像素坐标转换为 drawOverlay（视口尺寸）的像素坐标
   * drawOverlay 与视口等尺寸，直接用 clientX/Y
   */
  function viewportToOverlay(clientX, clientY) {
    return { x: clientX, y: clientY };
  }

  // ── 核心绘制函数（通用，接受 ctx、scale） ────────────────────────────────
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} annList   已完成的笔迹列表
   * @param {Object|null} live  当前正在绘制的笔迹（可 null）
   * @param {number} scaleX   x 轴坐标缩放比（canvas坐标 → ctx坐标）
   * @param {number} scaleY   y 轴坐标缩放比
   */
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

    if (live) {
      drawStroke(ctx, live, scaleX, scaleY);
    }
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

  // ── 重绘 drawOverlay 预览层 ──────────────────────────────────────────────
  // 坐标系：annotations 存的是"视口坐标"（与 drawOverlay 等尺寸），scale = 1
  // 仅在标注激活时渲染内容；关闭时始终清空，避免闪现
  function redrawOverlay() {
    const ctx = drawOverlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, drawOverlay.width, drawOverlay.height);
    if (!annotActive) return; // 标注关闭时不渲染任何内容
    renderAnnotations(ctx, annotations, currentStroke, 1, 1);
  }

  // ── 绘图覆盖层事件（事件拦截） ────────────────────────────────────────────
  function initDrawOverlay() {
    function syncOverlaySize() {
      drawOverlay.width  = window.innerWidth;
      drawOverlay.height = window.innerHeight;
    }
    syncOverlaySize();
    window.addEventListener("resize", () => {
      syncOverlaySize();
      redrawOverlay();
    });

    drawOverlay.addEventListener("pointerdown", (e) => {
      // 只在标注激活且录制/暂停状态下响应
      if (!annotActive) return;
      if (status !== "recording" && status !== "paused") return;
      if (e.button !== 0) return;

      // 坐标直接用视口坐标（drawOverlay 与视口等尺寸）
      const pos = viewportToOverlay(e.clientX, e.clientY);
      const lineWidth = SIZE_MAP[annotSize] || SIZE_MAP.medium;
      const opacity   = annotTool === "marker" ? MARKER_OPACITY : 1;

      currentStroke = {
        type:      annotTool,
        color:     annotColor,
        lineWidth,
        opacity,
        points:    [pos]
      };

      drawOverlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    drawOverlay.addEventListener("pointermove", (e) => {
      if (!currentStroke) return;
      const pos = viewportToOverlay(e.clientX, e.clientY);

      if (annotTool === "pen" || annotTool === "marker") {
        currentStroke.points.push(pos);
      } else {
        // 箭头/圆形：只保留起点 + 当前点
        currentStroke.points = [currentStroke.points[0], pos];
      }
      // 实时重绘预览层（用户可见）
      redrawOverlay();
    });

    const endStroke = () => {
      if (!currentStroke) return;
      if (currentStroke.points.length >= 1) {
        annotations.push(currentStroke);
      }
      currentStroke = null;
      redrawOverlay();
    };
    drawOverlay.addEventListener("pointerup",     endStroke);
    drawOverlay.addEventListener("pointercancel", endStroke);
  }

  // ── 点击高亮波纹（Click Highlight） ──────────────────────────────────────
  // 使用视口坐标存储，redrawOverlay 时 scale=1 正好匹配
  function initClickHighlight() {
    document.addEventListener("click", (e) => {
      if (status !== "recording" && status !== "paused") return;
      // 排除标注工具栏和录制工具栏自身的点击
      if (annotBar.contains(e.target) || toolbar.contains(e.target)) return;
      // 仅在标注激活时触发点击波纹，关闭标注后不产生任何波纹
      if (!annotActive) return;

      const pos = viewportToOverlay(e.clientX, e.clientY);
      const clickAnn = {
        type:       "click",
        x:          pos.x,
        y:          pos.y,
        color:      "#ffffff",
        baseRadius: 20, // 视口坐标下 20px，scale=1 时正确
        startTime:  Date.now(),
        duration:   600
      };
      annotations.push(clickAnn);

      // 600ms 后自动移除并重绘
      setTimeout(() => {
        const idx = annotations.indexOf(clickAnn);
        if (idx !== -1) {
          annotations.splice(idx, 1);
          redrawOverlay();
        }
      }, 600);

      // 触发一次 rAF 更新预览（波纹动画需要持续绘制）
      function animateClick() {
        const idx = annotations.indexOf(clickAnn);
        if (idx === -1) return;
        redrawOverlay();
        requestAnimationFrame(animateClick);
      }
      requestAnimationFrame(animateClick);

    }, true); // 捕获阶段
  }

  // ── 屏幕 + 音频混合流（含 Canvas 合成层） ────────────────────────────────
  async function buildMixedStream() {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: true
    });

    screenStream.getVideoTracks()[0].onended = () => {
      if (status === "recording" || status === "paused") stopRecording();
    };

    audioCtx = new AudioContext();
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

    // ── Canvas 合成层 ────────────────────────────────────────────────────
    const screenVideoTrack = screenStream.getVideoTracks()[0];
    const trackSettings    = screenVideoTrack.getSettings();
    const videoWidth       = trackSettings.width  || window.screen.width;
    const videoHeight      = trackSettings.height || window.screen.height;

    // 离屏 canvas（录制用），尺寸 = 屏幕流实际分辨率
    annotationCanvas        = document.createElement("canvas");
    annotationCanvas.width  = videoWidth;
    annotationCanvas.height = videoHeight;
    annotationCtx           = annotationCanvas.getContext("2d");

    // 同步 drawOverlay 到视口尺寸
    drawOverlay.width  = window.innerWidth;
    drawOverlay.height = window.innerHeight;

    // 隐藏的 <video> 接收屏幕流
    screenVideoEl = document.createElement("video");
    screenVideoEl.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    screenVideoEl.srcObject = new MediaStream([screenVideoTrack]);
    screenVideoEl.muted     = true;
    screenVideoEl.playsInline = true;
    document.body.appendChild(screenVideoEl);
    await screenVideoEl.play();

    // rAF 渲染循环：将屏幕帧 + 标注图层合成到离屏 canvas
    // 仅在标注激活时叠加标注层；关闭标注时画面干净（但 annotations 数据保留）
    function renderFrame() {
      if (!annotationCanvas || !annotationCtx || !screenVideoEl) return;
      // 绘制屏幕帧
      annotationCtx.drawImage(screenVideoEl, 0, 0, videoWidth, videoHeight);
      // 仅标注激活时叠加标注层
      if (annotActive) {
        const sx = videoWidth  / window.innerWidth;
        const sy = videoHeight / window.innerHeight;
        renderAnnotations(annotationCtx, annotations, currentStroke, sx, sy);
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
        if (count <= 0) {
          overlay.remove();
          resolve();
          return;
        }
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

      await buildMixedStream();

      hideToolbar();
      await showCountdown();

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

      setStatus("recording");
      timerId = setInterval(updateTimer, 1000);
      updateTimer();

    } catch (error) {
      releaseMedia();
      setStatus("idle");
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
    if (savingOrCleaning) return;
    if (!recorder) {
      cleanup();
      destroyToolbar();
      return;
    }
    if (status === "paused" && pausedAt) {
      pausedDuration += Date.now() - pausedAt;
      pausedAt = null;
    }
    stopTimerLoop();
    status = "idle";
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: { status: "idle", startedAt: null } }).catch(() => {});
    clearTimeout(autoHideTimer);

    // 关闭标注模式
    setAnnotActive(false);

    if (recorder.state !== "inactive") {
      recorder.stop();
    } else {
      releaseMedia();
      destroyToolbar();
    }
  }

  // ── 保存 / 下载 ───────────────────────────────────────────────────────────
  async function saveRecording() {
    if (savingOrCleaning) return;
    savingOrCleaning = true;

    if (!chunks.length) { cleanup(); destroyToolbar(); savingOrCleaning = false; return; }

    const webmBlob = new Blob(chunks, { type: "video/webm" });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `snapcast-${ts}.webm`;

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("文件读取失败，请重试"));
        reader.readAsDataURL(webmBlob);
      });

      await chrome.runtime.sendMessage({
        type: "DOWNLOAD_RECORDING",
        dataUrl,
        filename
      });
    } catch (_err) {
      try {
        const url = URL.createObjectURL(webmBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      } catch (fallbackErr) {
        console.error("SnapCast: 下载完全失败", fallbackErr);
      }
    }

    releaseMedia();
    cleanup();
    destroyToolbar();
    savingOrCleaning = false;
  }

  function destroyToolbar() {
    try { toolbar.remove(); } catch (_) {}
    try { camBubble.remove(); } catch (_) {}
    try { annotBar.remove(); } catch (_) {}
    try { drawOverlay.remove(); } catch (_) {}
    try { document.querySelector("link[href*='content.css']")?.remove(); } catch (_) {}
    window.__snapcastInjected = false;
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

  // ── 初始化 ────────────────────────────────────────────────────────────────
  initDrawOverlay();
  initClickHighlight();

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
      showToolbar();
      pauseRecording();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_STOP") {
      showToolbar();
      stopRecording();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SC_TOGGLE_ANNOT") {
      if (status === "recording" || status === "paused") {
        setAnnotActive(!annotActive);
      }
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
