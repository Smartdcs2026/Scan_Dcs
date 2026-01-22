// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;    // กันสแกนรัว
const SAME_CODE_HOLD_MS  = 1800;   // กัน QR เดิมซ้ำ
const API_LOCK_TIMEOUT   = 15000;  // timeout เรียก GAS
const AUTO_RESTART_MS    = 1200;   // ถ้ากล้องหลุด ให้เริ่มใหม่

document.addEventListener('DOMContentLoaded', () => {
  const searchInput   = document.getElementById('searchInput');
  const searchBtn     = document.getElementById('searchBtn');
  const qrVideo       = document.getElementById('qrVideo');
  const cameraSelect  = document.getElementById('cameraSelect');
  const startButton   = document.getElementById('startCamera');
  const stopButton    = document.getElementById('stopCamera');

  // ZXing reader
  const codeReader = new ZXing.BrowserQRCodeReader();

  // state
  let currentDeviceId = "";
  let cameraStarted = false;
  let apiBusy = false;

  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  // stream handle
  let activeStream = null;

  // UX
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };
  searchInput.addEventListener('input', () => { searchInput.value = searchInput.value.toUpperCase(); });

  searchBtn.addEventListener('click', () => runSearch(searchInput.value));
  searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') runSearch(searchInput.value); });

  // ให้ผู้ใช้กดเปิดกล้องเองจะเสถียรกว่ามากในบางเครื่อง
  startButton.addEventListener('click', async () => {
    await initCameras();                 // โหลดรายการ (หลัง permission)
    await startCamera(cameraSelect.value || currentDeviceId);
  });

  stopButton.addEventListener('click', () => stopCamera());

  // โหลดรายการกล้องไว้ก่อน (ถ้าเครื่องรองรับ)
  initCameras().catch(()=>{});

  // ====== Camera helpers ======

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  // ขอ permission กล้องแบบเบา ๆ (สำคัญสำหรับ iOS/Safari)
  async function ensureCameraPermission_() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach(t => t.stop());
      return true;
    } catch (e) {
      return false;
    }
  }

  async function loadDeviceList_() {
    // 1) ลองของ ZXing ก่อน
    try {
      const devices = await ZXing.BrowserQRCodeReader.listVideoInputDevices();
      if (devices && devices.length) return devices;
    } catch (_) {}

    // 2) fallback: enumerateDevices
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'videoinput');
  }

  async function initCameras() {
    if (!navigator.mediaDevices?.getUserMedia) return;

    // iOS/Safari ต้องขอ permission ก่อนถึงเห็น label/deviceId ดี ๆ
    await ensureCameraPermission_();

    const devices = await loadDeviceList_();

    cameraSelect.innerHTML = "";
    devices.forEach((d, idx) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId || "";
      opt.innerText = d.label || `Camera ${idx + 1}`;
      cameraSelect.appendChild(opt);
    });

    // เลือกกล้องหลัง
    if (isMobile_() && devices.length) {
      const back = devices.find(d => /back|rear|environment/i.test(d.label || ''));
      currentDeviceId = (back?.deviceId) || (devices[0].deviceId || "");
    } else {
      currentDeviceId = devices[0]?.deviceId || "";
    }

    if (currentDeviceId) cameraSelect.value = currentDeviceId;

    // สลับกล้องต้อง stop ก่อน (แก้บางเครื่องเปิดไม่ติด)
    cameraSelect.onchange = async () => {
      await stopCamera();
      await startCamera(cameraSelect.value);
    };
  }

  async function startCamera(selectedDeviceId) {
    const deviceId = selectedDeviceId || currentDeviceId || "";

    // ป้องกันเปิดซ้อน
    if (cameraStarted) return;

    // stop เก่าถ้ามี
    if (activeStream) await stopCamera();

    cameraStarted = true;

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      qrVideo.srcObject = stream;
      activeStream = stream;
      await qrVideo.play();
      return stream;
    };

    try {
      // Try 1: exact deviceId
      if (deviceId) {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
          }
        });
        currentDeviceId = deviceId;
      } else {
        throw new Error("no deviceId");
      }
    } catch (e1) {
      try {
        // Try 2: ideal deviceId
        if (deviceId) {
          await tryOpen({
            audio: false,
            video: {
              deviceId: { ideal: deviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          });
          currentDeviceId = deviceId;
        } else {
          throw new Error("no deviceId");
        }
      } catch (e2) {
        try {
          // Try 3: facingMode environment (มือถือที่เลือกกล้องไม่ได้)
          await tryOpen({
            audio: false,
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          });
        } catch (e3) {
          try {
            // Try 4: video:true (ให้ browser เลือกกล้องให้)
            await tryOpen({ video: true, audio: false });
          } catch (e4) {
            cameraStarted = false;
            console.error("startCamera failed:", e1, e2, e3, e4);
            Swal.fire({
              icon: 'error',
              title: 'เปิดกล้องไม่สำเร็จ',
              html: `
                <div style="text-align:left;font-size:14px">
                  สาเหตุที่พบบ่อย:<br>
                  • ยังไม่อนุญาตสิทธิ์กล้อง (Allow)<br>
                  • เปิดผ่าน in-app browser (LINE/FB) ที่บล็อกกล้อง<br>
                  • มีแอป/แท็บอื่นใช้กล้องอยู่<br><br>
                  แนะนำ:<br>
                  1) เปิดลิงก์ด้วย Chrome/Safari โดยตรง<br>
                  2) ปิดแท็บอื่นที่ใช้กล้อง<br>
                  3) กด “เปิดกล้อง” อีกครั้ง
                </div>
              `,
              confirmButtonText: 'OK',
              allowOutsideClick: false
            });
            return;
          }
        }
      }
    }

    // หลังเปิดได้แล้ว: รีโหลด device list อีกที (เพื่อให้ label มาเต็ม)
    try { await initCameras(); } catch (_) {}

    // เริ่ม decode ต่อเนื่อง
    decodeLoop(currentDeviceId || null);
  }

  async function stopCamera() {
    apiBusy = false;
    cameraStarted = false;

    try { codeReader.reset(); } catch (_) {}

    if (activeStream && activeStream.getTracks) {
      activeStream.getTracks().forEach(t => t.stop());
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;
  }

  function decodeLoop(deviceIdOrNull) {
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
      if (!result) return;

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
      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
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

      // ไฮไลต์ Timestamp/Out
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

      setTimeout(() => {
        if (!cameraStarted && currentDeviceId) startCamera(currentDeviceId);
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
