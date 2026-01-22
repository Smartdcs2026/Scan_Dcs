// =============================
// ตั้งค่า URL ของ Apps Script Web App (ลงท้ายด้วย /exec)
// ตัวอย่าง: https://script.google.com/macros/s/AKfycbx.../exec
// =============================
const GAS_WEBAPP_URL = "PUT_YOUR_WEBAPP_EXEC_URL_HERE";

document.addEventListener('DOMContentLoaded', () => {
  const searchInput   = document.getElementById('searchInput');
  const searchBtn     = document.getElementById('searchBtn');
  const qrVideo       = document.getElementById('qrVideo');
  const cameraSelect  = document.getElementById('cameraSelect');
  const startButton   = document.getElementById('startCamera');
  const stopButton    = document.getElementById('stopCamera');

  const codeReader = new ZXing.BrowserQRCodeReader();
  let currentDeviceId = "";
  let scanning = false;
  let lastScanAt = 0;

  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };
  searchInput.addEventListener('input', () => { searchInput.value = searchInput.value.toUpperCase(); });

  searchBtn.addEventListener('click', () => runSearch(searchInput.value));
  searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') runSearch(searchInput.value); });

  startButton.addEventListener('click', () => startCamera(cameraSelect.value));
  stopButton.addEventListener('click',  () => stopCamera());

  // โหลดกล้อง
  initCameras().catch(err => console.error(err));

  async function initCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    const devices = await ZXing.BrowserQRCodeReader.listVideoInputDevices();
    cameraSelect.innerHTML = "";

    devices.forEach((d, idx) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.innerText = d.label || `Camera ${idx+1}`;
      cameraSelect.appendChild(opt);
    });

    // เลือกกล้องหลังบนมือถือถ้าเจอ
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile && devices.length) {
      const back = devices.find(d => /back|rear/i.test(d.label || ''));
      currentDeviceId = (back ? back.deviceId : devices[0].deviceId);
    } else {
      currentDeviceId = devices[0]?.deviceId || "";
    }

    if (currentDeviceId) cameraSelect.value = currentDeviceId;
    cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));

    // auto start
    if (currentDeviceId) startCamera(currentDeviceId);
  }

  function startCamera(selectedDeviceId) {
    if (scanning) return;
    scanning = true;

    currentDeviceId = selectedDeviceId || currentDeviceId || "";

    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(currentDeviceId || null, qrVideo, (result, err) => {
      const now = Date.now();
      if (result && now - lastScanAt > 900) {
        lastScanAt = now;
        const text = result.getText();
        playScanSound();
        runSearch(text);
      }
    });

    // กันกดรัว
    setTimeout(() => { scanning = false; }, 1200);
  }

  function stopCamera() {
    try { codeReader.reset(); } catch (_) {}
  }

  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    try {
      const res = await gasJsonp({
        action: "search",
        query
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || "API Error");
      }

      const htmlString = res.html || "";
      if (!htmlString) {
        Swal.fire({
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

      Swal.fire({
        title: 'ข้อมูล',
        html: doc.body.innerHTML,
        confirmButtonText: 'OK',
        showCloseButton: true,
        allowOutsideClick: false,
        timer: 5000
      }).then(() => { try { qrVideo.play(); } catch(e){} });

      searchInput.value = '';

    } catch (err) {
      console.error(err);
      playErrorSound();
      Swal.fire({
        icon:'error',
        title:'Error',
        text: String(err?.message || err),
        confirmButtonText:'OK',
        allowOutsideClick:false
      });
    }
  }

  function gasJsonp(params) {
    // ทำ JSONP โดยสร้าง <script src="...&callback=xxx">
    return new Promise((resolve, reject) => {
      if (!GAS_WEBAPP_URL || GAS_WEBAPP_URL.includes("PUT_YOUR_WEBAPP_EXEC_URL_HERE")) {
        reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL ใน app.js"));
        return;
      }

      const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
      const url = GAS_WEBAPP_URL + "?" + toQuery({
        ...params,
        callback: cbName,
        _ts: Date.now() // กัน cache
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

      // timeout กันค้าง
      setTimeout(() => {
        if (window[cbName]) {
          cleanup();
          reject(new Error("timeout เรียก Apps Script"));
        }
      }, 15000);
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
