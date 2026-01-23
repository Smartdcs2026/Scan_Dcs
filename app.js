// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;
const SAME_CODE_HOLD_MS  = 1800;
const API_LOCK_TIMEOUT   = 15000;
const AUTO_RESTART_MS    = 1200;

// ✅ Auto-stop camera if idle
const CAMERA_IDLE_TIMEOUT_MS = 30000; // 30s

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

  // decode control
  let decoding = false;

  // ✅ Idle timer
  let idleTimer = null;
  function bumpIdle_() {
    if (!cameraStarted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // ถ้าไม่มี activity 30 วิ ให้ปิดกล้องเอง
      stopCamera(true);
    }, CAMERA_IDLE_TIMEOUT_MS);
  }

  // ========= Toast (SweetAlert2) =========
  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    showCloseButton: true,
    timer: 5200,
    timerProgressBar: true,
    didOpen: (toast) => {
      toast.addEventListener('mouseenter', Swal.stopTimer);
      toast.addEventListener('mouseleave', Swal.resumeTimer);
    }
  });

  function esc(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  function showToastScanFull(data) {
    // data: { autoId, tsIn, dc, dcName, fullName, gender, company, phone, tsOut, duration }
    const lines = [
      data.tsIn ? `Timestamp: ${data.tsIn}` : null,
      data.tsOut ? `Timestamp Out: ${data.tsOut}` : null,
      data.duration ? `Duration: ${data.duration}` : null,
      (data.dc || data.dcName) ? `DC: ${data.dc || ''}${data.dcName ? ' - ' + data.dcName : ''}` : null,
      data.fullName ? `ชื่อ: ${data.fullName}` : null,
      data.gender ? `เพศ: ${data.gender}` : null,
      data.company ? `บริษัท: ${data.company}` : null,
      data.phone ? `เบอร์โทร: ${data.phone}` : null,
    ].filter(Boolean);

    // โชว์ไม่เกิน 6 บรรทัด (ไม่ล้นจอ)
    const showLines = lines.slice(0, 6).map(x =>
      `<div style="font-size:12px;line-height:1.25;opacity:.95">${esc(x)}</div>`
    ).join('');

    const extraCount = Math.max(0, lines.length - 6);

    Toast.fire({
      icon: 'success',
      title: `
        <div style="font-size:14px;font-weight:900;line-height:1.2">
          บันทึกสำเร็จ
        </div>
      `,
      html: `
        <div style="text-align:left;min-width:260px;max-width:360px">
          <div style="font-size:12px;opacity:.85;margin-top:2px">
            <b>Auto ID:</b> ${esc(data.autoId || '-')}
          </div>
          ${showLines ? `<div style="margin-top:6px">${showLines}</div>` : ''}
          ${
            extraCount
              ? `<div style="margin-top:6px;font-size:11px;opacity:.75">+ ข้อมูลเพิ่มอีก ${extraCount} รายการ</div>`
              : ''
          }
        </div>
      `
    });
  }

  function showToastNotFound(autoId){
    Toast.fire({
      icon: 'warning',
      title: `<div style="font-size:14px;font-weight:900">ไม่พบข้อมูล</div>`,
      html: `
        <div style="text-align:left;min-width:260px;max-width:360px">
          <div style="font-size:12px;opacity:.9"><b>Auto ID:</b> ${esc(autoId || '-')}</div>
          <div style="margin-top:6px;font-size:12px;opacity:.85">กรุณาตรวจสอบอีกครั้ง</div>
        </div>
      `,
      timer: 5200
    });
  }

  function showToastError(autoId, msg){
    Toast.fire({
      icon: 'error',
      title: `<div style="font-size:14px;font-weight:900">เกิดข้อผิดพลาด</div>`,
      html: `
        <div style="text-align:left;min-width:260px;max-width:360px">
          <div style="font-size:12px;opacity:.9"><b>Auto ID:</b> ${esc(autoId || '-')}</div>
          <div style="margin-top:6px;font-size:12px;opacity:.85">${esc(msg || '')}</div>
        </div>
      `,
      timer: 6500
    });
  }

  // ========= UX =========
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };

  searchInput.addEventListener('input', () => {
    searchInput.value = searchInput.value.toUpperCase();
    bumpIdle_();
  });

  searchBtn.addEventListener('click', () => {
    bumpIdle_();
    runSearch(searchInput.value);
  });

  searchInput.addEventListener('keyup', (e) => {
    bumpIdle_();
    if (e.key === 'Enter') runSearch(searchInput.value);
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

  stopButton.addEventListener('click', () => stopCamera(false));

  cameraSelect.addEventListener('change', async () => {
    if (!cameraStarted) return;
    bumpIdle_();
    await restartWithDevice_(cameraSelect.value);
  });

  // ======== helpers ========

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isInAppBrowser_() {
    const ua = navigator.userAgent || "";
    return /Line|FBAN|FBAV|Instagram/i.test(ua);
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

    cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
  }

  // ======== Camera flow ========

  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Swal.fire({
        icon:'error',
        title:'ไม่รองรับกล้อง',
        text:'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง',
        confirmButtonText:'OK'
      });
    }

    // ลดปัญหา permission ใน in-app browser
    if (isInAppBrowser_()) {
      await Swal.fire({
        icon: 'info',
        title: 'แนะนำให้เปิดด้วย Chrome/Safari',
        html: `<div style="font-size:14px;text-align:left">
          บางเครื่องเมื่อเปิดผ่าน LINE/FB/IG จะขออนุญาตซ้ำหรือเปิดกล้องไม่ได้<br>
          แนะนำ: เปิดลิงก์นี้ด้วย Chrome/Safari โดยตรง หรือ “Add to Home Screen” (PWA)
        </div>`,
        confirmButtonText: 'เข้าใจแล้ว'
      });
    }

    // ถ้ายัง live อยู่ → ไม่ขอใหม่
    if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraStarted = true;
      bumpIdle_();
      resumeDecode_();
      return;
    }

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

    // หลังได้ permission แล้ว refresh list เพื่อ label เต็ม
    try { await refreshCameraSelect_(); } catch (_) {}

    cameraStarted = true;
    bumpIdle_();
    resumeDecode_();
  }

  async function openCameraOnce_() {
    // ปิดก่อนเผื่อค้าง (fromIdle=true เพื่อไม่ขึ้น dialog)
    await stopCamera(true);

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
      qrVideo.srcObject = stream;
      await qrVideo.play();
      return true;
    };

    const wantDeviceId = cameraSelect.value || currentDeviceId || "";

    // Try 1: exact deviceId
    if (wantDeviceId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: wantDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
          }
        });
        currentDeviceId = wantDeviceId;
        return;
      } catch (_) {}
    }

    // Try 2: environment
    try {
      await tryOpen({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      return;
    } catch (_) {}

    // Try 3: browser choose
    await tryOpen({ video: true, audio: false });
  }

  async function restartWithDevice_(deviceId) {
    currentDeviceId = deviceId || currentDeviceId || "";
    try {
      await openCameraOnce_();
      cameraStarted = true;
      bumpIdle_();
      resumeDecode_();
    } catch (err) {
      cameraStarted = false;
      Swal.fire({
        icon: 'error',
        title: 'สลับกล้องไม่สำเร็จ',
        text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
        confirmButtonText: 'OK'
      });
    }
  }

  async function stopCamera(fromIdle) {
    apiBusy = false;
    cameraStarted = false;
    decoding = false;

    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;

    if (fromIdle) {
      Toast.fire({
        icon: 'info',
        title: `<div style="font-size:14px;font-weight:900">ปิดกล้องอัตโนมัติ</div>`,
        html: `<div style="text-align:left;min-width:260px;max-width:360px;font-size:12px;opacity:.9">
          ไม่มีการใช้งานเกิน 30 วินาที ระบบปิดกล้องให้เพื่อประหยัดแบตเตอรี่
        </div>`,
        timer: 2200
      });
    }
  }

  // ======== Decode control (pause/resume) ========

  function pauseDecode_() {
    decoding = false;
    try { codeReader.reset(); } catch (_) {}
  }

  function resumeDecode_() {
    if (!cameraStarted) return;
    if (decoding) return;
    decoding = true;
    decodeLoop_(currentDeviceId || null);
  }

  function decodeLoop_(deviceIdOrNull) {
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
      if (!decoding) return;
      if (!result) return;

      bumpIdle_(); // มี activity

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

      // ✅ นิ่งสุด: พัก decode ระหว่างทำงาน แล้วค่อย resume
      apiBusy = true;
      pauseDecode_();

      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
        bumpIdle_();
        // กลับมาสแกนต่อทันที
        resumeDecode_();
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
        showToastNotFound(query);
        searchInput.value = '';
        return;
      }

      // ===== parse ตาราง th/td =====
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      const rows = Array.from(doc.querySelectorAll('tr'));

      const map = {};
      rows.forEach(r => {
        const th = r.querySelector('th');
        const td = r.querySelector('td');
        if (!th || !td) return;
        const k = (th.innerText || '').trim();
        const v = (td.innerText || '').trim();
        if (k) map[k] = v;
      });

      // ===== map ตามฟิลด์ของคุณ =====
      const data = {
        autoId: map['Auto ID'] || query,
        tsIn: map['Timestamp'] || '',
        dc: map['DC'] || '',
        dcName: map['DC Name'] || '',
        fullName: map['ชื่อ-นามสกุล'] || '',
        gender: map['เพศ'] || '',
        company: map['ชื่อบริษัท/ต้นสังกัด'] || '',
        phone: map['เบอร์โทร'] || '',
        tsOut: map['Timestamp Out'] || '',
        duration: map['Duration'] || ''
      };

      showToastScanFull(data);
      searchInput.value = '';

    } catch (err) {
      console.error(err);
      playErrorSound();
      showToastError(query, String(err?.message || err));

      // auto restart decode (ไม่ reopen camera เพื่อกัน prompt ซ้ำ)
      setTimeout(() => {
        if (cameraStarted) resumeDecode_();
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
