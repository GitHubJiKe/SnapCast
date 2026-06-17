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

  // 区域录制相关
  let cropRegion = null;       // { x, y, w, h } 屏幕流坐标（null = 全屏录制）
  let fullVideoWidth  = 0;     // 屏幕流实际宽度（用于 F1 标注坐标换算）
  let fullVideoHeight = 0;     // 屏幕流实际高度

  // 录制配置（由 popup 通过消息传入）
  let recConfig = {
    mic: true,
    camera: true,
    enableCrop: false,
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
    cropRegion = null;
    fullVideoWidth  = 0;
    fullVideoHeight = 0;
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

  // ── 区域录制模式下的标注合成（F1+F3 联动） ───────────────────────────────
  /**
   * 将视口坐标的笔迹渲染到裁切后的 canvas 坐标系中。
   *
   * 坐标变换逻辑：
   *   视口坐标 (vx, vy)
   *   → 屏幕流坐标: vx * streamScaleX, vy * streamScaleY
   *   → 裁切区域内坐标: - offX, - offY
   *   → canvas 输出坐标（因为 canvas 尺寸 = cropRegion 尺寸，所以无需额外缩放）
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array}  annList       已完成笔迹列表
   * @param {object|null} live     当前正在绘制的笔迹
   * @param {number} sx            streamScaleX = fullVideoWidth / window.innerWidth
   * @param {number} sy            streamScaleY = fullVideoHeight / window.innerHeight
   * @param {number} offX          cropRegion.x（屏幕流坐标原点偏移）
   * @param {number} offY          cropRegion.y
   */
  function renderAnnotationsCropped(ctx, annList, live, sx, sy, offX, offY) {
    const now = Date.now();

    for (const ann of annList) {
      if (ann.type === "click") {
        const elapsed = now - ann.startTime;
        if (elapsed > ann.duration) continue;
        const progress = elapsed / ann.duration;
        // 将视口坐标换算到裁切后 canvas 坐标
        const cx = ann.x * sx - offX;
        const cy = ann.y * sy - offY;
        // 跳过选区外的波纹
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

    if (live) {
      drawStrokeCropped(ctx, live, sx, sy, offX, offY);
    }
  }

  /**
   * 在裁切坐标系中绘制一条笔迹。
   * 坐标变换：canvas_x = viewport_x * sx - offX
   */
  function drawStrokeCropped(ctx, ann, sx, sy, offX, offY) {
    if (!ann.points || ann.points.length === 0) return;

    // 将坐标变换内联：转换函数 f(p) = { x: p.x * sx - offX, y: p.y * sy - offY }
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
      const cxc = (p0x + p1x) / 2;
      const cyc = (p0y + p1y) / 2;
      ctx.beginPath();
      ctx.ellipse(cxc, cyc, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
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

  // ── 区域选择 UI ───────────────────────────────────────────────────────────
  /**
   * 显示全屏选区蒙层，让用户拖拽选择录制区域。
   * @returns {Promise<{x,y,w,h}>} resolve：CSS 视口坐标的选区；reject：用户取消
   */
  function showRegionSelector() {
    return new Promise((resolve, reject) => {
      // ── 外层容器（接收拖拽事件，不遮挡选区内部） ───────────────────────
      const container = document.createElement("div");
      container.id = "snapcast-region-container";
      document.body.appendChild(container);

      // ── 四分遮罩 div ─────────────────────────────────────────────────────
      const maskTop    = document.createElement("div");
      const maskBottom = document.createElement("div");
      const maskLeft   = document.createElement("div");
      const maskRight  = document.createElement("div");
      maskTop.className    = "sc-region-mask sc-region-mask-top";
      maskBottom.className = "sc-region-mask sc-region-mask-bottom";
      maskLeft.className   = "sc-region-mask sc-region-mask-left";
      maskRight.className  = "sc-region-mask sc-region-mask-right";
      // 初始状态：四个遮罩各自铺满对应方向
      maskTop.style.cssText    = "top:0;left:0;right:0;height:100%";
      maskBottom.style.cssText = "bottom:0;left:0;right:0;height:0";
      maskLeft.style.cssText   = "top:0;left:0;width:0;bottom:0";
      maskRight.style.cssText  = "top:0;right:0;width:0;bottom:0";
      container.appendChild(maskTop);
      container.appendChild(maskBottom);
      container.appendChild(maskLeft);
      container.appendChild(maskRight);

      // ── 选区边框 ─────────────────────────────────────────────────────────
      const selBox = document.createElement("div");
      selBox.id = "snapcast-region-selbox";
      container.appendChild(selBox);

      // ── 尺寸提示 ─────────────────────────────────────────────────────────
      const sizeHint = document.createElement("div");
      sizeHint.id = "snapcast-region-size-hint";
      container.appendChild(sizeHint);

      // ── 操作提示（未拖拽时） ─────────────────────────────────────────────
      const guide = document.createElement("div");
      guide.id = "snapcast-region-guide";
      guide.innerHTML = `<span>拖拽选择录制区域</span><small>按 Esc 取消</small>`;
      container.appendChild(guide);

      // ── 确认工具栏（拖拽结束后显示） ────────────────────────────────────
      const actionBar = document.createElement("div");
      actionBar.id = "snapcast-region-actionbar";
      actionBar.innerHTML = `
        <button id="sc-region-cancel" class="sc-region-btn sc-region-btn-cancel">取消</button>
        <span id="sc-region-warn" class="sc-region-warn"></span>
        <button id="sc-region-confirm" class="sc-region-btn sc-region-btn-confirm">开始录制</button>
      `;
      actionBar.style.display = "none";
      container.appendChild(actionBar);

      // ── 拖拽逻辑 ─────────────────────────────────────────────────────────
      let dragging = false;
      let startX = 0, startY = 0;
      let currentRegion = null; // { x, y, w, h } CSS 视口坐标

      /** 根据当前 currentRegion 更新四分遮罩 + 选区边框 */
      function updateUI(r) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x2 = r.x + r.w;
        const y2 = r.y + r.h;

        // 上遮罩：全宽，高度到选区顶部
        maskTop.style.cssText    = `top:0;left:0;right:0;height:${r.y}px`;
        // 下遮罩：全宽，从选区底部到视口底部
        maskBottom.style.cssText = `bottom:0;left:0;right:0;top:${y2}px`;
        // 左遮罩：选区左侧，高度 = 选区高度
        maskLeft.style.cssText   = `top:${r.y}px;left:0;width:${r.x}px;height:${r.h}px`;
        // 右遮罩：选区右侧，高度 = 选区高度
        maskRight.style.cssText  = `top:${r.y}px;right:0;left:${x2}px;height:${r.h}px`;

        // 选区边框
        selBox.style.cssText = `
          display:block;
          left:${r.x}px;top:${r.y}px;
          width:${r.w}px;height:${r.h}px
        `;

        // 尺寸提示（跟随选区右上角）
        sizeHint.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
        const hintX = Math.min(r.x + r.w + 6, vw - 90);
        const hintY = Math.max(r.y - 24, 4);
        sizeHint.style.cssText = `display:block;left:${hintX}px;top:${hintY}px`;

        // 操作栏跟随选区底部
        const barY = Math.min(y2 + 10, vh - 52);
        const barX = Math.max(Math.min(r.x + r.w - 220, vw - 226), 6);
        actionBar.style.cssText = `display:flex;left:${barX}px;top:${barY}px`;

        // 最小尺寸警告
        const warnEl = document.getElementById("sc-region-warn");
        if (r.w < 160 || r.h < 90) {
          warnEl.textContent = "选区过小";
          document.getElementById("sc-region-confirm").disabled = true;
        } else {
          warnEl.textContent = "";
          document.getElementById("sc-region-confirm").disabled = false;
        }
      }

      container.addEventListener("pointerdown", (e) => {
        // 点到操作栏内的按钮不触发拖拽
        if (actionBar.contains(e.target)) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
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

      container.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        // 拖拽结束后保持选区显示，等待用户确认
      });

      // ── 确认/取消 ────────────────────────────────────────────────────────
      function doCancel() {
        container.remove();
        reject(new Error("用户取消区域选择"));
      }

      function doConfirm() {
        if (!currentRegion || currentRegion.w < 160 || currentRegion.h < 90) return;
        container.remove();
        resolve(currentRegion);
      }

      document.getElementById("sc-region-cancel").addEventListener("click", doCancel);
      document.getElementById("sc-region-confirm").addEventListener("click", doConfirm);

      // Esc 键取消
      function onKeyDown(e) {
        if (e.key === "Escape") {
          document.removeEventListener("keydown", onKeyDown);
          doCancel();
        }
      }
      document.addEventListener("keydown", onKeyDown);
    });
  }

  // ── 屏幕 + 音频混合流（含 Canvas 合成层） ────────────────────────────────
  /**
   * @param {object|null} cssRegion  用户选区（CSS 视口坐标），null 表示全屏录制
   */
  async function buildMixedStream(cssRegion) {
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
    fullVideoWidth  = trackSettings.width  || window.screen.width;
    fullVideoHeight = trackSettings.height || window.screen.height;

    // ── 坐标换算：CSS 视口 → 屏幕流坐标 ────────────────────────────────
    // 注意：不使用 devicePixelRatio，而是用流尺寸与视口尺寸的比值，
    // 这样在 Retina/Windows 缩放场景下也能正确映射。
    cropRegion = null;
    if (cssRegion) {
      // 如果用户选了"整个屏幕"（displaySurface=monitor），区域录制不可靠，自动降级
      if (trackSettings.displaySurface === "monitor") {
        console.warn("SnapCast: 区域录制在全屏捕获模式下不支持，已自动降级为全屏录制");
        // cropRegion 保持 null，走全屏路径
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

    // canvas 输出尺寸：区域录制 = 选区尺寸，全屏 = 流尺寸
    const outWidth  = cropRegion ? cropRegion.w : fullVideoWidth;
    const outHeight = cropRegion ? cropRegion.h : fullVideoHeight;

    // 离屏 canvas（录制用）
    annotationCanvas        = document.createElement("canvas");
    annotationCanvas.width  = outWidth;
    annotationCanvas.height = outHeight;
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
    function renderFrame() {
      if (!annotationCanvas || !annotationCtx || !screenVideoEl) return;

      if (cropRegion) {
        // 区域裁切：从屏幕流裁取 cropRegion，绘满整个 canvas
        annotationCtx.drawImage(
          screenVideoEl,
          cropRegion.x, cropRegion.y, cropRegion.w, cropRegion.h,  // source
          0, 0, outWidth, outHeight                                  // dest
        );
      } else {
        // 全屏录制
        annotationCtx.drawImage(screenVideoEl, 0, 0, outWidth, outHeight);
      }

      // 仅标注激活时叠加标注层
      if (annotActive) {
        if (cropRegion) {
          // 区域录制模式：视口坐标 → 裁切后 canvas 坐标
          // scaleX/Y = (canvas尺寸 / 全屏流尺寸) * (全屏流尺寸 / 视口尺寸)
          //          = canvas尺寸 / 视口尺寸
          // 但坐标原点需要减去选区偏移（屏幕流坐标），再缩放到 canvas 坐标
          const streamScaleX = fullVideoWidth  / window.innerWidth;
          const streamScaleY = fullVideoHeight / window.innerHeight;
          // 将视口坐标的笔迹偏移到选区本地坐标系后，再映射到 canvas 输出坐标
          // 视口坐标 → 屏幕流坐标：* streamScale
          // 减去选区原点偏移：- cropRegion.x/y
          // 屏幕流选区坐标 → canvas 坐标：/ cropRegion.w * outWidth (= 1，因为 outWidth=cropRegion.w)
          // 因此等效 scaleX = outWidth / cropRegion.w * streamScaleX = streamScaleX（因为outWidth=cropRegion.w）
          const sx = streamScaleX;
          const sy = streamScaleY;
          const offX = cropRegion.x; // 屏幕流坐标偏移
          const offY = cropRegion.y;
          renderAnnotationsCropped(annotationCtx, annotations, currentStroke, sx, sy, offX, offY);
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
      cropRegion = null;

      // ① 如果开启了区域录制，先让用户拖拽选区
      let cssRegion = null;
      if (recConfig.enableCrop) {
        try {
          cssRegion = await showRegionSelector();
          // ② 关键：等待两帧，确保选区蒙层 DOM 已完全从页面移除，
          //    否则蒙层会出现在 getDisplayMedia 捕获的内容里
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        } catch (_) {
          // 用户取消选区，终止录制流程
          setStatus("idle");
          return;
        }
      }

      // ③ 获取屏幕流（此时页面无蒙层），并完成 Canvas 合成层初始化
      await buildMixedStream(cssRegion);

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
