// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ปรับพฤติกรรมสแกน
const SCAN_COOLDOWN_MS = 800;     // กันสแกนรัว (เวลาขั้นต่ำระหว่าง scan)
const SAME_CODE_HOLD_MS = 1800;   // กัน QR เดิมซ้ำ (ถือซ้ำในช่วงนี้)
const API_LOCK_TIMEOUT = 15000;   // timeout เรียก GAS
const AUTO_RESTART_MS = 1200;     // ถ้ากล้องหลุด ให้เริ่มใหม่

document.addEventListener('DOMContentLoaded', () => {
  const searchInput   = document.getElementById('searchInput');
  const searchBtn     = document.getElementById('searchBtn');
  const qrVideo       = document.getElementById('qrVideo');
  const cameraSelect  = document.getElementById('cameraSelect');
  const startButton   = document.getElementById('startCamera');
  const stopButton    = document.getElementById('stopCamera');

  // ใช้ reader ตัวเดียวตลอด (ลดการ reset)
  const codeReader = new ZXing.BrowserQRCodeReader();

  let currentDeviceId = "";
  let cameraStarted = false;

  // lock กันยิง API ซ้อน
  let apiBusy = false;

  // กันสแกนรัว
  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  // focus UX
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };
  searchInput.addEventListener('input', () => { searchInput.value = searchInput.value.toUpperCase(); });

  searchBtn.addEventListener('click', () => runSearch(searchInput.value));
  searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') runSearch(searchInput.value); });

  startButton.addEventListener('click', () => startCamera(cameraSelect.value));
  stopButton.addEventListener('click',  () => stopCamera());

  initCameras().catch(console.error);

  async function initCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    // ดึงรายการกล้อง
    const devices = await ZXing.BrowserQRCodeReader.listVideoInputDevices();
    cameraSelect.innerHTML = "";

    devices.forEach((d, idx) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.innerText = d.label || `Camera ${idx + 1}`;
      cameraSelect.appendChild(opt);
    });

    // เลือกกล้องหลัง
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile && devices.length) {
      const back = devices.find(d => /back|rear|environment/i.test(d.label || ''));
      currentDeviceId = (back ? back.deviceId : devices[0].deviceId);
    } else {
      currentDeviceId = devices[0]?.deviceId || "";
    }

    if (currentDeviceId) cameraSelect.value = currentDeviceId;
    cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));

    // auto start
    if (currentDeviceId) startCamera(currentDeviceId);
  }

  async function startCamera(selectedDeviceId) {
    currentDeviceId = selectedDeviceId || currentDeviceId || "";
    if (!currentDeviceId) return;

    // ถ้ากำลังเปิดอยู่แล้ว ไม่ต้อง reset บ่อย (เสถียรกว่า)
    if (cameraStarted) return;

    cameraStarted = true;

    // เคล็ดลับความไว/เสถียร: ขอ stream ด้วย constraints เองก่อน
    // แล้วส่ง deviceId ให้ ZXing ใช้ (จะช่วยเลือกกล้องหลัง + จำกัดความละเอียด)
    try {
      const constraints = {
        audio: false,
        video: {
          deviceId: { exact: currentDeviceId },
          facingMode: "environment",
          width:  { ideal: 1280 }, // ~720p/1080p (ไม่สูงเกิน ลดภาระ decode)
          height: { ideal: 720  },
          frameRate: { ideal: 30, max: 30 }
        }
      };

      // ขอ permission / warm up camera
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      qrVideo.srcObject = stream;
      await qrVideo.play();

      // เริ่ม decode ต่อเนื่อง (ไม่ต้อง setTimeout scanning)
      decodeLoop(currentDeviceId);

    } catch (err) {
      cameraStarted = false;
      console.error("startCamera error:", err);
      Swal.fire({
        icon: 'error',
        title: 'เปิดกล้องไม่สำเร็จ',
        text: 'กรุณาอนุญาตการใช้กล้อง และลองใหม่',
        confirmButtonText: 'OK',
        allowOutsideClick: false
      });
    }
  }

  function decodeLoop(deviceId) {
    // ใช้ decodeFromVideoDevice แบบต่อเนื่อง
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceId, qrVideo, async (result, err) => {
      // ถ้า error เป็น NotFound (ยังไม่เจอ QR) ให้เฉยๆ
      // ZXing จะเรียก callback เรื่อยๆอยู่แล้ว

      if (!result) return;

      const now = Date.now();
      if (apiBusy) return; // กำลังส่ง API อยู่ อย่ายิงซ้ำ

      // กันรัวตามเวลา
      if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

      const text = String(result.getText() || "").trim().toUpperCase();
      if (!text) return;

      // กัน QR เดิมซ้ำในช่วง hold
      if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

      lastScanAt = now;
      lastText = text;
      lastTextAt = now;

      playScanSound();

      // ล็อก API และ “พักสแกน” ระหว่างประมวลผล (เสถียรมากขึ้น)
      apiBusy = true;
      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
      }
    });
  }

  function stopCamera() {
    apiBusy = false;
    cameraStarted = false;

    try { codeReader.reset(); } catch (_) {}

    // ปิด stream ให้จริง
    const stream = qrVideo.srcObject;
    if (stream && stream.getTracks) {
      stream.getTracks().forEach(t => t.stop());
    }
    qrVideo.srcObject = null;
  }

  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    try {
      const res = await gasJsonp({ action: "search", query });

      if (!res || !res.ok) {
        throw new Error(res?.error || "API Error");
      }

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

      // ถ้า decode หลุด/ค้าง ให้ช่วย restart กล้องอัตโนมัติเล็กน้อย
      setTimeout(() => {
        if (!cameraStarted && currentDeviceId) startCamera(currentDeviceId);
      }, AUTO_RESTART_MS);
    }
  }

  function gasJsonp(params) {
    return new Promise((resolve, reject) => {
      if (!GAS_WEBAPP_URL) {
        reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL"));
        return;
      }

      const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
      const url = GAS_WEBAPP_URL + "?" + toQuery({
        ...params,
        callback: cbName,
        _ts: Date.now()
      });

      const script = document.createElement("script");
      script.src = url;
      script.async = true;

      window[cbName] = (data) => {
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        cleanup();
        reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
      };

      function cleanup() {
        try { delete window[cbName]; } catch(_) { window[cbName] = undefined; }
        if (script && script.parentNode) script.parentNode.removeChild(script);
      }

      document.body.appendChild(script);

      setTimeout(() => {
        if (window[cbName]) {
          cleanup();
          reject(new Error("timeout เรียก Apps Script"));
        }
      }, API_LOCK_TIMEOUT);
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
