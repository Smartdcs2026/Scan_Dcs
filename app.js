// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ถ้าคุณตั้ง API_KEY ใน Script Properties ให้ใส่ที่นี่ด้วย
// const GAS_API_KEY = "xxxxx";
const GAS_API_KEY = "";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;
const SAME_CODE_HOLD_MS  = 1800;
const API_TIMEOUT_MS     = 15000;

document.addEventListener('DOMContentLoaded', () => {
  const searchInput  = document.getElementById('searchInput');
  const btnSearch    = document.getElementById('btnSearch');
  const btnStart     = document.getElementById('btnStart');
  const btnStop      = document.getElementById('btnStop');
  const qrVideo      = document.getElementById('qrVideo');
  const cameraSelect = document.getElementById('cameraSelect');

  const codeReader = new ZXing.BrowserQRCodeReader();

  // ===== State =====
  let activeStream = null;
  let currentDeviceId = "";
  let cameraRunning = false;

  let apiBusy = false;
  let pendingCode = ""; // ✅ คิวล่าสุด (กันสแกนหายตอนเน็ตช้า)

  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  let permissionState = "unknown"; // granted|denied|prompt|unknown
  let starting = false;

  // UX
  searchInput.addEventListener('input', () => searchInput.value = searchInput.value.toUpperCase());
  btnSearch.addEventListener('click', () => submitQuery(searchInput.value));
  searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') submitQuery(searchInput.value); });

  btnStart.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    try {
      await startFlow();
    } finally {
      starting = false;
    }
  });

  btnStop.addEventListener('click', async () => {
    await stopCamera();
  });

  cameraSelect.addEventListener('change', async () => {
    if (!cameraRunning) return;
    await restartWithDevice(cameraSelect.value);
  });

  // --------- helpers ----------
  function isLineInAppBrowser() {
    const ua = navigator.userAgent || "";
    return /Line\/|LINE\//i.test(ua) || /LIFF/i.test(ua);
  }

  async function queryPermission() {
    try {
      if (!navigator.permissions?.query) return "unknown";
      const p = await navigator.permissions.query({ name: "camera" });
      permissionState = p.state || "unknown";
      try { p.onchange = () => permissionState = p.state || "unknown"; } catch (_) {}
      return permissionState;
    } catch (_) {
      return "unknown";
    }
  }

  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function pickDefaultDevice(devices) {
    if (!devices?.length) return "";
    if (isMobile()) {
      const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
      return (back?.deviceId) || devices[0].deviceId;
    }
    return devices[0].deviceId;
  }

  async function refreshCameraSelect() {
    const cams = await listCameras();
    cameraSelect.innerHTML = "";
    cams.forEach((d, idx) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId || "";
      opt.textContent = d.label || `Camera ${idx + 1}`;
      cameraSelect.appendChild(opt);
    });

    if (!currentDeviceId) currentDeviceId = pickDefaultDevice(cams);
    if (currentDeviceId) cameraSelect.value = currentDeviceId;
  }

  // --------- Camera flow (มาตรฐาน) ----------
  async function startFlow() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Swal.fire({ icon:'error', title:'ไม่รองรับกล้อง', text:'เบราว์เซอร์นี้ไม่รองรับ getUserMedia', confirmButtonText:'OK' });
    }

    // เตือนกรณี LINE (เพราะบางเครื่องไม่ให้กล้อง)
    if (isLineInAppBrowser()) {
      await Swal.fire({
        icon: 'info',
        title: 'เปิดในเบราว์เซอร์เพื่อใช้กล้อง',
        html: `<div style="text-align:left;font-size:14px;line-height:1.5">
          LINE อาจจำกัดการใช้กล้องในบางรุ่น/บางเครื่อง<br>
          แนะนำ: กด “…” → <b>เปิดในเบราว์เซอร์</b> (Chrome/Safari)
        </div>`,
        confirmButtonText: 'OK'
      });
    }

    const p = await queryPermission();
    if (p === "denied") {
      return Swal.fire({
        icon:'warning',
        title:'ไม่ได้รับอนุญาตใช้กล้อง',
        html:`<div style="text-align:left;font-size:14px">
          กรุณาอนุญาตกล้อง แล้วกลับมากด “เปิดกล้อง” อีกครั้ง<br><br>
          • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
          • Android: Site settings → Camera → Allow
        </div>`,
        confirmButtonText:'OK',
        allowOutsideClick:false
      });
    }

    // ถ้ามี stream live อยู่แล้ว ไม่ขอซ้ำ
    if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraRunning = true;
      try { await refreshCameraSelect(); } catch (_) {}
      startDecodeLoop(currentDeviceId || null);
      return;
    }

    // ขอเปิด stream ครั้งเดียว
    await openCameraOnce();

    // หลัง permission แล้ว label/device list จะมาดีขึ้น
    try { await refreshCameraSelect(); } catch (_) {}

    cameraRunning = true;
    startDecodeLoop(currentDeviceId || null);
  }

  async function openCameraOnce() {
    await stopCamera();

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
      qrVideo.srcObject = stream;
      await qrVideo.play();
      return true;
    };

    const wantDeviceId = cameraSelect.value || currentDeviceId || "";

    // Try 1 exact deviceId
    if (wantDeviceId) {
      try {
        await tryOpen({
          audio:false,
          video:{
            deviceId:{ exact: wantDeviceId },
            width:{ ideal:1280 },
            height:{ ideal:720 },
            frameRate:{ ideal:30, max:30 }
          }
        });
        currentDeviceId = wantDeviceId;
        return;
      } catch (_) {}
    }

    // Try 2 facingMode environment
    try {
      await tryOpen({
        audio:false,
        video:{
          facingMode:{ ideal:"environment" },
          width:{ ideal:1280 },
          height:{ ideal:720 }
        }
      });
      return;
    } catch (_) {}

    // Try 3 video:true
    await tryOpen({ video:true, audio:false });
  }

  async function restartWithDevice(deviceId) {
    currentDeviceId = deviceId || currentDeviceId || "";
    try {
      await openCameraOnce();
      cameraRunning = true;
      startDecodeLoop(currentDeviceId || null);
    } catch (err) {
      cameraRunning = false;
      Swal.fire({ icon:'error', title:'สลับกล้องไม่สำเร็จ', text:'ลองปิดกล้องแล้วเปิดใหม่', confirmButtonText:'OK' });
    }
  }

  async function stopCamera() {
    apiBusy = false;
    cameraRunning = false;
    pendingCode = "";

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;
  }

  function startDecodeLoop(deviceIdOrNull) {
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
      if (!result) return;

      const now = Date.now();
      if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

      const text = String(result.getText() || "").trim().toUpperCase();
      if (!text) return;

      if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

      lastScanAt = now;
      lastText = text;
      lastTextAt = now;

      playScanSound();
      onScanned(text);
    });
  }

  function onScanned(code) {
    if (apiBusy) { pendingCode = code; return; }
    apiBusy = true;

    runSearch(code)
      .catch(()=>{})
      .finally(() => {
        apiBusy = false;
        if (pendingCode) {
          const next = pendingCode;
          pendingCode = "";
          onScanned(next);
        }
      });
  }

  // --------- Search / API ----------
  async function submitQuery(q) {
    q = String(q || "").trim().toUpperCase();
    if (!q) return;
    onScanned(q);
    searchInput.value = "";
  }

  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    try {
      const res = await gasJsonp({ action:"search", query, key: GAS_API_KEY || undefined });

      if (!res || !res.ok) throw new Error(res?.error || "API Error");

      const htmlString = res.html || "";
      if (!htmlString) {
        playErrorSound();
        await Swal.fire({ icon:'error', title:'ไม่พบข้อมูล', text:'กรุณาตรวจสอบข้อมูลการค้นหาอีกครั้ง', confirmButtonText:'OK', allowOutsideClick:false });
        return;
      }

      // highlight
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
        title:'ข้อมูล',
        html: doc.body.innerHTML,
        confirmButtonText:'OK',
        showCloseButton:true,
        allowOutsideClick:false,
        timer: 5000
      });

    } catch (err) {
      console.error(err);
      playErrorSound();
      await Swal.fire({ icon:'error', title:'Error', text:String(err?.message || err), confirmButtonText:'OK', allowOutsideClick:false });
    }
  }

  // JSONP (กัน CORS)
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
      }, API_TIMEOUT_MS);

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
      if (v === undefined || v === null || v === "") return;
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
