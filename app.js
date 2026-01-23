// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;
const SAME_CODE_HOLD_MS  = 1800;
const API_LOCK_TIMEOUT   = 15000;

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

  const resultCard    = document.getElementById('scanResult');
  const resultGrid    = document.getElementById('resultGrid');
  const resultHint    = document.getElementById('resultHint');
  const clearResult   = document.getElementById('clearResult');
  const cameraStatus  = document.getElementById('cameraStatus');

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
  let decoding = false;

  // ✅ Idle timer
  let idleTimer = null;
  function bumpIdle_() {
    if (!cameraStarted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stopCamera(true), CAMERA_IDLE_TIMEOUT_MS);
  }
  function clearIdle_() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  // ========= UX =========
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };
  searchInput.addEventListener('input', () => { searchInput.value = searchInput.value.toUpperCase(); bumpIdle_(); });
  searchBtn.addEventListener('click', () => { bumpIdle_(); runSearch(searchInput.value); });
  searchInput.addEventListener('keyup', (e) => { bumpIdle_(); if (e.key === 'Enter') runSearch(searchInput.value); });

  clearResult.addEventListener('click', () => {
    hideResult_();
    resultHint.textContent = 'พร้อมสแกน...';
  });

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

  function setCamStatus_(text) {
    if (cameraStatus) cameraStatus.textContent = text;
  }

  // ======== Camera flow ========

  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Swal.fire({ icon:'error', title:'ไม่รองรับกล้อง', text:'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง', confirmButtonText:'OK' });
    }

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

    // ถ้ากล้องยัง live อยู่ → ไม่ขอ permission ใหม่
    if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraStarted = true;
      setCamStatus_('กล้องทำงานอยู่');
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

    setCamStatus_('กำลังเปิดกล้อง...');
    try {
      await openCameraOnce_();
    } catch (err) {
      console.error(err);
      setCamStatus_('เปิดกล้องไม่สำเร็จ');
      const name = err?.name || "CameraError";
      let msg = "ไม่สามารถเปิดกล้องได้";
      if (name === "NotAllowedError") msg = "คุณกดไม่อนุญาตกล้อง หรือระบบบล็อกสิทธิ์กล้อง";
      if (name === "NotFoundError")  msg = "ไม่พบกล้องในอุปกรณ์นี้";
      if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่ (ปิดแอป/แท็บอื่นก่อน)";
      if (name === "OverconstrainedError") msg = "เลือกกล้อง/ความละเอียดที่อุปกรณ์ไม่รองรับ";
      return Swal.fire({ icon:'error', title:'เปิดกล้องไม่สำเร็จ', text: msg, confirmButtonText:'OK' });
    }

    try { await refreshCameraSelect_(); } catch (_) {}

    cameraStarted = true;
    setCamStatus_('กล้องทำงานอยู่');
    bumpIdle_();
    resumeDecode_();
  }

  async function openCameraOnce_() {
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
      setCamStatus_('กำลังสลับกล้อง...');
      await openCameraOnce_();
      cameraStarted = true;
      setCamStatus_('กล้องทำงานอยู่');
      bumpIdle_();
      resumeDecode_();
    } catch (err) {
      cameraStarted = false;
      setCamStatus_('สลับกล้องไม่สำเร็จ');
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

    clearIdle_();

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;

    setCamStatus_('กล้องปิดอยู่');

    if (fromIdle) {
      // เงียบ ๆ ก็ได้ แต่ใส่ hint เล็กน้อยเหนือกล้องแทน popup
      showHint_('ปิดกล้องอัตโนมัติ (ไม่มีการใช้งาน 30 วินาที)');
    }
  }

  // ======== Decode control ========

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

      bumpIdle_();

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
      apiBusy = true;

      // ✅ ไม่พักกล้อง ไม่เปิด popup — แสดงผลบนการ์ดเหนือกล้องแทน
      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
        bumpIdle_();
      }
    });
  }

  // ====== Result UI ======

  function showHint_(msg) {
    if (!resultHint) return;
    resultHint.textContent = msg;
  }

  function hideResult_() {
    if (!resultCard) return;
    resultCard.classList.add('is-hidden');
    if (resultGrid) resultGrid.innerHTML = "";
  }

  function showResult_(kvPairs) {
    // kvPairs: [{k:'Auto ID', v:'...'}, ...]
    if (!resultCard || !resultGrid) return;

    resultGrid.innerHTML = kvPairs.map(x => `
      <div class="k">${escapeHtml(x.k)}</div>
      <div class="v">${escapeHtml(x.v)}</div>
    `).join("");

    resultCard.classList.remove('is-hidden');
    resultCard.classList.remove('flash');
    void resultCard.offsetWidth; // reflow
    resultCard.classList.add('flash');
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ====== Search / GAS JSONP ======

  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    showHint_(`กำลังค้นหา: ${query} ...`);

    try {
      const res = await gasJsonp({ action: "search", query });

      if (!res || !res.ok) throw new Error(res?.error || "API Error");

      // ✅ คุณบอกว่าข้อมูลมีฟิลด์แบบนี้:
      // Auto ID, Timestamp, DC, DC Name, ชื่อ-นามสกุล, เพศ, ชื่อบริษัท/ต้นสังกัด, เบอร์โทร, Timestamp Out, Duration
      //
      // ตอนนี้ฝั่ง GAS ส่งกลับ "html" -> เราจะ parse จากตารางเดิม (th/td) แล้ว map เป็น KV
      const htmlString = res.html || "";
      if (!htmlString) {
        playErrorSound();
        showHint_('ไม่พบข้อมูล');
        showResult_([{ k: 'ผลลัพธ์', v: 'ไม่พบข้อมูล (กรุณาตรวจสอบ Auto ID)' }]);
        return;
      }

      const data = parseHtmlTableToKV_(htmlString);

      // ทำให้เรียงตามฟิลด์ที่คุณต้องการ
      const orderedKeys = [
        'Auto ID','Timestamp','DC','DC Name','ชื่อ-นามสกุล','เพศ','ชื่อบริษัท/ต้นสังกัด','เบอร์โทร','Timestamp Out','Duration'
      ];

      const kv = [];
      const map = new Map(data.map(x => [x.k, x.v]));

      // เติมตามลำดับ
      for (const k of orderedKeys) {
        if (map.has(k)) kv.push({ k, v: map.get(k) });
      }
      // คีย์อื่นๆ ที่เหลือ (กันตก)
      for (const [k, v] of map.entries()) {
        if (!orderedKeys.includes(k)) kv.push({ k, v });
      }

      showHint_('สแกนสำเร็จ ✓');
      showResult_(kv);

      searchInput.value = '';

    } catch (err) {
      console.error(err);
      playErrorSound();
      showHint_('เกิดข้อผิดพลาด');
      showResult_([{ k: 'Error', v: String(err?.message || err) }]);
    }
  }

  function parseHtmlTableToKV_(htmlString) {
    // คาดว่าเป็น <tr><th>Key</th><td>Value</td></tr> แบบเดิมของคุณ
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const rows = doc.getElementsByTagName('tr');
    const out = [];

    for (const row of rows) {
      const th = row.getElementsByTagName('th')[0];
      const td = row.getElementsByTagName('td')[0];
      if (!th || !td) continue;

      const k = (th.textContent || "").trim();
      const v = (td.textContent || "").trim();
      if (!k) continue;

      out.push({ k, v });
    }
    return out;
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

  // เริ่มต้นข้อความ
  hideResult_();
  setCamStatus_('กล้องปิดอยู่');
  showHint_('พร้อมสแกน...');
});
