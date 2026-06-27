const API_BASE = "https://visitor-entry-api.somchaibutphon.workers.dev";

const SCAN_COOLDOWN_SUCCESS_MS = 350;
const SCAN_COOLDOWN_WARNING_MS = 900;
const SAME_CODE_HOLD_MS = 1800;
const SKDC_SAME_CODE_HOLD_MS = 500;
const SKDC_REARM_ABSENCE_MS = 1500;

const API_TIMEOUT_MS = 55000;
const RESULT_AUTO_CLOSE_MS = 3000;

const DETECTOR_INTERVAL_MS = 120;
const ZXING_RESTART_DELAY_MS = 300;
const CAMERA_IDLE_TIMEOUT_MS = 180000;

document.addEventListener("DOMContentLoaded", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");
  const videoWrap = document.getElementById("videoWrap");
  const qrVideo = document.getElementById("qrVideo");
  const cameraSelect = document.getElementById("cameraSelect");
  const startButton = document.getElementById("startCamera");
  const stopButton = document.getElementById("stopCamera");
  const cameraStatus = document.getElementById("cameraStatus");

  const resultCard = document.getElementById("scanResult");
  const resultGrid = document.getElementById("resultGrid");
  const resultHint = document.getElementById("resultHint");
  const resultTitle = document.getElementById("resultTitle");
  const resultActionBadge = document.getElementById("resultActionBadge");
  const resultMedia = document.getElementById("resultMedia");

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

  // หนึ่งการยื่นบัตร SKDC ต่อหน้ากล้อง = หนึ่งรายการเท่านั้น
  // จะปลดล็อกเมื่อบัตรหายจากภาพต่อเนื่องตามเวลาที่กำหนด
  let skdcLatchedCode = "";
  let skdcPresentationId = "";
  let skdcLastSeenAt = 0;

  let currentRequestId = 0;
  let currentFetchController = null;
  let requestInFlight = false;
  let resultVisible = false;
  let resultAutoCloseTimer = null;

  let audioCtx = null;
  let wakeLock = null;

  initDetector_();
  setCameraStatus_("กล้องปิดอยู่", "idle");
  setBusy_(false);

  document.addEventListener("click", unlockAudio_, { passive: true });
  document.addEventListener("touchstart", unlockAudio_, { passive: true });
  document.addEventListener("pointerdown", unlockAudio_, { passive: true });

  searchInput.addEventListener("input", () => {
    searchInput.value = normalizeCode_(searchInput.value);
    bumpIdle_();
  });

  searchInput.addEventListener("keyup", (event) => {
    bumpIdle_();
    if (event.key === "Enter") {
      runSearch_(searchInput.value, { source: "manual" });
    }
  });

  searchBtn.addEventListener("click", () => {
    bumpIdle_();
    runSearch_(searchInput.value, { source: "manual" });
  });

  startButton.addEventListener("click", async () => {
    if (cameraStarting) return;

    cameraStarting = true;
    startButton.disabled = true;

    try {
      await unlockAudio_();
      await startFlow_();
    } finally {
      cameraStarting = false;
      startButton.disabled = false;
      cameraSelect.disabled = requestInFlight;
    }
  });

  stopButton.addEventListener("click", () => {
    stopCamera_(false);
  });

  cameraSelect.addEventListener("change", async () => {
    if (!cameraStarted || cameraStarting) return;

    bumpIdle_();
    await restartWithDevice_(cameraSelect.value);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (cameraStarted) stopCamera_(true, true);
      releaseWakeLock_();
    }
  });

  window.addEventListener("pagehide", () => {
    invalidateActiveRequest_();
    stopCamera_(true, true);
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
    return String(value || "")
      .replace(/\u00A0/g, " ")
      .trim()
      .toUpperCase();
  }

  function isSkdcCode_(value) {
    return normalizeCode_(value).startsWith("SKDC");
  }

  function createClientRequestId_() {
    try {
      return crypto.randomUUID();
    } catch (_) {
      return `req_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    }
  }

  function beginSkdcPresentation_(code) {
    skdcLatchedCode = normalizeCode_(code);
    skdcPresentationId = createClientRequestId_();
    skdcLastSeenAt = Date.now();
    return skdcPresentationId;
  }

  function observeDetectedCode_(code) {
    const normalized = normalizeCode_(code);
    if (!skdcLatchedCode) return;

    if (normalized === skdcLatchedCode) {
      skdcLastSeenAt = Date.now();
      return;
    }

    // พบ QR คนละใบ แสดงว่าบัตรเดิมพ้นจากกล้องแล้ว
    if (normalized) {
      clearSkdcPresentationLock_();
    }
  }

  function observeNoCode_() {
    if (!skdcLatchedCode || !skdcLastSeenAt) return;

    if (Date.now() - skdcLastSeenAt >= SKDC_REARM_ABSENCE_MS) {
      clearSkdcPresentationLock_();
    }
  }

  function clearSkdcPresentationLock_() {
    skdcLatchedCode = "";
    skdcPresentationId = "";
    skdcLastSeenAt = 0;

    if (
      cameraStarted &&
      !requestInFlight &&
      !resultVisible
    ) {
      setCameraStatus_("กล้องพร้อมสแกน", "live");
    }
  }

  function isSafeImageUrl_(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:";
    } catch (_) {
      return false;
    }
  }

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isInAppBrowser_() {
    const ua = navigator.userAgent || "";
    return /Line|FBAN|FBAV|Instagram/i.test(ua);
  }

  function setCameraStatus_(text, type = "idle") {
    cameraStatus.textContent = text || "";
    cameraStatus.dataset.state = type;
  }

  function setBusy_(busy) {
    requestInFlight = Boolean(busy);
    searchBtn.disabled = requestInFlight;
    searchInput.disabled = requestInFlight;
    cameraSelect.disabled = requestInFlight || cameraStarting;
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

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.value = 0.0001;
      oscillator.frequency.value = 1;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.02);
    } catch (_) {}
  }

  function playTone_(freq, ms, type, gainValue) {
    (async () => {
      try {
        const ctx = getAudioCtx_();
        if (ctx.state === "suspended") await ctx.resume();

        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = type || "sine";
        oscillator.frequency.value = freq;
        gain.gain.value = gainValue ?? 0.22;

        oscillator.connect(gain);
        gain.connect(ctx.destination);

        const startAt = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(
          Math.max(0.0001, gain.gain.value),
          startAt + 0.01
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          startAt + (ms / 1000)
        );

        oscillator.start(startAt);
        oscillator.stop(startAt + (ms / 1000) + 0.02);
      } catch (_) {}
    })();
  }

  function playScanSound_() {
    playTone_(1450, 90, "sine", 0.22);
  }

  function playSuccessSound_() {
    playTone_(1350, 90, "sine", 0.24);
    setTimeout(() => playTone_(1750, 130, "sine", 0.28), 95);
  }

  function playDuplicateSound_() {
    playTone_(430, 180, "square", 0.34);
    setTimeout(() => playTone_(430, 180, "square", 0.34), 220);
    setTimeout(() => playTone_(290, 300, "square", 0.38), 440);

    try {
      navigator.vibrate?.([180, 90, 180, 90, 300]);
    } catch (_) {}
  }

  function playBlockedSound_() {
    playTone_(240, 260, "sawtooth", 0.34);
    setTimeout(() => playTone_(180, 420, "sawtooth", 0.38), 285);

    try {
      navigator.vibrate?.([320, 120, 520]);
    } catch (_) {}
  }

  function playErrorSound_() {
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
    try {
      wakeLock?.release?.();
    } catch (_) {}
    wakeLock = null;
  }

  function bumpIdle_() {
    if (!cameraStarted) return;

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopCamera_(true);
    }, CAMERA_IDLE_TIMEOUT_MS);
  }

  function clearResultAutoClose_() {
    if (!resultAutoCloseTimer) return;

    clearTimeout(resultAutoCloseTimer);
    resultAutoCloseTimer = null;
  }

  function scheduleResultAutoClose_() {
    clearResultAutoClose_();

    resultAutoCloseTimer = setTimeout(() => {
      resultAutoCloseTimer = null;
      resumeAfterResult_();
    }, RESULT_AUTO_CLOSE_MS);
  }

  function showResult_(record = {}, options = {}) {
    clearResultAutoClose_();

    const title = String(options.title || "ผลการสแกน");
    const hint = String(options.hint || "ดำเนินการเรียบร้อย");
    const state = String(options.state || "success").toLowerCase();
    const action = String(options.action || "").toUpperCase();

    resultGrid.innerHTML = "";
    resultMedia.innerHTML = "";
    resultTitle.textContent = title;
    resultHint.textContent = hint;

    resultCard.dataset.state = state;
    videoWrap.dataset.resultState = state;

    resultActionBadge.className = "result-action-badge is-hidden";
    resultActionBadge.textContent = "";

    if (action === "IN" || action === "OUT") {
      resultActionBadge.textContent =
        action === "IN" ? "เข้าพื้นที่" : "ออกจากพื้นที่";
      resultActionBadge.className =
        `result-action-badge action-${action.toLowerCase()}`;
    }

    const imageUrl = String(
      record["ลิงค์ภาพถ่าย"] ||
      record.imageUrl ||
      ""
    ).trim();

    if (imageUrl && isSafeImageUrl_(imageUrl)) {
      const image = document.createElement("img");
      image.className = "result-photo";
      image.src = imageUrl;
      image.alt = "ภาพผู้ถือบัตร";
      image.loading = "eager";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";

      const fallback = document.createElement("div");
      fallback.className = "result-photo-fallback is-hidden";
      fallback.textContent = "ไม่สามารถแสดงภาพได้";

      image.addEventListener("error", () => {
        image.remove();
        fallback.classList.remove("is-hidden");
      }, { once: true });

      resultMedia.appendChild(image);
      resultMedia.appendChild(fallback);
      resultMedia.classList.remove("is-hidden");
    } else {
      resultMedia.classList.add("is-hidden");
    }

    const preferredOrder = isSkdcCode_(
      record["ID Card"] || ""
    )
      ? [
          "ID Card",
          "ชื่อ-นามสกุล",
          "ต้นสังกัด/บริษัท",
          "DC",
          "วันหมดอายุบัตร/Passport",
          "จำนวนวันคงเหลือ",
          "Timestamp IN",
          "Timestamp Out",
          "Duration"
        ]
      : [
          "Auto ID",
          "รหัส",
          "ชื่อ-นามสกุล",
          "ชื่อ-สกุล",
          "เพศ",
          "เบอร์โทร",
          "DC",
          "DC Name",
          "Timestamp",
          "Timestamp IN",
          "Timestamp Out",
          "Duration"
        ];

    const hiddenFields = new Set([
      "ลิงค์ภาพถ่าย",
      "imageUrl"
    ]);

    const used = new Set();
    const keys = [];

    preferredOrder.forEach((key) => {
      if (
        !hiddenFields.has(key) &&
        record[key] != null &&
        record[key] !== ""
      ) {
        keys.push(key);
        used.add(key);
      }
    });

    Object.keys(record).forEach((key) => {
      if (
        !used.has(key) &&
        !hiddenFields.has(key) &&
        record[key] != null &&
        record[key] !== ""
      ) {
        keys.push(key);
      }
    });

    if (!keys.length) {
      const empty = document.createElement("div");
      empty.className = "result-empty";
      empty.textContent = "ไม่มีรายละเอียดเพิ่มเติม";
      resultGrid.appendChild(empty);
    } else {
      keys.forEach((key) => {
        const keyElement = document.createElement("div");
        keyElement.className = "k";
        keyElement.textContent = key;

        const valueElement = document.createElement("div");
        valueElement.className = "v";
        valueElement.textContent = String(record[key]);

        if (key === "Timestamp" || key === "Timestamp IN") {
          keyElement.classList.add("hl-in");
          valueElement.classList.add("hl-in");
        }

        if (key === "Timestamp Out") {
          keyElement.classList.add("hl-out");
          valueElement.classList.add("hl-out");
        }

        if (key === "Duration") {
          keyElement.classList.add("hl-dur");
          valueElement.classList.add("hl-dur");
        }

        if (
          key === "วันหมดอายุบัตร/Passport" ||
          key === "จำนวนวันคงเหลือ"
        ) {
          keyElement.classList.add("hl-expiry");
          valueElement.classList.add("hl-expiry");
        }

        resultGrid.appendChild(keyElement);
        resultGrid.appendChild(valueElement);
      });
    }

    resultVisible = true;
    stopDecode_();

    resultCard.classList.remove("is-hidden");
    resultCard.classList.remove("flash");
    videoWrap.classList.add("has-result");
    resultCard.scrollTop = 0;

    requestAnimationFrame(() => {
      resultCard.classList.add("flash");
      videoWrap.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });

    setTimeout(() => {
      resultCard.classList.remove("flash");
    }, 240);

    scheduleResultAutoClose_();
  }

  function hideResult_() {
    clearResultAutoClose_();
    resultVisible = false;
    resultGrid.innerHTML = "";
    resultMedia.innerHTML = "";
    resultMedia.classList.add("is-hidden");
    resultTitle.textContent = "ผลการสแกน";
    resultHint.textContent = "พร้อมสแกน...";
    resultActionBadge.textContent = "";
    resultActionBadge.className = "result-action-badge is-hidden";
    resultCard.dataset.state = "";
    videoWrap.dataset.resultState = "";
    resultCard.classList.add("is-hidden");
    resultCard.classList.remove("flash");
    videoWrap.classList.remove("has-result");
  }

  function resumeAfterResult_() {
    if (!resultVisible) return;

    hideResult_();
    searchInput.value = "";

    if (cameraStarted) {
      if (skdcLatchedCode) {
        setCameraStatus_(
          "กรุณานำบัตรออกจากหน้ากล้อง",
          "warning"
        );
      } else {
        setCameraStatus_("กล้องพร้อมสแกน", "live");
      }

      bumpIdle_();
      startDecode_();
      videoWrap.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
      return;
    }

    setCameraStatus_("กล้องปิดอยู่", "idle");
    searchInput.focus();
  }

  async function queryCameraPermission_() {
    try {
      if (!navigator.permissions?.query) return "unknown";
      const permission = await navigator.permissions.query({ name: "camera" });
      return permission.state || "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  async function listVideoDevices_() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  }

  function pickDefaultDevice_(devices) {
    if (!devices?.length) return "";

    if (isMobile_()) {
      const backCamera = devices.find((device) => {
        return /back|rear|environment/i.test(device.label || "");
      });

      return backCamera?.deviceId || devices[0].deviceId || "";
    }

    return devices[0].deviceId || "";
  }

  async function refreshCameraSelect_() {
    const cameras = await listVideoDevices_();
    cameraSelect.innerHTML = "";

    cameras.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId || "";
      option.textContent = device.label || `Camera ${index + 1}`;
      cameraSelect.appendChild(option);
    });

    const defaultDevice = pickDefaultDevice_(cameras);
    if (!currentDeviceId) currentDeviceId = defaultDevice;
    if (currentDeviceId) cameraSelect.value = currentDeviceId;

    cameraSelect.style.display = cameras.length <= 1 ? "none" : "block";
  }

  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      playErrorSound_();
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

    const permission = await queryCameraPermission_();

    if (permission === "denied") {
      playErrorSound_();
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
      hideResult_();
      setCameraStatus_("กำลังเปิดกล้อง...", "loading");
      await openCameraOnce_();
      await refreshCameraSelect_();

      cameraStarted = true;
      setCameraStatus_("กล้องพร้อมสแกน", "live");
      await acquireWakeLock_();
      bumpIdle_();
      startDecode_();
    } catch (error) {
      console.error(error);
      playErrorSound_();
      cameraStarted = false;
      setCameraStatus_("เปิดกล้องไม่สำเร็จ", "error");

      let message = "ไม่สามารถเปิดกล้องได้";
      const name = error?.name || "";

      if (name === "NotAllowedError") {
        message = "คุณไม่ได้อนุญาตให้ใช้กล้อง";
      } else if (name === "NotFoundError") {
        message = "ไม่พบกล้องในอุปกรณ์นี้";
      } else if (name === "NotReadableError") {
        message = "กล้องกำลังถูกใช้งานโดยแอปอื่น";
      }

      await Swal.fire({
        icon: "error",
        title: "เปิดกล้องไม่สำเร็จ",
        text: message,
        confirmButtonText: "ตกลง"
      });
    }
  }

  async function openCameraOnce_() {
    await stopCamera_(true, true);

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

    const requestedDeviceId = cameraSelect.value || currentDeviceId || "";

    if (requestedDeviceId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: requestedDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 24, max: 30 }
          }
        });

        currentDeviceId = requestedDeviceId;
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
    cameraStarting = true;
    cameraSelect.disabled = true;

    try {
      hideResult_();
      setCameraStatus_("กำลังสลับกล้อง...", "loading");
      await openCameraOnce_();

      cameraStarted = true;
      setCameraStatus_("กล้องพร้อมสแกน", "live");
      await acquireWakeLock_();
      bumpIdle_();
      startDecode_();
    } catch (error) {
      console.error(error);
      playErrorSound_();
      cameraStarted = false;
      setCameraStatus_("สลับกล้องไม่สำเร็จ", "error");

      await Toast.fire({
        icon: "error",
        title: "สลับกล้องไม่สำเร็จ",
        timer: 1600
      });
    } finally {
      cameraStarting = false;
      cameraSelect.disabled = requestInFlight;
    }
  }

  async function stopCamera_(fromIdle, silent = false) {
    decodeRunning = false;

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (detectorTimer) {
      clearTimeout(detectorTimer);
      detectorTimer = null;
    }

    invalidateActiveRequest_();

    try {
      zxingReader.stopContinuousDecode?.();
    } catch (_) {}

    if (activeStream) {
      try {
        activeStream.getTracks().forEach((track) => track.stop());
      } catch (_) {}
    }

    activeStream = null;
    videoTrack = null;
    cameraStarted = false;
    clearSkdcPresentationLock_();

    try {
      qrVideo.pause();
    } catch (_) {}

    qrVideo.srcObject = null;
    releaseWakeLock_();
    setCameraStatus_("กล้องปิดอยู่", "idle");

    if (fromIdle && !silent) {
      await Toast.fire({
        icon: "info",
        title: "ปิดกล้องอัตโนมัติ",
        timer: 1400
      });
    }
  }

  function startDecode_() {
    if (!cameraStarted) return;
    if (decodeRunning) return;
    if (requestInFlight) return;
    if (resultVisible) return;

    decodeRunning = true;

    if (barcodeDetector) {
      detectorLoop_();
      return;
    }

    zxingLoop_();
  }

  function stopDecode_() {
    decodeRunning = false;

    if (detectorTimer) {
      clearTimeout(detectorTimer);
      detectorTimer = null;
    }

    try {
      zxingReader.stopContinuousDecode?.();
    } catch (_) {}
  }

  async function detectorLoop_() {
    if (!decodeRunning || !cameraStarted || !barcodeDetector) return;

    try {
      if (qrVideo.readyState >= 2) {
        const barcodes = await barcodeDetector.detect(qrVideo);

        if (Array.isArray(barcodes) && barcodes.length > 0) {
          const text = normalizeCode_(barcodes[0].rawValue || "");

          if (text) {
            observeDetectedCode_(text);
            const accepted = await handleDecodedText_(text);
            if (accepted) return;
          } else {
            observeNoCode_();
          }
        } else {
          observeNoCode_();
        }
      }
    } catch (_) {}

    detectorTimer = setTimeout(detectorLoop_, DETECTOR_INTERVAL_MS);
  }

  function zxingLoop_() {
    try {
      const decodePromise = zxingReader.decodeFromVideoElementContinuously(
        qrVideo,
        async (result) => {
          if (!decodeRunning || !cameraStarted) return;

          if (!result) {
            observeNoCode_();
            return;
          }

          const text = normalizeCode_(result.getText?.() || "");
          if (!text) {
            observeNoCode_();
            return;
          }

          observeDetectedCode_(text);
          await handleDecodedText_(text);
        }
      );

      Promise.resolve(decodePromise).catch((error) => {
        if (!decodeRunning || !cameraStarted) return;
        console.error("ZXing decode error:", error);
      });
    } catch (error) {
      decodeRunning = false;
      console.error("ZXing start error:", error);
      setCameraStatus_("ระบบอ่าน QR ไม่พร้อม", "error");
    }
  }

  function canAcceptCode_(text) {
    const now = Date.now();

    if (requestInFlight) return false;
    if (resultVisible) return false;
    if (now - lastScanAt < SCAN_COOLDOWN_SUCCESS_MS) return false;

    if (
      isSkdcCode_(text) &&
      skdcLatchedCode === text
    ) {
      return false;
    }

    const sameCodeHoldMs = isSkdcCode_(text)
      ? SKDC_SAME_CODE_HOLD_MS
      : SAME_CODE_HOLD_MS;

    if (
      text === lastText &&
      now - lastTextAt < sameCodeHoldMs
    ) {
      return false;
    }

    return true;
  }

  async function handleDecodedText_(text) {
    bumpIdle_();

    if (!canAcceptCode_(text)) return false;

    lastScanAt = Date.now();
    lastText = text;
    lastTextAt = Date.now();

    const presentationId = isSkdcCode_(text)
      ? beginSkdcPresentation_(text)
      : "";

    playScanSound_();
    stopDecode_();

    try {
      await runSearch_(text, {
        source: "camera",
        presentationId
      });
      return true;
    } finally {
      setTimeout(() => {
        if (
          cameraStarted &&
          !decodeRunning &&
          !requestInFlight &&
          !resultVisible
        ) {
          startDecode_();
        }
      }, ZXING_RESTART_DELAY_MS);
    }
  }

  function nextRequestId_() {
    currentRequestId += 1;
    return currentRequestId;
  }

  function abortActiveRequest_() {
    try {
      currentFetchController?.abort?.();
    } catch (_) {}
    currentFetchController = null;
  }

  function invalidateActiveRequest_() {
    currentRequestId += 1;
    abortActiveRequest_();
    setBusy_(false);
  }

  async function runSearch_(rawQuery, options = {}) {
    const query = normalizeCode_(rawQuery);

    if (!query) {
      await Toast.fire({
        icon: "warning",
        title: "กรุณาป้อนรหัส",
        timer: 1400
      });
      return;
    }

    if (query.length > 120) {
      await Toast.fire({
        icon: "warning",
        title: "รหัสยาวเกินกำหนด",
        text: "กรุณาตรวจสอบรหัสอีกครั้ง",
        timer: 1600
      });
      return;
    }

    if (requestInFlight) return;

    hideResult_();
    bumpIdle_();

    const localRequestId = nextRequestId_();
    const cardRequestId = createClientRequestId_();
    const isCardAccess = isSkdcCode_(query);
    const presentationId = isCardAccess
      ? (options.presentationId || createClientRequestId_())
      : "";

    setBusy_(true);
    stopDecode_();

    setCameraStatus_(
      isCardAccess
        ? "กำลังตรวจสอบบัตร..."
        : "กำลังค้นหา...",
      "loading"
    );

    try {
      const response = isCardAccess
        ? await apiCardAccess_(
            query,
            cardRequestId,
            presentationId
          )
        : await apiSearch_(query);

      if (localRequestId !== currentRequestId) return;

      const record = response?.data?.record || {};
      const status = String(response?.status || "").toLowerCase();
      const action = String(response?.action || "").toUpperCase();

      if (status === "success") {
        const actionText =
          action === "IN"
            ? "บันทึกเข้าพื้นที่สำเร็จ"
            : action === "OUT"
              ? "บันทึกออกจากพื้นที่สำเร็จ"
              : "บันทึกสำเร็จ";

        setCameraStatus_(actionText, "success");
        playSuccessSound_();

        showResult_(record, {
          title: response.title || actionText,
          hint: response.detail || "ดำเนินการเรียบร้อยแล้ว",
          state: action === "OUT" ? "out" : "success",
          action: action
        });

        await Toast.fire({
          icon: "success",
          title: response.title || actionText,
          timer: 1100
        });

        searchInput.value = "";
        lastScanAt = Date.now();
        return;
      }

      if (status === "blocked") {
        playBlockedSound_();
        setCameraStatus_("ไม่อนุญาตให้เข้า–ออก", "error");

        showResult_(record, {
          title: response.title || "ไม่อนุญาตให้เข้า–ออกพื้นที่",
          hint: response.detail || "บัตรหมดอายุหรือข้อมูลไม่ถูกต้อง",
          state: "blocked",
          action: action
        });

        await Toast.fire({
          icon: "error",
          title: response.title || "ไม่อนุญาตให้เข้า–ออกพื้นที่",
          text: response.detail || "",
          timer: 1800
        });

        searchInput.value = "";
        lastScanAt = Date.now() - (
          SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS
        );
        return;
      }

      if (status === "duplicate") {
        playDuplicateSound_();
        setCameraStatus_("พบการสแกนซ้ำ", "warning");

        if (Object.keys(record).length) {
          showResult_(record, {
            title: response.title || "บันทึกซ้ำไม่ได้",
            hint: response.detail || "กรุณานำรหัสออกจากหน้ากล้อง",
            state: "duplicate",
            action: action
          });
        }

        await Toast.fire({
          icon: "warning",
          title: response.title || "บันทึกซ้ำไม่ได้",
          text: response.detail || "",
          timer: 1600
        });

        searchInput.value = "";
        lastScanAt = Date.now() - (
          SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS
        );
        return;
      }

      if (status === "not_found") {
        playErrorSound_();
        setCameraStatus_("ไม่พบข้อมูล", "warning");
        hideResult_();

        await Toast.fire({
          icon: "warning",
          title: response.title || "ไม่พบข้อมูล",
          text: response.detail || "",
          timer: 1600
        });

        searchInput.value = "";
        lastScanAt = Date.now() - (
          SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS
        );
        return;
      }

      playErrorSound_();
      setCameraStatus_("เกิดข้อผิดพลาด", "error");

      if (Object.keys(record).length) {
        showResult_(record, {
          title: response.title || "เกิดข้อผิดพลาด",
          hint:
            response.detail ||
            response.error ||
            "ไม่สามารถประมวลผลได้",
          state: "error",
          action: action
        });
      }

      await Toast.fire({
        icon: "error",
        title: response.title || "เกิดข้อผิดพลาด",
        text:
          response.detail ||
          response.error ||
          "ไม่สามารถประมวลผลได้",
        timer: 1800
      });

      searchInput.value = "";
      lastScanAt = Date.now() - (
        SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS
      );

    } catch (error) {
      console.error(error);

      if (localRequestId !== currentRequestId) return;

      playErrorSound_();
      setCameraStatus_("เชื่อมต่อไม่สำเร็จ", "error");

      await Toast.fire({
        icon: "error",
        title: "เชื่อมต่อไม่สำเร็จ",
        text: String(error?.message || error),
        timer: 1800
      });

      lastScanAt = Date.now() - (
        SCAN_COOLDOWN_SUCCESS_MS - SCAN_COOLDOWN_WARNING_MS
      );

    } finally {
      if (localRequestId === currentRequestId) {
        setBusy_(false);
        bumpIdle_();

        if (
          cameraStarted &&
          !resultVisible &&
          !decodeRunning
        ) {
          setCameraStatus_("กล้องพร้อมสแกน", "live");
          startDecode_();
        }

        if (
          options.source === "manual" &&
          !resultVisible
        ) {
          searchInput.focus();
          searchInput.select?.();
        }
      }
    }
  }

  async function apiSearch_(query) {
    const url =
      `${API_BASE}/api/search` +
      `?query=${encodeURIComponent(query)}` +
      `&_ts=${Date.now()}`;

    return fetchJsonWithTimeout_(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });
  }

  async function apiCardAccess_(idCard, requestId, presentationId) {
    const url = `${API_BASE}/api/card-access`;

    return fetchJsonWithTimeout_(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({
        idCard,
        requestId,
        presentationId
      })
    });
  }

  async function fetchJsonWithTimeout_(url, options) {
    abortActiveRequest_();

    const controller = new AbortController();
    currentFetchController = controller;

    const timer = setTimeout(() => {
      controller.abort();
    }, API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      let data;

      try {
        data = await response.json();
      } catch (_) {
        throw new Error("API ส่งข้อมูลไม่ถูกต้อง");
      }

      if (!response.ok && !data?.status) {
        throw new Error(
          data?.detail ||
          data?.error ||
          `HTTP ${response.status}`
        );
      }

      return data;

    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("หมดเวลารอการเชื่อมต่อ");
      }

      throw error;

    } finally {
      clearTimeout(timer);

      if (currentFetchController === controller) {
        currentFetchController = null;
      }
    }
  }
});
