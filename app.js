
const API_BASE = "https://visitor-entry-api.somchaibutphon.workers.dev";

const SCAN_COOLDOWN_SUCCESS_MS = 350;
const SCAN_COOLDOWN_WARNING_MS = 900;
const SAME_CODE_HOLD_MS = 1800;

const API_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 500;
const MAX_API_RETRY = 1;

const DETECTOR_INTERVAL_MS = 120;
const ZXING_RESTART_DELAY_MS = 300;
const CAMERA_IDLE_TIMEOUT_MS = 180000;

document.addEventListener("DOMContentLoaded", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  const searchInput   = document.getElementById("searchInput");
  const searchBtn     = document.getElementById("searchBtn");
  const qrVideo       = document.getElementById("qrVideo");
  const cameraSelect  = document.getElementById("cameraSelect");
  const startButton   = document.getElementById("startCamera");
  const stopButton    = document.getElementById("stopCamera");
  const cameraStatus  = document.getElementById("cameraStatus");

  const resultCard    = document.getElementById("scanResult");
  const resultGrid    = document.getElementById("resultGrid");
  const resultHint    = document.getElementById("resultHint");
  const clearResult   = document.getElementById("clearResult");

  const zxingReader = new ZXing.BrowserQRCodeReader(undefined, {
    delayBetweenScanAttempts: 60,
    delayBetweenScanSuccess: 60
  });

  const Toast = Swal.mixin({
    toast: true,
    position: "top",
    showConfirmButton: false,
    timerProgressBar: false,
    allowOutsideClick: true,
    allowEscapeKey: true
  });

  let currentDeviceId = "";
  let cameraStarted = false;
  let cameraStarting = false;
  let decodeRunning = false;
  let activeStream = null;
  let videoTrack = null;

  let barcodeDetector = null;
  let detectorTimer = null;
  let idleTimer = null;

  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  let currentRequestId = 0;
  let currentFetchController = null;
  let requestInFlight = false;

  let audioCtx = null;
  let wakeLock = null;

  initDetector_();
  setCameraStatus("กล้องปิดอยู่", "idle");

  document.addEventListener("click", unlockAudio_, { passive: true });
  document.addEventListener("touchstart", unlockAudio_, { passive: true });
  document.addEventListener("pointerdown", unlockAudio_, { passive: true });

  clearResult.addEventListener("click", clearResultCard_);

  searchInput.addEventListener("input", () => {
    searchInput.value = normalizeCode_(searchInput.value);
    bumpIdle_();
  });

  searchInput.addEventListener("keyup", (e) => {
    bumpIdle_();
    if (e.key === "Enter") runSearch(searchInput.value, { source: "manual" });
  });

  searchBtn.addEventListener("click", () => {
    bumpIdle_();
    runSearch(searchInput.value, { source: "manual" });
  });

  startButton.addEventListener("click", async () => {
    if (cameraStarting) return;
    cameraStarting = true;
    try {
      await unlockAudio_();
      await startFlow_();
    } finally {
      cameraStarting = false;
    }
  });

  stopButton.addEventListener("click", () => stopCamera(false));

  cameraSelect.addEventListener("change", async () => {
    if (!cameraStarted) return;
    bumpIdle_();
    await restartWithDevice_(cameraSelect.value);
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      if (cameraStarted) stopCamera(true, true);
      releaseWakeLock_();
    } else if (cameraStarted) {
      acquireWakeLock_();
    }
  });

  window.addEventListener("pagehide", () => {
    abortActiveRequest_();
    stopCamera(true, true);
  });

  function initDetector_() {
    try {
      if ("BarcodeDetector" in window) {
        barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
      }
    } catch (_) {
      barcodeDetector = null;
    }
  }

  function normalizeCode_(value) {
    return String(value || "").replace(/\u00A0/g, " ").trim().toUpperCase();
  }

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isInAppBrowser_() {
    const ua = navigator.userAgent || "";
    return /Line|FBAN|FBAV|Instagram/i.test(ua);
  }

  function setCameraStatus(text, type = "idle") {
    cameraStatus.textContent = text || "";
    cameraStatus.dataset.state = type;
  }

  function getAudioCtx_() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  async function unlockAudio_() {
    try {
      const ctx = getAudioCtx_();
      if (ctx.state === "suspended") await ctx.resume();

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      o.frequency.value = 1;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.02);
    } catch (_) {}
  }

  function playTone_(freq, ms, type, gain) {
    (async () => {
      try {
        const ctx = getAudioCtx_();
        if (ctx.state === "suspended") await ctx.resume();

        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type || "sine";
        o.frequency.value = freq;
        g.gain.value = gain ?? 0.22;

        o.connect(g);
        g.connect(ctx.destination);

        const t0 = ctx.currentTime;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, g.gain.value), t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + (ms / 1000));

        o.start(t0);
        o.stop(t0 + (ms / 1000) + 0.02);
      } catch (_) {}
    })();
  }

  function playScanSound() {
    playTone_(1450, 90, "sine", 0.22);
  }
  function playSuccessSound() {
  playTone_(1500, 120, "sine", 0.24);
}
  function playErrorSound() {
    playTone_(260, 120, "square", 0.22);
    setTimeout(() => playTone_(220, 120, "square", 0.22), 130);
  }

  async function acquireWakeLock_() {
    try {
      if (!("wakeLock" in navigator)) return;
      if (wakeLock) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => {
        wakeLock = null;
      });
    } catch (_) {}
  }

  function releaseWakeLock_() {
    try { wakeLock?.release?.(); } catch (_) {}
    wakeLock = null;
  }

  function bumpIdle_() {
    if (!cameraStarted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stopCamera(true), CAMERA_IDLE_TIMEOUT_MS);
  }

  function showResult(record = {}, hint = "") {
    resultGrid.innerHTML = "";
    resultHint.textContent = hint || "บันทึกสำเร็จ";
    resultCard.classList.remove("is-hidden");
    resultCard.classList.add("flash");

    const preferredOrder = [
      "Auto ID", "รหัส", "ชื่อ-นามสกุล", "ชื่อ-สกุล", "เพศ", "เบอร์โทร",
      "DC", "DC Name", "Timestamp", "Timestamp IN", "Timestamp Out", "Duration"
    ];

    const used = new Set();
    const keys = [];

    preferredOrder.forEach((k) => {
      if (record[k] != null && record[k] !== "") {
        keys.push(k);
        used.add(k);
      }
    });

    Object.keys(record).forEach((k) => {
      if (!used.has(k) && record[k] != null && record[k] !== "") keys.push(k);
    });

    keys.forEach((key) => {
      const k = document.createElement("div");
      k.className = "k";
      k.textContent = key;

      const v = document.createElement("div");
      v.className = "v";
      v.textContent = String(record[key]);

      if (key === "Timestamp" || key === "Timestamp IN") {
        k.classList.add("hl-in");
        v.classList.add("hl-in");
      }
      if (key === "Timestamp Out") {
        k.classList.add("hl-out");
        v.classList.add("hl-out");
      }
      if (key === "Duration") {
        k.classList.add("hl-dur");
        v.classList.add("hl-dur");
      }

      resultGrid.appendChild(k);
      resultGrid.appendChild(v);
    });

    setTimeout(() => resultCard.classList.remove("flash"), 220);
  }

  function clearResultCard_() {
    resultGrid.innerHTML = "";
    resultHint.textContent = "พร้อมสแกน...";
    resultCard.classList.add("is-hidden");
  }

  async function queryCameraPermission_() {
    try {
      if (!navigator.permissions?.query) return "unknown";
      const p = await navigator.permissions.query({ name: "camera" });
      return p.state || "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  async function listVideoDevices_() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  function pickDefaultDevice_(devices) {
    if (!devices?.length) return "";
    if (isMobile_()) {
      const back = devices.find((d) => /back|rear|environment/i.test(d.label || ""));
      return back?.deviceId || devices[0].deviceId || "";
    }
    return devices[0].deviceId || "";
  }

  async function refreshCameraSelect_() {
    const cams = await listVideoDevices_();
    cameraSelect.innerHTML = "";

    cams.forEach((d, idx) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId || "";
      opt.textContent = d.label || `Camera ${idx + 1}`;
      cameraSelect.appendChild(opt);
    });

    const def = pickDefaultDevice_(cams);
    if (!currentDeviceId) currentDeviceId = def;
    if (currentDeviceId) cameraSelect.value = currentDeviceId;

    cameraSelect.style.display = cams.length <= 1 ? "none" : "block";
  }

  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      playErrorSound();
      await Toast.fire({
        icon: "error",
        title: "เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง",
        timer: 1800
      });
      return;
    }

    if (isInAppBrowser_()) {
      await Toast.fire({
        icon: "info",
        title: "แนะนำให้เปิดผ่าน Chrome / Safari",
        timer: 1800
      });
    }

    const p = await queryCameraPermission_();
    if (p === "denied") {
      playErrorSound();
      await Swal.fire({
        icon: "warning",
        title: "ไม่ได้รับอนุญาตใช้กล้อง",
        html: `<div style="text-align:left;font-size:14px">
          กรุณาอนุญาตกล้องในการตั้งค่า แล้วกลับมากด “เปิดกล้อง” อีกครั้ง
        </div>`,
        confirmButtonText: "ตกลง",
        allowOutsideClick: false
      });
      return;
    }

    try {
      setCameraStatus("กำลังเปิดกล้อง...", "loading");
      await openCameraOnce_();
      await refreshCameraSelect_();
      cameraStarted = true;
      setCameraStatus("กล้องพร้อมสแกน", "live");
      await acquireWakeLock_();
      bumpIdle_();
      startDecode_();
    } catch (err) {
      console.error(err);
      playErrorSound();
      setCameraStatus("เปิดกล้องไม่สำเร็จ", "error");

      let msg = "ไม่สามารถเปิดกล้องได้";
      const name = err?.name || "";
      if (name === "NotAllowedError") msg = "คุณไม่ได้อนุญาตให้ใช้กล้อง";
      if (name === "NotFoundError") msg = "ไม่พบกล้องในอุปกรณ์นี้";
      if (name === "NotReadableError") msg = "กล้องกำลังถูกใช้งานโดยแอปอื่น";

      await Swal.fire({
        icon: "error",
        title: "เปิดกล้องไม่สำเร็จ",
        text: msg,
        confirmButtonText: "ตกลง"
      });
    }
  }

  async function openCameraOnce_() {
    await stopCamera(true, true);

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
      videoTrack = stream.getVideoTracks()[0] || null;
      qrVideo.srcObject = stream;
      qrVideo.setAttribute("playsinline", "true");
      qrVideo.setAttribute("webkit-playsinline", "true");
      qrVideo.muted = true;
      await qrVideo.play();
      return true;
    };

    const wantDeviceId = cameraSelect.value || currentDeviceId || "";

    if (wantDeviceId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: wantDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 24, max: 30 }
          }
        });
        currentDeviceId = wantDeviceId;
        return;
      } catch (_) {}
    }

    try {
      await tryOpen({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 }
        }
      });
      const settings = videoTrack?.getSettings?.() || {};
      if (settings.deviceId) currentDeviceId = settings.deviceId;
      return;
    } catch (_) {}

    await tryOpen({ video: true, audio: false });
  }

  async function restartWithDevice_(deviceId) {
    currentDeviceId = deviceId || currentDeviceId || "";
    try {
      setCameraStatus("กำลังสลับกล้อง...", "loading");
      await openCameraOnce_();
      cameraStarted = true;
      setCameraStatus("กล้องพร้อมสแกน", "live");
      bumpIdle_();
      startDecode_();
    } catch (err) {
      console.error(err);
      playErrorSound();
      cameraStarted = false;
      setCameraStatus("สลับกล้องไม่สำเร็จ", "error");

      await Toast.fire({
        icon: "error",
        title: "สลับกล้องไม่สำเร็จ",
        timer: 1600
      });
    }
  }

  async function stopCamera(fromIdle, silent = false) {
    requestInFlight = false;
    decodeRunning = false;

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (detectorTimer) {
      clearTimeout(detectorTimer);
      detectorTimer = null;
    }

    abortActiveRequest_();

    try { zxingReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }

    activeStream = null;
    videoTrack = null;
    cameraStarted = false;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;

    releaseWakeLock_();
    setCameraStatus("กล้องปิดอยู่", "idle");

    if (fromIdle && !silent) {
      await Toast.fire({
        icon: "info",
        title: "ปิดกล้องอัตโนมัติ",
        timer: 1400
      });
    }
  }

  function startDecode_() {
    if (!cameraStarted || decodeRunning) return;
    decodeRunning = true;

    if (barcodeDetector) {
      detectorLoop_();
    } else {
      zxingLoop_();
    }
  }

  function stopDecode_() {
    decodeRunning = false;
    if (detectorTimer) {
      clearTimeout(detectorTimer);
      detectorTimer = null;
    }
    try { zxingReader.reset(); } catch (_) {}
  }

  async function detectorLoop_() {
    if (!decodeRunning || !cameraStarted || !barcodeDetector) return;

    try {
      if (qrVideo.readyState >= 2) {
        const barcodes = await barcodeDetector.detect(qrVideo);
        if (Array.isArray(barcodes) && barcodes.length > 0) {
          const text = normalizeCode_(barcodes[0].rawValue || "");
          if (text) {
            const accepted = await handleDecodedText_(text);
            if (accepted) return;
          }
        }
      }
    } catch (_) {}

    detectorTimer = setTimeout(detectorLoop_, DETECTOR_INTERVAL_MS);
  }

  function zxingLoop_() {
    try { zxingReader.reset(); } catch (_) {}

    zxingReader.decodeFromVideoDevice(currentDeviceId || null, qrVideo, async (result) => {
      if (!decodeRunning || !cameraStarted) return;
      if (!result) return;

      const text = normalizeCode_(result.getText() || "");
      if (!text) return;

      const accepted = await handleDecodedText_(text);
      if (accepted) return;
    });
  }

  function canAcceptCode_(text) {
    const now = Date.now();

    if (requestInFlight) return false;
    if (now - lastScanAt < SCAN_COOLDOWN_SUCCESS_MS) return false;
    if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return false;

    return true;
  }

  async function handleDecodedText_(text) {
    bumpIdle_();

    if (!canAcceptCode_(text)) return false;

    lastScanAt = Date.now();
    lastText = text;
    lastTextAt = Date.now();

    playScanSound();
    stopDecode_();

    try {
      await runSearch(text, { source: "camera" });
      return true;
    } finally {
      setTimeout(() => {
        if (cameraStarted && !decodeRunning) startDecode_();
      }, ZXING_RESTART_DELAY_MS);
    }
  }

  function nextRequestId_() {
    currentRequestId += 1;
    return currentRequestId;
  }

  function abortActiveRequest_() {
    try { currentFetchController?.abort?.(); } catch (_) {}
    currentFetchController = null;
  }

  async function runSearch(query, options = {}) {
    query = normalizeCode_(query);
    if (!query) return;

    bumpIdle_();
    const reqId = nextRequestId_();
    requestInFlight = true;
    setCameraStatus("กำลังค้นหา...", "loading");

    try {
      const res = await apiSearchWithRetry_(query, MAX_API_RETRY);
      if (reqId !== currentRequestId) return;

      const record = res?.data?.record || {};

      if (res.status === "success") {
  showResult(record, res.detail || "บันทึกสำเร็จ");
  setCameraStatus("บันทึกสำเร็จ", "success");
  playSuccessSound();

  await Toast.fire({
    icon: "success",
    title: res.title || "บันทึกสำเร็จ",
    timer: 1100
  });

  searchInput.value = "";
  lastScanAt = Date.now();
  return;
}

      if (res.status === "duplicate") {
        playErrorSound();
        setCameraStatus("พบข้อมูลซ้ำ", "warning");
        if (Object.keys(record).length) {
          showResult(record, res.detail || "ข้อมูลนี้ออกระบบแล้ว");
        }

        await Toast.fire({
          icon: "warning",
          title: res.title || "บันทึกซ้ำไม่ได้",
          text: res.detail || "",
          timer: 1600
        });

        searchInput.value = "";
        lastScanAt = Date.now() - (SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS);
        return;
      }

      if (res.status === "not_found") {
        playErrorSound();
        setCameraStatus("ไม่พบข้อมูล", "warning");
        clearResultCard_();

        await Toast.fire({
          icon: "warning",
          title: res.title || "ไม่พบข้อมูล",
          text: res.detail || "",
          timer: 1600
        });

        searchInput.value = "";
        lastScanAt = Date.now() - (SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS);
        return;
      }

      playErrorSound();
      setCameraStatus("เกิดข้อผิดพลาด", "error");
      if (Object.keys(record).length) {
        showResult(record, res.detail || "เกิดข้อผิดพลาด");
      }

      await Toast.fire({
        icon: "error",
        title: res.title || "เกิดข้อผิดพลาด",
        text: res.detail || res.error || "ไม่สามารถประมวลผลได้",
        timer: 1800
      });

      searchInput.value = "";
      lastScanAt = Date.now() - (SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS);

    } catch (err) {
      console.error(err);
      if (reqId !== currentRequestId) return;

      playErrorSound();
      setCameraStatus("เชื่อมต่อไม่สำเร็จ", "error");

      await Toast.fire({
        icon: "error",
        title: "เชื่อมต่อไม่สำเร็จ",
        text: String(err?.message || err),
        timer: 1800
      });

      lastScanAt = Date.now() - (SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS);
    } finally {
      requestInFlight = false;
      bumpIdle_();
      if (options.source === "manual") {
        searchInput.focus();
        searchInput.select?.();
      }
    }
  }

  async function apiSearch_(query) {
    abortActiveRequest_();

    const controller = new AbortController();
    currentFetchController = controller;

    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const url = `${API_BASE}/api/search?query=${encodeURIComponent(query)}&_ts=${Date.now()}`;
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "Accept": "application/json"
        }
      });

      let data;
      try {
        data = await res.json();
      } catch (_) {
        throw new Error("API ส่งข้อมูลไม่ถูกต้อง");
      }

      return data;
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("หมดเวลารอการเชื่อมต่อ");
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (currentFetchController === controller) {
        currentFetchController = null;
      }
    }
  }

  async function apiSearchWithRetry_(query, retries = 1) {
    try {
      return await apiSearch_(query);
    } catch (err) {
      if (retries <= 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return apiSearchWithRetry_(query, retries - 1);
    }
  }
});




