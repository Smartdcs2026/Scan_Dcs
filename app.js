// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;
const SAME_CODE_HOLD_MS  = 1800;
const API_LOCK_TIMEOUT   = 15000;
const AUTO_RESTART_MS    = 1200;

// ===== Camera behavior =====
const CAMERA_IDLE_STOP_MS = 30000;     // ✅ 30 วินาที: ถ้าไม่มีการใช้งาน ปิดกล้องอัตโนมัติ
const CAMERA_OPEN_TIMEOUT = 12000;     // กันค้างตอนเปิดกล้อง
const CAMERA_W = 1280;                 // จำกัดความละเอียดเพื่อความนิ่ง/เร็ว
const CAMERA_H = 720;
const CAMERA_FPS = 30;

document.addEventListener('DOMContentLoaded', () => {
  // ===== PWA: Service Worker =====
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }

  const searchInput   = document.getElementById('searchInput');
  const searchBtn     = document.getElementById('searchBtn');
  const qrVideo       = document.getElementById('qrVideo');
  const cameraSelect  = document.getElementById('cameraSelect');
  const startButton   = document.getElementById('startCamera');
  const stopButton    = document.getElementById('stopCamera');

  const codeReader = new ZXing.BrowserQRCodeReader();

  // ========= State =========
  let currentDeviceId = "";
  let cameraStarted = false;
  let apiBusy = false;

  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  let activeStream = null;
  let starting = false;

  // ✅ Idle timer (auto stop)
  let idleTimer = null;

  // ========= UX =========
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };
  searchInput.addEventListener('input', () => { searchInput.value = searchInput.value.toUpperCase(); touchIdle_(); });
  searchBtn.addEventListener('click', () => { touchIdle_(); runSearch(searchInput.value); });
  searchInput.addEventListener('keyup', (e) => { touchIdle_(); if (e.key === 'Enter') runSearch(searchInput.value); });

  // ✅ “ใช้งาน” อื่น ๆ ก็รีเซ็ต timer (กันปิดเองตอนผู้ใช้กำลังดูผล)
  ["click","touchstart","keydown","scroll"].forEach(evt => {
    window.addEventListener(evt, () => { if (cameraStarted) touchIdle_(); }, { passive:true });
  });

  // ✅ ขอ permission เฉพาะจาก user gesture
  startButton.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    try {
      await startFlow_();
    } finally {
      starting = false;
    }
  });

  stopButton.addEventListener('click', () => stopCamera(true));

  cameraSelect.addEventListener('change', async () => {
    if (!cameraStarted) return;
    await restartWithDevice_(cameraSelect.value);
  });

  // ======== helpers ========

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isInAppBrowser_() {
    const ua = navigator.userAgent || "";
    return /Line|FBAN|FBAV|Instagram|Messenger|TikTok/i.test(ua);
  }

  function startIdleTimer_() {
    clearIdleTimer_();
    idleTimer = setTimeout(() => {
      // ✅ ปิดกล้องอัตโนมัติ
      stopCamera(true);
      Swal.fire({
        icon: 'info',
        title: 'ปิดกล้องอัตโนมัติ',
        text: 'ไม่มีการใช้งานกล้องภายใน 30 วินาที',
        timer: 1800,
        showConfirmButton: false
      });
    }, CAMERA_IDLE_STOP_MS);
  }

  function clearIdleTimer_() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function touchIdle_() {
    // เรียกเมื่อมี “กิจกรรม” ที่ถือว่าใช้งาน
    if (!cameraStarted) return;
    startIdleTimer_();
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
    return devices.filter(d => d.kind === "videoinput");
  }

  function pickDefaultDevice_(devices) {
    if (!devices?.length) return "";
    if (isMobile_()) {
      const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
      return (back?.deviceId) || devices[0].deviceId;
    }
    return devices[0].deviceId;
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

    // UX: ถ้ามีกล้องเดียว ซ่อน dropdown
    cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
  }

  function withTimeout_(promise, ms, msg) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(msg || "timeout")), ms);
      promise.then(v => { clearTimeout(t); resolve(v); })
             .catch(e => { clearTimeout(t); reject(e); });
    });
  }

  // ======== Camera flow ========

  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Swal.fire({ icon:'error', title:'ไม่รองรับกล้อง', text:'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง', confirmButtonText:'OK' });
    }

    // เตือน in-app browser (ช่วยลดปัญหา permission เด้ง/เลือกกล้องไม่ได้)
    if (isInAppBrowser_()) {
      await Swal.fire({
        icon: 'info',
        title: 'แนะนำให้เปิดด้วย Chrome/Safari',
        html: `<div style="font-size:14px;text-align:left">
          ตรวจพบว่าเปิดผ่าน in-app browser (LINE/FB/IG) ซึ่งบางเครื่องอาจขออนุญาตซ้ำหรือเปิดกล้องไม่ได้<br>
          แนะนำ: เปิดลิงก์นี้ด้วย Chrome/Safari โดยตรง หรือ “Add to Home Screen” (PWA)
        </div>`,
        confirmButtonText: 'เข้าใจแล้ว'
      });
    }

    // ถ้ากล้องยัง live อยู่ → ไม่ขอ permission ใหม่
    if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraStarted = true;
      startIdleTimer_();
      decodeLoop_(currentDeviceId || null);
      return;
    }

    // ถ้า permission denied → ไม่พยายามขอซ้ำ
    const p = await queryCameraPermission_();
    if (p === "denied") {
      return Swal.fire({
        icon: 'warning',
        title: 'ไม่ได้รับอนุญาตใช้กล้อง',
        html: `<div style="text-align:left;font-size:14px">
          กรุณาอนุญาตกล้องในการตั้งค่า แล้วกลับมากด “เปิดกล้อง” อีกครั้ง<br><br>
          • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
          • Android: Site settings → Camera → Allow
        </div>`,
        confirmButtonText: 'OK',
        allowOutsideClick: false
      });
    }

    // เปิดกล้อง “ครั้งเดียว” (prompt จะเกิดหลัก ๆ ตอนนี้)
    try {
      await openCameraOnce_();
    } catch (err) {
      console.error(err);
      const name = err?.name || "CameraError";
      let msg = "ไม่สามารถเปิดกล้องได้";

      if (name === "NotAllowedError") msg = "คุณกดไม่อนุญาตกล้อง หรือระบบบล็อกสิทธิ์กล้อง";
      if (name === "NotFoundError")  msg = "ไม่พบกล้องในอุปกรณ์นี้";
      if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่ (ปิดแอป/แท็บอื่นก่อน)";
      if (name === "OverconstrainedError") msg = "เลือกกล้อง/ความละเอียดที่อุปกรณ์ไม่รองรับ";

      return Swal.fire({ icon:'error', title:'เปิดกล้องไม่สำเร็จ', text: msg, confirmButtonText:'OK' });
    }

    // หลังได้ permission แล้ว ค่อย refresh รายชื่อกล้องเพื่อให้ label มาเต็ม
    try { await refreshCameraSelect_(); } catch (_) {}

    cameraStarted = true;
    startIdleTimer_();
    decodeLoop_(currentDeviceId || null);
  }

  async function openCameraOnce_() {
    await stopCamera(false); // กันค้าง แต่ไม่ต้อง popup

    const tryOpen = async (constraints) => {
      const p = navigator.mediaDevices.getUserMedia(constraints);
      const stream = await withTimeout_(p, CAMERA_OPEN_TIMEOUT, "เปิดกล้องนานเกินไป (timeout)");

      activeStream = stream;
      qrVideo.srcObject = stream;
      await qrVideo.play();
      return true;
    };

    const wantDeviceId = cameraSelect.value || currentDeviceId || "";

    // Try 1: deviceId exact
    if (wantDeviceId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: wantDeviceId },
            width: { ideal: CAMERA_W },
            height: { ideal: CAMERA_H },
            frameRate: { ideal: CAMERA_FPS, max: CAMERA_FPS }
          }
        });
        currentDeviceId = wantDeviceId;
        return;
      } catch (_) {}
    }

    // Try 2: deviceId ideal
    if (wantDeviceId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { ideal: wantDeviceId },
            width: { ideal: CAMERA_W },
            height: { ideal: CAMERA_H }
          }
        });
        currentDeviceId = wantDeviceId;
        return;
      } catch (_) {}
    }

    // Try 3: environment (มือถือ)
    try {
      await tryOpen({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: CAMERA_W },
          height: { ideal: CAMERA_H }
        }
      });
      return;
    } catch (_) {}

    // Try 4: browser choose
    await tryOpen({ video: true, audio: false });
  }

  async function restartWithDevice_(deviceId) {
    currentDeviceId = deviceId || currentDeviceId || "";
    try {
      await openCameraOnce_();
      cameraStarted = true;
      startIdleTimer_();
      decodeLoop_(currentDeviceId || null);
    } catch (err) {
      cameraStarted = false;
      clearIdleTimer_();
      Swal.fire({
        icon: 'error',
        title: 'สลับกล้องไม่สำเร็จ',
        text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
        confirmButtonText: 'OK'
      });
    }
  }

  async function stopCamera(showMsg) {
    apiBusy = false;
    cameraStarted = false;
    clearIdleTimer_();

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;

    if (showMsg === true) {
      // ไม่จำเป็นต้องโชว์ทุกครั้ง—ปล่อยว่างไว้
    }
  }

  // ======== Decode ========

  function decodeLoop_(deviceIdOrNull) {
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
      if (!cameraStarted) return;
      if (!result) return;

      // ✅ สแกนได้ = ถือว่า “ใช้งาน” รีเซ็ต idle timer
      touchIdle_();

      const now = Date.now();
      if (apiBusy) return;
      if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

      const text = String(result.getText() || "").trim().toUpperCase();
      if (!text) return;

      if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

      lastScanAt = now;
      lastText = text;
      lastTextAt = now;

      playScanSound();

      // ระหว่างยิง API “พักสแกน” (นิ่งสุด)
      apiBusy = true;
      try {
        try { codeReader.reset(); } catch (_) {}
        await runSearch(text);
      } finally {
        apiBusy = false;
        if (cameraStarted) {
          startIdleTimer_();
          decodeLoop_(currentDeviceId || null);
        }
      }
    });
  }

  // ====== Search / GAS JSONP ======

  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    try {
      const res = await gasJsonp({ action: "search", query });
      if (!res || !res.ok) throw new Error(res?.error || "API Error");

      const htmlString = res.html || "";
      if (!htmlString) {
        playErrorSound();
        await Swal.fire({
          icon:'error',
          title:'ไม่พบข้อมูล',
          text:'กรุณาตรวจสอบข้อมูลการค้นหาอีกครั้ง',
          confirmButtonText:'OK',
          allowOutsideClick:false
        });
        searchInput.value = '';
        return;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      const rows = doc.getElementsByTagName('tr');

      for (const row of rows) {
        const th = row.getElementsByTagName('th')[0];
        if (!th) continue;

        if (th.innerText === 'Timestamp') {
          th.style.backgroundColor = '#FFFF99';
          const td = row.getElementsByTagName('td')[0]; if (td) td.style.backgroundColor = '#FFFF99';
        }
        if (th.innerText === 'Timestamp Out') {
          th.style.backgroundColor = '#00FFFF';
          const td = row.getElementsByTagName('td')[0]; if (td) td.style.backgroundColor = '#00FFFF';
        }
      }

      await Swal.fire({
        title: 'ข้อมูล',
        html: doc.body.innerHTML,
        confirmButtonText: 'OK',
        showCloseButton: true,
        allowOutsideClick: false,
        timer: 5000
      });

      searchInput.value = '';

    } catch (err) {
      console.error(err);
      playErrorSound();
      await Swal.fire({
        icon:'error',
        title:'Error',
        text: String(err?.message || err),
        confirmButtonText:'OK',
        allowOutsideClick:false
      });

      // auto restart (แต่ไม่ควรทำให้เด้ง permission ซ้ำ)
      setTimeout(() => {
        if (!cameraStarted) startFlow_().catch(()=>{});
      }, AUTO_RESTART_MS);
    }
  }

  function gasJsonp(params) {
    return new Promise((resolve, reject) => {
      if (!GAS_WEBAPP_URL) return reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL"));

      const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
      const url = GAS_WEBAPP_URL + "?" + toQuery({ ...params, callback: cbName, _ts: Date.now() });

      const script = document.createElement("script");
      script.src = url;
      script.async = true;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout เรียก Apps Script"));
      }, API_LOCK_TIMEOUT);

      window[cbName] = (data) => {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
      };

      function cleanup() {
        try { delete window[cbName]; } catch(_) { window[cbName] = undefined; }
        if (script && script.parentNode) script.parentNode.removeChild(script);
      }

      document.body.appendChild(script);
    });
  }

  function toQuery(obj) {
    const usp = new URLSearchParams();
    Object.keys(obj || {}).forEach(k => {
      const v = obj[k];
      if (v === undefined || v === null) return;
      usp.set(k, String(v));
    });
    return usp.toString();
  }

  function playScanSound() {
    const s = document.getElementById('scanSound');
    if (s) { s.volume = 1.0; s.play().catch(()=>{}); }
  }

  function playErrorSound() {
    const s = document.getElementById('errorSound');
    if (s) { s.volume = 1.0; s.play().catch(()=>{}); }
  }
});
