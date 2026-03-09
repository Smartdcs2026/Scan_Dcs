// // ============================================================
// // app.js — Scan_Dcs (GitHub Pages) — FULL PACKAGE (SweetAlert)
// // ✅ เปิดกล้องค้างไว้ สแกนต่อเนื่อง
// // ✅ เลือกกล้องได้ (พร้อม fallback สำหรับมือถือบางรุ่น)
// // ✅ กันสแกนรัว + กัน QR เดิมซ้ำ
// // ✅ เรียก Google Apps Script ผ่าน JSONP (ไม่ติด CORS)
// // ✅ SweetAlert แสดงผลเหมือนเดิม (ไม่ใช้ Toast)
// // ✅ มีเสียงสแกนสำเร็จ / Error (WebAudio ไม่ต้องใช้ไฟล์เสียง)
// // ✅ Auto-stop camera ถ้า idle 30 วินาที (ประหยัดแบต)
// // ============================================================

// // =============================
// // GAS Web App URL (/exec)
// // =============================
// const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// // ===== Scan / API behavior =====
// const SCAN_COOLDOWN_MS   = 800;     // กันสแกนรัว
// const SAME_CODE_HOLD_MS  = 1800;    // กัน QR เดิมซ้ำ
// const API_LOCK_TIMEOUT   = 15000;   // timeout เรียก GAS
// const AUTO_RESTART_MS    = 1200;    // หน่วงก่อน resume decode หลัง error (ms)

// // ✅ Auto-stop camera if idle
// const CAMERA_IDLE_TIMEOUT_MS = 30000; // 30s

// document.addEventListener('DOMContentLoaded', () => {
//   // ===== PWA: Service Worker =====
//   if ("serviceWorker" in navigator) {
//     navigator.serviceWorker.register("./sw.js").catch(()=>{});
//   }

//   // ===== Elements =====
//   const searchInput   = document.getElementById('searchInput');
//   const searchBtn     = document.getElementById('searchBtn');
//   const qrVideo       = document.getElementById('qrVideo');
//   const cameraSelect  = document.getElementById('cameraSelect');
//   const startButton   = document.getElementById('startCamera');
//   const stopButton    = document.getElementById('stopCamera');

//   // ===== ZXing reader =====
//   const codeReader = new ZXing.BrowserQRCodeReader();

//   // ========= State =========
//   let currentDeviceId = "";
//   let cameraStarted = false;
//   let starting = false;

//   // decode control
//   let decoding = false;

//   // lock กันยิง API ซ้อน
//   let apiBusy = false;

//   // กันสแกนรัว + กัน QR เดิมซ้ำ
//   let lastScanAt = 0;
//   let lastText = "";
//   let lastTextAt = 0;

//   // stream handle
//   let activeStream = null;

//   // idle timer
//   let idleTimer = null;

//   // =============================
//   // Sound Engine (WebAudio)
//   // =============================
//   let audioCtx = null;

//   function initSoundEngine(){
//     if(!audioCtx){
//       audioCtx = new (window.AudioContext || window.webkitAudioContext)();
//     }
//     // บาง iOS ต้อง resume หลัง gesture
//     if (audioCtx.state === "suspended") {
//       audioCtx.resume().catch(()=>{});
//     }
//   }

//   function playScanSound(){
//     if(!audioCtx) return;
//     const o = audioCtx.createOscillator();
//     const g = audioCtx.createGain();
//     o.type = "sine";
//     o.frequency.value = 1200;
//     g.gain.value = 0.18;
//     o.connect(g);
//     g.connect(audioCtx.destination);
//     o.start();
//     o.stop(audioCtx.currentTime + 0.11);
//   }

//   function playErrorSound(){
//     if(!audioCtx) return;
//     const o = audioCtx.createOscillator();
//     const g = audioCtx.createGain();
//     o.type = "square";
//     o.frequency.value = 260;
//     g.gain.value = 0.22;
//     o.connect(g);
//     g.connect(audioCtx.destination);
//     o.start();
//     o.stop(audioCtx.currentTime + 0.16);
//   }

//   // =============================
//   // Idle control
//   // =============================
//   function bumpIdle_() {
//     if (!cameraStarted) return;
//     if (idleTimer) clearTimeout(idleTimer);
//     idleTimer = setTimeout(() => {
//       stopCamera(true); // auto stop
//     }, CAMERA_IDLE_TIMEOUT_MS);
//   }

//   // =============================
//   // UX
//   // =============================
//   window.onclick = (e) => {
//     if (e.target.id !== 'cameraSelect') searchInput.focus();
//   };

//   searchInput.addEventListener('input', () => {
//     searchInput.value = String(searchInput.value || '').toUpperCase();
//     bumpIdle_();
//   });

//   searchBtn.addEventListener('click', () => {
//     bumpIdle_();
//     runSearch(searchInput.value);
//   });

//   searchInput.addEventListener('keyup', (e) => {
//     bumpIdle_();
//     if (e.key === 'Enter') runSearch(searchInput.value);
//   });

//   // ✅ ขอ permission เฉพาะจาก user gesture (ปุ่ม)
//   startButton.addEventListener('click', async () => {
//     if (starting) return;
//     starting = true;
//     try {
//       initSoundEngine();     // 🔓 ปลดล็อกเสียงบน iOS
//       await startFlow_();
//     } finally {
//       starting = false;
//     }
//   });

//   stopButton.addEventListener('click', () => stopCamera(false));

//   cameraSelect.addEventListener('change', async () => {
//     if (!cameraStarted) return;
//     bumpIdle_();
//     await restartWithDevice_(cameraSelect.value);
//   });

//   // =============================
//   // Helpers
//   // =============================
//   function isMobile_() {
//     return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
//   }

//   function isInAppBrowser_() {
//     // LINE/FB/IG in-app browser มักเจอ permission เด้ง/เลือกกล้องไม่ได้
//     const ua = navigator.userAgent || "";
//     return /Line|FBAN|FBAV|Instagram/i.test(ua);
//   }

//   async function queryCameraPermission_() {
//     // permissions API ไม่รองรับทุกเบราว์เซอร์ → fallback unknown
//     try {
//       if (!navigator.permissions?.query) return "unknown";
//       const p = await navigator.permissions.query({ name: "camera" });
//       return p.state || "unknown";
//     } catch (_) {
//       return "unknown";
//     }
//   }

//   async function listVideoDevices_() {
//     const devices = await navigator.mediaDevices.enumerateDevices();
//     return devices.filter(d => d.kind === "videoinput");
//   }

//   function pickDefaultDevice_(devices) {
//     if (!devices?.length) return "";
//     if (isMobile_()) {
//       const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
//       return (back?.deviceId) || devices[0].deviceId;
//     }
//     return devices[0].deviceId;
//   }

//   async function refreshCameraSelect_() {
//     const cams = await listVideoDevices_();

//     cameraSelect.innerHTML = "";
//     cams.forEach((d, idx) => {
//       const opt = document.createElement("option");
//       opt.value = d.deviceId || "";
//       opt.textContent = d.label || `Camera ${idx + 1}`;
//       cameraSelect.appendChild(opt);
//     });

//     const def = pickDefaultDevice_(cams);
//     if (!currentDeviceId) currentDeviceId = def;
//     if (currentDeviceId) cameraSelect.value = currentDeviceId;

//     // UX: ถ้ามีกล้องเดียว ซ่อน dropdown
//     cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
//   }

//   // =============================
//   // Camera Flow
//   // =============================
//   async function startFlow_() {
//     if (!navigator.mediaDevices?.getUserMedia) {
//       playErrorSound();
//       return Swal.fire({
//         icon:'error',
//         title:'ไม่รองรับกล้อง',
//         text:'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง',
//         confirmButtonText:'OK'
//       });
//     }

//     // ลดปัญหา permission ใน in-app browser
//     if (isInAppBrowser_()) {
//       await Swal.fire({
//         icon: 'info',
//         title: 'แนะนำให้เปิดด้วย Chrome/Safari',
//         html: `<div style="font-size:14px;text-align:left">
//           บางเครื่องเมื่อเปิดผ่าน LINE/FB/IG จะขออนุญาตซ้ำหรือเปิดกล้องไม่ได้<br>
//           แนะนำ: เปิดลิงก์นี้ด้วย Chrome/Safari โดยตรง หรือ “Add to Home Screen” (PWA)
//         </div>`,
//         confirmButtonText: 'เข้าใจแล้ว'
//       });
//     }

//     // ถ้ายัง live อยู่ → ไม่ขอ permission ใหม่
//     if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
//       cameraStarted = true;
//       bumpIdle_();
//       resumeDecode_();
//       return;
//     }

//     // ถ้า permission denied (ในเบราว์เซอร์ที่รองรับ) → ไม่พยายามขอซ้ำ
//     const p = await queryCameraPermission_();
//     if (p === "denied") {
//       playErrorSound();
//       return Swal.fire({
//         icon: 'warning',
//         title: 'ไม่ได้รับอนุญาตใช้กล้อง',
//         html: `<div style="text-align:left;font-size:14px">
//           กรุณาอนุญาตกล้องในการตั้งค่า แล้วกลับมากด “เปิดกล้อง” อีกครั้ง<br><br>
//           • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
//           • Android: Site settings → Camera → Allow
//         </div>`,
//         confirmButtonText: 'OK',
//         allowOutsideClick: false
//       });
//     }

//     // เปิดกล้อง (prompt จะเกิด “ครั้งเดียว” ตอนนี้)
//     try {
//       await openCameraOnce_();
//     } catch (err) {
//       console.error(err);
//       playErrorSound();

//       const name = err?.name || "CameraError";
//       let msg = "ไม่สามารถเปิดกล้องได้";

//       if (name === "NotAllowedError") msg = "คุณกดไม่อนุญาตกล้อง หรือระบบบล็อกสิทธิ์กล้อง";
//       if (name === "NotFoundError")  msg = "ไม่พบกล้องในอุปกรณ์นี้";
//       if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่ (ปิดแอป/แท็บอื่นก่อน)";
//       if (name === "OverconstrainedError") msg = "เลือกกล้อง/ความละเอียดที่อุปกรณ์ไม่รองรับ";

//       return Swal.fire({
//         icon:'error',
//         title:'เปิดกล้องไม่สำเร็จ',
//         text: msg,
//         confirmButtonText:'OK'
//       });
//     }

//     // หลังได้ permission แล้ว refresh list เพื่อ label เต็ม
//     try { await refreshCameraSelect_(); } catch (_) {}

//     cameraStarted = true;
//     bumpIdle_();
//     resumeDecode_();
//   }

//   async function openCameraOnce_() {
//     await stopCamera(true); // กันค้าง / ปิดของเก่า

//     const tryOpen = async (constraints) => {
//       const stream = await navigator.mediaDevices.getUserMedia(constraints);
//       activeStream = stream;
//       qrVideo.srcObject = stream;
//       await qrVideo.play();
//       return true;
//     };

//     const wantDeviceId = cameraSelect.value || currentDeviceId || "";

//     // Try 1: exact deviceId
//     if (wantDeviceId) {
//       try {
//         await tryOpen({
//           audio: false,
//           video: {
//             deviceId: { exact: wantDeviceId },
//             width: { ideal: 1280 },
//             height: { ideal: 720 },
//             frameRate: { ideal: 30, max: 30 }
//           }
//         });
//         currentDeviceId = wantDeviceId;
//         return;
//       } catch (_) {}
//     }

//     // Try 2: facingMode environment (มือถือ)
//     try {
//       await tryOpen({
//         audio: false,
//         video: {
//           facingMode: { ideal: "environment" },
//           width: { ideal: 1280 },
//           height: { ideal: 720 }
//         }
//       });
//       return;
//     } catch (_) {}

//     // Try 3: browser choose
//     await tryOpen({ video: true, audio: false });
//   }

//   async function restartWithDevice_(deviceId) {
//     currentDeviceId = deviceId || currentDeviceId || "";
//     try {
//       await openCameraOnce_();
//       cameraStarted = true;
//       bumpIdle_();
//       resumeDecode_();
//     } catch (err) {
//       console.error(err);
//       playErrorSound();
//       cameraStarted = false;
//       Swal.fire({
//         icon: 'error',
//         title: 'สลับกล้องไม่สำเร็จ',
//         text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
//         confirmButtonText: 'OK'
//       });
//     }
//   }

//   async function stopCamera(fromIdle) {
//     apiBusy = false;
//     cameraStarted = false;
//     decoding = false;

//     if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

//     try { codeReader.reset(); } catch (_) {}

//     if (activeStream) {
//       try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
//     }
//     activeStream = null;

//     try { qrVideo.pause(); } catch (_) {}
//     qrVideo.srcObject = null;

//     if (fromIdle) {
//       Swal.fire({
//         icon: 'info',
//         title: 'ปิดกล้องอัตโนมัติ',
//         text: 'ไม่มีการใช้งานเกิน 30 วินาที ระบบปิดกล้องให้เพื่อประหยัดแบตเตอรี่',
//         timer: 1600,
//         showConfirmButton: false
//       });
//     }
//   }

//   // =============================
//   // Decode control
//   // =============================
//   function pauseDecode_() {
//     decoding = false;
//     try { codeReader.reset(); } catch (_) {}
//   }

//   function resumeDecode_() {
//     if (!cameraStarted) return;
//     if (decoding) return;
//     decoding = true;
//     decodeLoop_(currentDeviceId || null);
//   }

//   function decodeLoop_(deviceIdOrNull) {
//     try { codeReader.reset(); } catch (_) {}

//     codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
//       if (!decoding) return;

//       // ไม่เจอ QR → ZXing จะ callback เรื่อยๆ (ไม่ต้องทำอะไร)
//       if (!result) return;

//       // activity -> รีเซ็ต idle timer
//       bumpIdle_();

//       const now = Date.now();
//       if (apiBusy) return;
//       if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

//       const text = String(result.getText() || "").trim().toUpperCase();
//       if (!text) return;

//       if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

//       lastScanAt = now;
//       lastText = text;
//       lastTextAt = now;

//       playScanSound();

//       // ✅ นิ่งสุด: พัก decode ระหว่างทำงาน แล้วค่อย resume (แต่กล้องยังค้าง)
//       apiBusy = true;
//       pauseDecode_();

//       try {
//         await runSearch(text);
//       } finally {
//         apiBusy = false;
//         bumpIdle_();
//         // กลับมาสแกนต่อทันที (กล้องยังเปิดค้าง)
//         setTimeout(() => {
//           if (cameraStarted) resumeDecode_();
//         }, AUTO_RESTART_MS);
//       }
//     });
//   }

//   // =============================
//   // Search / GAS JSONP
//   // =============================
//   async function runSearch(query) {
//     query = String(query || "").trim().toUpperCase();
//     if (!query) return;

//     bumpIdle_(); // ถือว่า activity

//     try {
//       const res = await gasJsonp({ action: "search", query });
//       if (!res || !res.ok) throw new Error(res?.error || "API Error");

//       const htmlString = res.html || "";
//       if (!htmlString) {
//         playErrorSound();
//         await Swal.fire({
//           icon:'error',
//           title:'ไม่พบข้อมูล',
//           text:'กรุณาตรวจสอบข้อมูลการค้นหาอีกครั้ง',
//           confirmButtonText:'OK',
//           allowOutsideClick:false
//         });
//         searchInput.value = '';
//         return;
//       }

//       // ไฮไลต์ Timestamp/Out ใน html table ที่ส่งกลับมา
//       const parser = new DOMParser();
//       const doc = parser.parseFromString(htmlString, 'text/html');
//       const rows = doc.getElementsByTagName('tr');

//       for (const row of rows) {
//         const th = row.getElementsByTagName('th')[0];
//         if (!th) continue;

//         if (th.innerText === 'Timestamp') {
//           th.style.backgroundColor = '#FFFF99';
//           const td = row.getElementsByTagName('td')[0];
//           if (td) td.style.backgroundColor = '#FFFF99';
//         }
//         if (th.innerText === 'Timestamp Out') {
//           th.style.backgroundColor = '#00FFFF';
//           const td = row.getElementsByTagName('td')[0];
//           if (td) td.style.backgroundColor = '#00FFFF';
//         }
//       }

//       // ✅ SweetAlert แบบเดิม
//       await Swal.fire({
//         title: 'ข้อมูล',
//         html: doc.body.innerHTML,
//         confirmButtonText: 'OK',
//         showCloseButton: true,
//         allowOutsideClick: false,
//         timer: 5000
//       });

//       searchInput.value = '';

//     } catch (err) {
//       console.error(err);
//       playErrorSound();
//       await Swal.fire({
//         icon:'error',
//         title:'Error',
//         text: String(err?.message || err),
//         confirmButtonText:'OK',
//         allowOutsideClick:false
//       });
//     }
//   }

//   function gasJsonp(params) {
//     return new Promise((resolve, reject) => {
//       if (!GAS_WEBAPP_URL) return reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL"));

//       const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
//       const url = GAS_WEBAPP_URL + "?" + toQuery({ ...params, callback: cbName, _ts: Date.now() });

//       const script = document.createElement("script");
//       script.src = url;
//       script.async = true;

//       const timer = setTimeout(() => {
//         cleanup();
//         reject(new Error("timeout เรียก Apps Script"));
//       }, API_LOCK_TIMEOUT);

//       window[cbName] = (data) => {
//         clearTimeout(timer);
//         cleanup();
//         resolve(data);
//       };

//       script.onerror = () => {
//         clearTimeout(timer);
//         cleanup();
//         reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
//       };

//       function cleanup() {
//         try { delete window[cbName]; } catch(_) { window[cbName] = undefined; }
//         if (script && script.parentNode) script.parentNode.removeChild(script);
//       }

//       document.body.appendChild(script);
//     });
//   }

//   function toQuery(obj) {
//     const usp = new URLSearchParams();
//     Object.keys(obj || {}).forEach(k => {
//       const v = obj[k];
//       if (v === undefined || v === null) return;
//       usp.set(k, String(v));
//     });
//     return usp.toString();
//   }

//   // =============================
//   // Quality-of-life: ปิดกล้องเมื่อออกจากหน้า / เปลี่ยนแท็บ
//   // =============================
//   document.addEventListener('visibilitychange', () => {
//     if (document.hidden && cameraStarted) {
//       stopCamera(true);
//     }
//   });

// });





// ============================================================
// app.js — Scan_Dcs (GitHub Pages) — FULL PACKAGE (SweetAlert)
// ✅ เปิดกล้องค้างไว้ สแกนต่อเนื่อง
// ✅ เลือกกล้องได้ (พร้อม fallback สำหรับมือถือบางรุ่น)
// ✅ กันสแกนรัว + กัน QR เดิมซ้ำ
// ✅ เรียก Google Apps Script ผ่าน JSONP (ไม่ติด CORS)
// ✅ SweetAlert แสดงผลเหมือนเดิม (ไม่ใช้ Toast)
// ✅ มีเสียงสแกนสำเร็จ / Error (WebAudio ไม่ต้องใช้ไฟล์เสียง)
// ✅ Auto-stop camera ถ้า idle 30 วินาที (ประหยัดแบต)
// ============================================================

// =============================
// GAS Web App URL (/exec)
// =============================
// const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// // ===== Scan / API behavior =====
// const SCAN_COOLDOWN_MS   = 800;     // กันสแกนรัว
// const SAME_CODE_HOLD_MS  = 1800;    // กัน QR เดิมซ้ำ
// const API_LOCK_TIMEOUT   = 15000;   // timeout เรียก GAS
// const AUTO_RESTART_MS    = 700;     // หน่วงก่อน resume decode หลังปิด popup

// // ✅ Auto-stop camera if idle
// const CAMERA_IDLE_TIMEOUT_MS = 30000; // 30s

// document.addEventListener('DOMContentLoaded', () => {
//   // ===== PWA: Service Worker =====
//   if ("serviceWorker" in navigator) {
//     navigator.serviceWorker.register("./sw.js").catch(()=>{});
//   }

//   // ===== Elements =====
//   const searchInput   = document.getElementById('searchInput');
//   const searchBtn     = document.getElementById('searchBtn');
//   const qrVideo       = document.getElementById('qrVideo');
//   const cameraSelect  = document.getElementById('cameraSelect');
//   const startButton   = document.getElementById('startCamera');
//   const stopButton    = document.getElementById('stopCamera');

//   // ===== ZXing reader =====
//   const codeReader = new ZXing.BrowserQRCodeReader();

//   // ========= State =========
//   let currentDeviceId = "";
//   let cameraStarted = false;
//   let starting = false;

//   // decode control
//   let decoding = false;

//   // lock กันยิง API ซ้อน
//   let apiBusy = false;

//   // กันสแกนรัว + กัน QR เดิมซ้ำ
//   let lastScanAt = 0;
//   let lastText = "";
//   let lastTextAt = 0;

//   // stream handle
//   let activeStream = null;

//   // idle timer
//   let idleTimer = null;

//   // ==========================================================
//   // ✅ SOUND ENGINE (WebAudio) — FIX “NO SOUND”
//   // ==========================================================
//   let audioCtx = null;

//   function getAudioCtx_() {
//     if (!audioCtx) {
//       audioCtx = new (window.AudioContext || window.webkitAudioContext)();
//     }
//     return audioCtx;
//   }

//   async function unlockAudio_() {
//     try {
//       const ctx = getAudioCtx_();
//       if (ctx.state === "suspended") {
//         await ctx.resume();
//       }
//       // iOS บางรุ่นต้อง “เล่นเสียงเงียบสั้นๆ” ครั้งแรกเพื่อปลดล็อก
//       // (ทำแบบเบามากๆ ไม่รบกวน)
//       const o = ctx.createOscillator();
//       const g = ctx.createGain();
//       g.gain.value = 0.0001;
//       o.frequency.value = 1;
//       o.connect(g);
//       g.connect(ctx.destination);
//       o.start();
//       o.stop(ctx.currentTime + 0.02);
//     } catch (_) {}
//   }

//   function playTone_(freq, ms, type, gain) {
//     (async () => {
//       try {
//         const ctx = getAudioCtx_();
//         if (ctx.state === "suspended") await ctx.resume();

//         const o = ctx.createOscillator();
//         const g = ctx.createGain();
//         o.type = type || "sine";
//         o.frequency.value = freq;

//         g.gain.value = gain ?? 0.22;

//         o.connect(g);
//         g.connect(ctx.destination);

//         const t0 = ctx.currentTime;
//         // fade in/out ลดเสียงแตก
//         g.gain.setValueAtTime(0.0001, t0);
//         g.gain.exponentialRampToValueAtTime(Math.max(0.0001, g.gain.value), t0 + 0.01);
//         g.gain.exponentialRampToValueAtTime(0.0001, t0 + (ms / 1000));

//         o.start(t0);
//         o.stop(t0 + (ms / 1000) + 0.02);
//       } catch (_) {
//         // เงียบไว้ (ถ้า browser block)
//       }
//     })();
//   }

//   // ✅ เสียงสำเร็จ: ปิ๊บสูงสั้น
//   function playScanSound() {
//     playTone_(1400, 120, "sine", 0.25);
//   }

//   // ✅ เสียง Error: บี๊บต่ำ (2 จังหวะ) ให้รู้สึกว่า fail
//   function playErrorSound() {
//     playTone_(260, 160, "square", 0.22);
//     setTimeout(() => playTone_(220, 170, "square", 0.22), 180);
//   }

//   // ✅ ปลดล็อกเสียงด้วย user gesture หลายแบบ (มือถือชัวร์ขึ้น)
//   // ใครแตะหน้าจอครั้งแรก -> unlockAudio_
//   document.addEventListener("click", unlockAudio_, { passive: true });
//   document.addEventListener("touchstart", unlockAudio_, { passive: true });
//   document.addEventListener("pointerdown", unlockAudio_, { passive: true });

//   // =============================
//   // Idle control
//   // =============================
//   function bumpIdle_() {
//     if (!cameraStarted) return;
//     if (idleTimer) clearTimeout(idleTimer);
//     idleTimer = setTimeout(() => {
//       stopCamera(true); // auto stop
//     }, CAMERA_IDLE_TIMEOUT_MS);
//   }

//   // =============================
//   // UX
//   // =============================
//   window.onclick = (e) => {
//     if (e.target.id !== 'cameraSelect') searchInput.focus();
//   };

//   searchInput.addEventListener('input', () => {
//     searchInput.value = String(searchInput.value || '').toUpperCase();
//     bumpIdle_();
//   });

//   searchBtn.addEventListener('click', () => {
//     bumpIdle_();
//     runSearch(searchInput.value);
//   });

//   searchInput.addEventListener('keyup', (e) => {
//     bumpIdle_();
//     if (e.key === 'Enter') runSearch(searchInput.value);
//   });

//   // ✅ เปิดกล้อง (user gesture) -> unlock audio + start camera
//   startButton.addEventListener('click', async () => {
//     if (starting) return;
//     starting = true;
//     try {
//       await unlockAudio_(); // 🔥 สำคัญมาก: ให้เสียงทำงานแน่ๆ
//       await startFlow_();
//     } finally {
//       starting = false;
//     }
//   });

//   stopButton.addEventListener('click', () => stopCamera(false));

//   cameraSelect.addEventListener('change', async () => {
//     if (!cameraStarted) return;
//     bumpIdle_();
//     await restartWithDevice_(cameraSelect.value);
//   });

//   // =============================
//   // Helpers
//   // =============================
//   function isMobile_() {
//     return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
//   }

//   function isInAppBrowser_() {
//     const ua = navigator.userAgent || "";
//     return /Line|FBAN|FBAV|Instagram/i.test(ua);
//   }

//   async function queryCameraPermission_() {
//     try {
//       if (!navigator.permissions?.query) return "unknown";
//       const p = await navigator.permissions.query({ name: "camera" });
//       return p.state || "unknown";
//     } catch (_) {
//       return "unknown";
//     }
//   }

//   async function listVideoDevices_() {
//     const devices = await navigator.mediaDevices.enumerateDevices();
//     return devices.filter(d => d.kind === "videoinput");
//   }

//   function pickDefaultDevice_(devices) {
//     if (!devices?.length) return "";
//     if (isMobile_()) {
//       const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
//       return (back?.deviceId) || devices[0].deviceId;
//     }
//     return devices[0].deviceId;
//   }

//   async function refreshCameraSelect_() {
//     const cams = await listVideoDevices_();

//     cameraSelect.innerHTML = "";
//     cams.forEach((d, idx) => {
//       const opt = document.createElement("option");
//       opt.value = d.deviceId || "";
//       opt.textContent = d.label || `Camera ${idx + 1}`;
//       cameraSelect.appendChild(opt);
//     });

//     const def = pickDefaultDevice_(cams);
//     if (!currentDeviceId) currentDeviceId = def;
//     if (currentDeviceId) cameraSelect.value = currentDeviceId;

//     cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
//   }

//   // =============================
//   // Camera Flow
//   // =============================
//   async function startFlow_() {
//     if (!navigator.mediaDevices?.getUserMedia) {
//       playErrorSound();
//       return Swal.fire({
//         icon:'error',
//         title:'ไม่รองรับกล้อง',
//         text:'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง',
//         confirmButtonText:'OK'
//       });
//     }

//     if (isInAppBrowser_()) {
//       await Swal.fire({
//         icon: 'info',
//         title: 'แนะนำให้เปิดด้วย Chrome/Safari',
//         html: `<div style="font-size:14px;text-align:left">
//           บางเครื่องเมื่อเปิดผ่าน LINE/FB/IG จะขออนุญาตซ้ำหรือเปิดกล้องไม่ได้<br>
//           แนะนำ: เปิดลิงก์นี้ด้วย Chrome/Safari โดยตรง หรือ “Add to Home Screen” (PWA)
//         </div>`,
//         confirmButtonText: 'เข้าใจแล้ว'
//       });
//     }

//     if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
//       cameraStarted = true;
//       bumpIdle_();
//       resumeDecode_();
//       return;
//     }

//     const p = await queryCameraPermission_();
//     if (p === "denied") {
//       playErrorSound();
//       return Swal.fire({
//         icon: 'warning',
//         title: 'ไม่ได้รับอนุญาตใช้กล้อง',
//         html: `<div style="text-align:left;font-size:14px">
//           กรุณาอนุญาตกล้องในการตั้งค่า แล้วกลับมากด “เปิดกล้อง” อีกครั้ง<br><br>
//           • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
//           • Android: Site settings → Camera → Allow
//         </div>`,
//         confirmButtonText: 'OK',
//         allowOutsideClick: false
//       });
//     }

//     try {
//       await openCameraOnce_();
//     } catch (err) {
//       console.error(err);
//       playErrorSound();

//       const name = err?.name || "CameraError";
//       let msg = "ไม่สามารถเปิดกล้องได้";
//       if (name === "NotAllowedError") msg = "คุณกดไม่อนุญาตกล้อง หรือระบบบล็อกสิทธิ์กล้อง";
//       if (name === "NotFoundError")  msg = "ไม่พบกล้องในอุปกรณ์นี้";
//       if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่ (ปิดแอป/แท็บอื่นก่อน)";
//       if (name === "OverconstrainedError") msg = "เลือกกล้อง/ความละเอียดที่อุปกรณ์ไม่รองรับ";

//       return Swal.fire({
//         icon:'error',
//         title:'เปิดกล้องไม่สำเร็จ',
//         text: msg,
//         confirmButtonText:'OK'
//       });
//     }

//     try { await refreshCameraSelect_(); } catch (_) {}

//     cameraStarted = true;
//     bumpIdle_();
//     resumeDecode_();
//   }

//   async function openCameraOnce_() {
//     await stopCamera(true);

//     const tryOpen = async (constraints) => {
//       const stream = await navigator.mediaDevices.getUserMedia(constraints);
//       activeStream = stream;
//       qrVideo.srcObject = stream;
//       await qrVideo.play();
//       return true;
//     };

//     const wantDeviceId = cameraSelect.value || currentDeviceId || "";

//     // Try 1: exact deviceId
//     if (wantDeviceId) {
//       try {
//         await tryOpen({
//           audio: false,
//           video: {
//             deviceId: { exact: wantDeviceId },
//             width: { ideal: 1280 },
//             height: { ideal: 720 },
//             frameRate: { ideal: 30, max: 30 }
//           }
//         });
//         currentDeviceId = wantDeviceId;
//         return;
//       } catch (_) {}
//     }

//     // Try 2: facingMode environment
//     try {
//       await tryOpen({
//         audio: false,
//         video: {
//           facingMode: { ideal: "environment" },
//           width: { ideal: 1280 },
//           height: { ideal: 720 }
//         }
//       });
//       return;
//     } catch (_) {}

//     // Try 3: browser choose
//     await tryOpen({ video: true, audio: false });
//   }

//   async function restartWithDevice_(deviceId) {
//     currentDeviceId = deviceId || currentDeviceId || "";
//     try {
//       await openCameraOnce_();
//       cameraStarted = true;
//       bumpIdle_();
//       resumeDecode_();
//     } catch (err) {
//       console.error(err);
//       playErrorSound();
//       cameraStarted = false;
//       Swal.fire({
//         icon: 'error',
//         title: 'สลับกล้องไม่สำเร็จ',
//         text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
//         confirmButtonText: 'OK'
//       });
//     }
//   }

//   async function stopCamera(fromIdle) {
//     apiBusy = false;
//     cameraStarted = false;
//     decoding = false;

//     if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

//     try { codeReader.reset(); } catch (_) {}

//     if (activeStream) {
//       try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
//     }
//     activeStream = null;

//     try { qrVideo.pause(); } catch (_) {}
//     qrVideo.srcObject = null;

//     if (fromIdle) {
//       Swal.fire({
//         icon: 'info',
//         title: 'ปิดกล้องอัตโนมัติ',
//         text: 'ไม่มีการใช้งานเกิน 30 วินาที ระบบปิดกล้องให้เพื่อประหยัดแบตเตอรี่',
//         timer: 1600,
//         showConfirmButton: false
//       });
//     }
//   }

//   // =============================
//   // Decode control
//   // =============================
//   function pauseDecode_() {
//     decoding = false;
//     try { codeReader.reset(); } catch (_) {}
//   }

//   function resumeDecode_() {
//     if (!cameraStarted) return;
//     if (decoding) return;
//     decoding = true;
//     decodeLoop_(currentDeviceId || null);
//   }

//   function decodeLoop_(deviceIdOrNull) {
//     try { codeReader.reset(); } catch (_) {}

//     codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
//       if (!decoding) return;
//       if (!result) return;

//       bumpIdle_();

//       const now = Date.now();
//       if (apiBusy) return;
//       if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

//       const text = String(result.getText() || "").trim().toUpperCase();
//       if (!text) return;

//       if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

//       lastScanAt = now;
//       lastText = text;
//       lastTextAt = now;

//       // ✅ เล่นเสียงสำเร็จ
//       playScanSound();

//       apiBusy = true;
//       pauseDecode_();

//       try {
//         await runSearch(text);
//       } finally {
//         apiBusy = false;
//         bumpIdle_();
//         setTimeout(() => {
//           if (cameraStarted) resumeDecode_();
//         }, AUTO_RESTART_MS);
//       }
//     });
//   }

//   // =============================
//   // Search / GAS JSONP
//   // =============================
//   async function runSearch(query) {
//     query = String(query || "").trim().toUpperCase();
//     if (!query) return;

//     bumpIdle_();

//     try {
//       const res = await gasJsonp({ action: "search", query });
//       if (!res || !res.ok) throw new Error(res?.error || "API Error");

//       const htmlString = res.html || "";
//       if (!htmlString) {
//         playErrorSound();
//         await Swal.fire({
//           icon:'error',
//           title:'ไม่พบข้อมูล',
//           text:'กรุณาตรวจสอบข้อมูลการค้นหาอีกครั้ง',
//           confirmButtonText:'OK',
//           allowOutsideClick:false
//         });
//         searchInput.value = '';
//         return;
//       }

//       const parser = new DOMParser();
//       const doc = parser.parseFromString(htmlString, 'text/html');
//       const rows = doc.getElementsByTagName('tr');

//       for (const row of rows) {
//         const th = row.getElementsByTagName('th')[0];
//         if (!th) continue;

//         if (th.innerText === 'Timestamp') {
//           th.style.backgroundColor = '#FFFF99';
//           const td = row.getElementsByTagName('td')[0];
//           if (td) td.style.backgroundColor = '#FFFF99';
//         }
//         if (th.innerText === 'Timestamp Out') {
//           th.style.backgroundColor = '#00FFFF';
//           const td = row.getElementsByTagName('td')[0];
//           if (td) td.style.backgroundColor = '#00FFFF';
//         }
//       }

//       await Swal.fire({
//         title: 'ข้อมูล',
//         html: doc.body.innerHTML,
//         confirmButtonText: 'OK',
//         showCloseButton: true,
//         allowOutsideClick: false,
//         timer: 5000
//       });

//       searchInput.value = '';

//     } catch (err) {
//       console.error(err);
//       playErrorSound();
//       await Swal.fire({
//         icon:'error',
//         title:'Error',
//         text: String(err?.message || err),
//         confirmButtonText:'OK',
//         allowOutsideClick:false
//       });
//     }
//   }

//   function gasJsonp(params) {
//     return new Promise((resolve, reject) => {
//       if (!GAS_WEBAPP_URL) return reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL"));

//       const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
//       const url = GAS_WEBAPP_URL + "?" + toQuery({ ...params, callback: cbName, _ts: Date.now() });

//       const script = document.createElement("script");
//       script.src = url;
//       script.async = true;

//       const timer = setTimeout(() => {
//         cleanup();
//         reject(new Error("timeout เรียก Apps Script"));
//       }, API_LOCK_TIMEOUT);

//       window[cbName] = (data) => {
//         clearTimeout(timer);
//         cleanup();
//         resolve(data);
//       };

//       script.onerror = () => {
//         clearTimeout(timer);
//         cleanup();
//         reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
//       };

//       function cleanup() {
//         try { delete window[cbName]; } catch(_) { window[cbName] = undefined; }
//         if (script && script.parentNode) script.parentNode.removeChild(script);
//       }

//       document.body.appendChild(script);
//     });
//   }

//   function toQuery(obj) {
//     const usp = new URLSearchParams();
//     Object.keys(obj || {}).forEach(k => {
//       const v = obj[k];
//       if (v === undefined || v === null) return;
//       usp.set(k, String(v));
//     });
//     return usp.toString();
//   }

//   // =============================
//   // ปิดกล้องเมื่อออกจากหน้า / เปลี่ยนแท็บ (กันค้าง)
//   // =============================
//   document.addEventListener('visibilitychange', () => {
//     if (document.hidden && cameraStarted) {
//       stopCamera(true);
//     }
//   });

// });

// ============================================================
// app.js — Scan_Dcs PRO
// ============================================================

// const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// const SCAN_COOLDOWN_MS = 800;
// const SAME_CODE_HOLD_MS = 1800;
// const API_TIMEOUT_MS = 15000;
// const AUTO_RESTART_MS = 700;
// const CAMERA_IDLE_TIMEOUT_MS = 30000;
// const RETRY_DELAY_MS = 800;

// document.addEventListener('DOMContentLoaded', () => {
//   if ("serviceWorker" in navigator) {
//     navigator.serviceWorker.register("./sw.js").catch(() => {});
//   }

//   const searchInput   = document.getElementById('searchInput');
//   const searchBtn     = document.getElementById('searchBtn');
//   const qrVideo       = document.getElementById('qrVideo');
//   const cameraSelect  = document.getElementById('cameraSelect');
//   const startButton   = document.getElementById('startCamera');
//   const stopButton    = document.getElementById('stopCamera');
//   const cameraStatus  = document.getElementById('cameraStatus');

//   const resultCard    = document.getElementById('scanResult');
//   const resultGrid    = document.getElementById('resultGrid');
//   const resultHint    = document.getElementById('resultHint');
//   const clearResult   = document.getElementById('clearResult');

//   const codeReader = new ZXing.BrowserQRCodeReader();

//   let currentDeviceId = "";
//   let cameraStarted = false;
//   let starting = false;
//   let decoding = false;
//   let apiBusy = false;
//   let lastScanAt = 0;
//   let lastText = "";
//   let lastTextAt = 0;
//   let activeStream = null;
//   let idleTimer = null;
//   let currentRequestId = 0;

//   let audioCtx = null;

//   function setCameraStatus(text, type = "idle") {
//     cameraStatus.textContent = text || "";
//     cameraStatus.dataset.state = type;
//   }

//   function getAudioCtx_() {
//     if (!audioCtx) {
//       audioCtx = new (window.AudioContext || window.webkitAudioContext)();
//     }
//     return audioCtx;
//   }

//   async function unlockAudio_() {
//     try {
//       const ctx = getAudioCtx_();
//       if (ctx.state === "suspended") {
//         await ctx.resume();
//       }
//       const o = ctx.createOscillator();
//       const g = ctx.createGain();
//       g.gain.value = 0.0001;
//       o.frequency.value = 1;
//       o.connect(g);
//       g.connect(ctx.destination);
//       o.start();
//       o.stop(ctx.currentTime + 0.02);
//     } catch (_) {}
//   }

//   function playTone_(freq, ms, type, gain) {
//     (async () => {
//       try {
//         const ctx = getAudioCtx_();
//         if (ctx.state === "suspended") await ctx.resume();

//         const o = ctx.createOscillator();
//         const g = ctx.createGain();
//         o.type = type || "sine";
//         o.frequency.value = freq;
//         g.gain.value = gain ?? 0.22;

//         o.connect(g);
//         g.connect(ctx.destination);

//         const t0 = ctx.currentTime;
//         g.gain.setValueAtTime(0.0001, t0);
//         g.gain.exponentialRampToValueAtTime(Math.max(0.0001, g.gain.value), t0 + 0.01);
//         g.gain.exponentialRampToValueAtTime(0.0001, t0 + (ms / 1000));

//         o.start(t0);
//         o.stop(t0 + (ms / 1000) + 0.02);
//       } catch (_) {}
//     })();
//   }

//   function playScanSound() {
//     playTone_(1400, 120, "sine", 0.25);
//   }

//   function playErrorSound() {
//     playTone_(260, 160, "square", 0.22);
//     setTimeout(() => playTone_(220, 170, "square", 0.22), 180);
//   }

//   document.addEventListener("click", unlockAudio_, { passive: true });
//   document.addEventListener("touchstart", unlockAudio_, { passive: true });
//   document.addEventListener("pointerdown", unlockAudio_, { passive: true });

//   function bumpIdle_() {
//     if (!cameraStarted) return;
//     if (idleTimer) clearTimeout(idleTimer);
//     idleTimer = setTimeout(() => {
//       stopCamera(true);
//     }, CAMERA_IDLE_TIMEOUT_MS);
//   }

//   function showResult(record = {}, hint = "") {
//     resultGrid.innerHTML = "";
//     resultHint.textContent = hint || "บันทึกสำเร็จ";
//     resultCard.classList.remove("is-hidden");
//     resultCard.classList.add("flash");

//     const preferredOrder = [
//       "Auto ID", "รหัส", "ชื่อ-นามสกุล", "ชื่อ-สกุล", "เพศ", "เบอร์โทร",
//       "DC", "DC Name", "Timestamp", "Timestamp IN", "Timestamp Out", "Duration"
//     ];

//     const used = new Set();
//     const keys = [];

//     preferredOrder.forEach(k => {
//       if (record[k] != null && record[k] !== "") {
//         keys.push(k);
//         used.add(k);
//       }
//     });

//     Object.keys(record).forEach(k => {
//       if (!used.has(k) && record[k] != null && record[k] !== "") {
//         keys.push(k);
//       }
//     });

//     keys.forEach(key => {
//       const k = document.createElement("div");
//       k.className = "k";
//       k.textContent = key;

//       const v = document.createElement("div");
//       v.className = "v";
//       v.textContent = String(record[key]);

//       if (key === "Timestamp" || key === "Timestamp IN") {
//         k.classList.add("hl-in");
//         v.classList.add("hl-in");
//       }

//       if (key === "Timestamp Out") {
//         k.classList.add("hl-out");
//         v.classList.add("hl-out");
//       }

//       if (key === "Duration") {
//         k.classList.add("hl-dur");
//         v.classList.add("hl-dur");
//       }

//       resultGrid.appendChild(k);
//       resultGrid.appendChild(v);
//     });

//     setTimeout(() => resultCard.classList.remove("flash"), 250);
//   }

//   function clearResultCard_() {
//     resultGrid.innerHTML = "";
//     resultHint.textContent = "พร้อมสแกน...";
//     resultCard.classList.add("is-hidden");
//   }

//   clearResult.addEventListener("click", clearResultCard_);

//   window.onclick = (e) => {
//     if (e.target.id !== 'cameraSelect') searchInput.focus();
//   };

//   searchInput.addEventListener('input', () => {
//     searchInput.value = String(searchInput.value || '').toUpperCase();
//     bumpIdle_();
//   });

//   searchBtn.addEventListener('click', () => {
//     bumpIdle_();
//     runSearch(searchInput.value);
//   });

//   searchInput.addEventListener('keyup', (e) => {
//     bumpIdle_();
//     if (e.key === 'Enter') runSearch(searchInput.value);
//   });

//   startButton.addEventListener('click', async () => {
//     if (starting) return;
//     starting = true;
//     try {
//       await unlockAudio_();
//       await startFlow_();
//     } finally {
//       starting = false;
//     }
//   });

//   stopButton.addEventListener('click', () => stopCamera(false));

//   cameraSelect.addEventListener('change', async () => {
//     if (!cameraStarted) return;
//     bumpIdle_();
//     await restartWithDevice_(cameraSelect.value);
//   });

//   function isMobile_() {
//     return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
//   }

//   function isInAppBrowser_() {
//     const ua = navigator.userAgent || "";
//     return /Line|FBAN|FBAV|Instagram/i.test(ua);
//   }

//   async function queryCameraPermission_() {
//     try {
//       if (!navigator.permissions?.query) return "unknown";
//       const p = await navigator.permissions.query({ name: "camera" });
//       return p.state || "unknown";
//     } catch (_) {
//       return "unknown";
//     }
//   }

//   async function listVideoDevices_() {
//     const devices = await navigator.mediaDevices.enumerateDevices();
//     return devices.filter(d => d.kind === "videoinput");
//   }

//   function pickDefaultDevice_(devices) {
//     if (!devices?.length) return "";
//     if (isMobile_()) {
//       const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
//       return (back?.deviceId) || devices[0].deviceId;
//     }
//     return devices[0].deviceId;
//   }

//   async function refreshCameraSelect_() {
//     const cams = await listVideoDevices_();
//     cameraSelect.innerHTML = "";

//     cams.forEach((d, idx) => {
//       const opt = document.createElement("option");
//       opt.value = d.deviceId || "";
//       opt.textContent = d.label || `Camera ${idx + 1}`;
//       cameraSelect.appendChild(opt);
//     });

//     const def = pickDefaultDevice_(cams);
//     if (!currentDeviceId) currentDeviceId = def;
//     if (currentDeviceId) cameraSelect.value = currentDeviceId;

//     cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
//   }

//   async function startFlow_() {
//     if (!navigator.mediaDevices?.getUserMedia) {
//       playErrorSound();
//       return Swal.fire({
//         icon: 'error',
//         title: 'ไม่รองรับกล้อง',
//         text: 'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง',
//         confirmButtonText: 'ตกลง'
//       });
//     }

//     if (isInAppBrowser_()) {
//       await Swal.fire({
//         icon: 'info',
//         title: 'แนะนำให้เปิดด้วย Chrome/Safari',
//         html: `<div style="font-size:14px;text-align:left">
//           บางเครื่องเมื่อเปิดผ่าน LINE/FB/IG จะขออนุญาตซ้ำหรือเปิดกล้องไม่ได้<br>
//           แนะนำให้เปิดลิงก์นี้ด้วย Chrome/Safari โดยตรง หรือ Add to Home Screen
//         </div>`,
//         confirmButtonText: 'เข้าใจแล้ว'
//       });
//     }

//     if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
//       cameraStarted = true;
//       setCameraStatus("กล้องพร้อมสแกน", "live");
//       bumpIdle_();
//       resumeDecode_();
//       return;
//     }

//     const p = await queryCameraPermission_();
//     if (p === "denied") {
//       playErrorSound();
//       return Swal.fire({
//         icon: 'warning',
//         title: 'ไม่ได้รับอนุญาตใช้กล้อง',
//         html: `<div style="text-align:left;font-size:14px">
//           กรุณาอนุญาตกล้องในการตั้งค่า แล้วกลับมากด “เปิดกล้อง” อีกครั้ง<br><br>
//           • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
//           • Android: Site settings → Camera → Allow
//         </div>`,
//         confirmButtonText: 'ตกลง',
//         allowOutsideClick: false
//       });
//     }

//     try {
//       setCameraStatus("กำลังเปิดกล้อง...", "loading");
//       await openCameraOnce_();
//     } catch (err) {
//       console.error(err);
//       playErrorSound();
//       setCameraStatus("เปิดกล้องไม่สำเร็จ", "error");

//       const name = err?.name || "CameraError";
//       let msg = "ไม่สามารถเปิดกล้องได้";
//       if (name === "NotAllowedError") msg = "คุณกดไม่อนุญาตกล้อง หรือระบบบล็อกสิทธิ์กล้อง";
//       if (name === "NotFoundError") msg = "ไม่พบกล้องในอุปกรณ์นี้";
//       if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่";
//       if (name === "OverconstrainedError") msg = "เลือกกล้อง/ความละเอียดที่อุปกรณ์ไม่รองรับ";

//       return Swal.fire({
//         icon: 'error',
//         title: 'เปิดกล้องไม่สำเร็จ',
//         text: msg,
//         confirmButtonText: 'ตกลง'
//       });
//     }

//     try { await refreshCameraSelect_(); } catch (_) {}

//     cameraStarted = true;
//     setCameraStatus("กล้องพร้อมสแกน", "live");
//     bumpIdle_();
//     resumeDecode_();
//   }

//   async function openCameraOnce_() {
//     await stopCamera(true, true);

//     const tryOpen = async (constraints) => {
//       const stream = await navigator.mediaDevices.getUserMedia(constraints);
//       activeStream = stream;
//       qrVideo.srcObject = stream;
//       await qrVideo.play();
//       return true;
//     };

//     const wantDeviceId = cameraSelect.value || currentDeviceId || "";

//     if (wantDeviceId) {
//       try {
//         await tryOpen({
//           audio: false,
//           video: {
//             deviceId: { exact: wantDeviceId },
//             width: { ideal: 1280 },
//             height: { ideal: 720 },
//             frameRate: { ideal: 30, max: 30 }
//           }
//         });
//         currentDeviceId = wantDeviceId;
//         return;
//       } catch (_) {}
//     }

//     try {
//       await tryOpen({
//         audio: false,
//         video: {
//           facingMode: { ideal: "environment" },
//           width: { ideal: 1280 },
//           height: { ideal: 720 }
//         }
//       });
//       return;
//     } catch (_) {}

//     await tryOpen({ video: true, audio: false });
//   }

//   async function restartWithDevice_(deviceId) {
//     currentDeviceId = deviceId || currentDeviceId || "";
//     try {
//       setCameraStatus("กำลังสลับกล้อง...", "loading");
//       await openCameraOnce_();
//       cameraStarted = true;
//       setCameraStatus("กล้องพร้อมสแกน", "live");
//       bumpIdle_();
//       resumeDecode_();
//     } catch (err) {
//       console.error(err);
//       playErrorSound();
//       cameraStarted = false;
//       setCameraStatus("สลับกล้องไม่สำเร็จ", "error");
//       Swal.fire({
//         icon: 'error',
//         title: 'สลับกล้องไม่สำเร็จ',
//         text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
//         confirmButtonText: 'ตกลง'
//       });
//     }
//   }

//   async function stopCamera(fromIdle, silent = false) {
//     apiBusy = false;
//     cameraStarted = false;
//     decoding = false;

//     if (idleTimer) {
//       clearTimeout(idleTimer);
//       idleTimer = null;
//     }

//     try { codeReader.reset(); } catch (_) {}

//     if (activeStream) {
//       try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
//     }
//     activeStream = null;

//     try { qrVideo.pause(); } catch (_) {}
//     qrVideo.srcObject = null;
//     setCameraStatus("กล้องปิดอยู่", "idle");

//     if (fromIdle && !silent) {
//       Swal.fire({
//         icon: 'info',
//         title: 'ปิดกล้องอัตโนมัติ',
//         text: 'ไม่มีการใช้งานเกิน 30 วินาที ระบบปิดกล้องให้เพื่อประหยัดแบตเตอรี่',
//         timer: 1600,
//         showConfirmButton: false
//       });
//     }
//   }

//   function pauseDecode_() {
//     decoding = false;
//     try { codeReader.reset(); } catch (_) {}
//   }

//   function resumeDecode_() {
//     if (!cameraStarted) return;
//     if (decoding) return;
//     decoding = true;
//     decodeLoop_(currentDeviceId || null);
//   }

//   function decodeLoop_(deviceIdOrNull) {
//     try { codeReader.reset(); } catch (_) {}

//     codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result) => {
//       if (!decoding) return;
//       if (!result) return;

//       bumpIdle_();

//       const now = Date.now();
//       if (apiBusy) return;
//       if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

//       const text = String(result.getText() || "").trim().toUpperCase();
//       if (!text) return;

//       if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

//       lastScanAt = now;
//       lastText = text;
//       lastTextAt = now;

//       playScanSound();

//       apiBusy = true;
//       pauseDecode_();

//       try {
//         await runSearch(text);
//       } finally {
//         apiBusy = false;
//         bumpIdle_();
//         setTimeout(() => {
//           if (cameraStarted) resumeDecode_();
//         }, AUTO_RESTART_MS);
//       }
//     });
//   }

//   async function runSearch(query) {
//     query = String(query || "").trim().toUpperCase();
//     if (!query) return;

//     bumpIdle_();
//     const reqId = ++currentRequestId;
//     setCameraStatus("กำลังค้นหา...", "loading");

//     try {
//       const res = await gasJsonpWithRetry({ action: "search", query }, 1);
//       if (reqId !== currentRequestId) return;

//       if (!res || typeof res !== "object") {
//         throw new Error("รูปแบบข้อมูลตอบกลับไม่ถูกต้อง");
//       }

//       if (res.ok && res.status === "success") {
//         const record = res.data?.record || {};
//         showResult(record, res.detail || "บันทึกสำเร็จ");
//         setCameraStatus("บันทึกสำเร็จ", "success");

//         await Swal.fire({
//           icon: 'success',
//           title: res.title || 'บันทึกสำเร็จ',
//           text: res.detail || '',
//           confirmButtonText: 'ตกลง',
//           allowOutsideClick: false,
//           timer: 2500
//         });

//         searchInput.value = '';
//         return;
//       }

//       if (res.status === "duplicate") {
//         playErrorSound();
//         setCameraStatus("พบข้อมูลซ้ำ", "warning");
//         if (res.data) showResult(res.data, res.detail || "ข้อมูลนี้ออกระบบแล้ว");

//         await Swal.fire({
//           icon: 'warning',
//           title: res.title || 'บันทึกซ้ำไม่ได้',
//           text: res.detail || '',
//           confirmButtonText: 'ตกลง',
//           allowOutsideClick: false
//         });

//         searchInput.value = '';
//         return;
//       }

//       playErrorSound();
//       setCameraStatus("เกิดข้อผิดพลาด", "error");

//       await Swal.fire({
//         icon: 'error',
//         title: res.title || 'เกิดข้อผิดพลาด',
//         text: res.detail || res.error || 'ไม่สามารถประมวลผลได้',
//         confirmButtonText: 'ตกลง',
//         allowOutsideClick: false
//       });

//       searchInput.value = '';
//     } catch (err) {
//       console.error(err);
//       if (reqId !== currentRequestId) return;

//       playErrorSound();
//       setCameraStatus("เชื่อมต่อไม่สำเร็จ", "error");

//       await Swal.fire({
//         icon: 'error',
//         title: 'Error',
//         text: String(err?.message || err),
//         confirmButtonText: 'ตกลง',
//         allowOutsideClick: false
//       });
//     }
//   }

//   function gasJsonp(params) {
//     return new Promise((resolve, reject) => {
//       if (!GAS_WEBAPP_URL) {
//         reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL"));
//         return;
//       }

//       const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
//       const url = GAS_WEBAPP_URL + "?" + toQuery({ ...params, callback: cbName, _ts: Date.now() });

//       const script = document.createElement("script");
//       let done = false;

//       const timer = setTimeout(() => {
//         if (done) return;
//         done = true;
//         cleanup();
//         reject(new Error("timeout เรียก Apps Script"));
//       }, API_TIMEOUT_MS);

//       window[cbName] = (data) => {
//         if (done) return;
//         done = true;
//         clearTimeout(timer);
//         cleanup();
//         resolve(data);
//       };

//       script.onerror = () => {
//         if (done) return;
//         done = true;
//         clearTimeout(timer);
//         cleanup();
//         reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
//       };

//       function cleanup() {
//         try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
//         if (script.parentNode) script.parentNode.removeChild(script);
//       }

//       script.src = url;
//       script.async = true;
//       document.body.appendChild(script);
//     });
//   }

//   async function gasJsonpWithRetry(params, retries = 1) {
//     try {
//       return await gasJsonp(params);
//     } catch (err) {
//       const msg = String(err?.message || err || "");
//       const retriable =
//         /timeout/i.test(msg) ||
//         /network\/script error/i.test(msg);

//       if (!retriable || retries <= 0) throw err;

//       await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
//       return gasJsonpWithRetry(params, retries - 1);
//     }
//   }

//   function toQuery(obj) {
//     const usp = new URLSearchParams();
//     Object.keys(obj || {}).forEach(k => {
//       const v = obj[k];
//       if (v === undefined || v === null) return;
//       usp.set(k, String(v));
//     });
//     return usp.toString();
//   }

//   document.addEventListener('visibilitychange', () => {
//     if (document.hidden && cameraStarted) {
//       stopCamera(true, true);
//     }
//   });

//   setCameraStatus("กล้องปิดอยู่", "idle");
// });

const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

const SCAN_COOLDOWN_MS = 900;
const SAME_CODE_HOLD_MS = 1800;
const API_TIMEOUT_MS = 20000;
const AUTO_RESTART_MS = 800;
const CAMERA_IDLE_TIMEOUT_MS = 120000; // 2 นาที
const RETRY_DELAY_MS = 900;
const MAX_API_RETRY = 1;

document.addEventListener('DOMContentLoaded', () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const qrVideo = document.getElementById('qrVideo');
  const cameraSelect = document.getElementById('cameraSelect');
  const startButton = document.getElementById('startCamera');
  const stopButton = document.getElementById('stopCamera');
  const cameraStatus = document.getElementById('cameraStatus');

  const resultCard = document.getElementById('scanResult');
  const resultGrid = document.getElementById('resultGrid');
  const resultHint = document.getElementById('resultHint');
  const clearResult = document.getElementById('clearResult');

  const codeReader = new ZXing.BrowserMultiFormatReader();

  let currentDeviceId = "";
  let cameraStarted = false;
  let starting = false;
  let decoding = false;
  let apiBusy = false;
  let activeStream = null;
  let idleTimer = null;
  let currentRequestId = 0;
  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  let audioCtx = null;

  function setCameraStatus(text, type = "idle") {
    cameraStatus.textContent = text || "";
    cameraStatus.dataset.state = type;
  }

  function normalizeCode_(v) {
    return String(v || "")
      .replace(/\u00A0/g, " ")
      .trim()
      .toUpperCase();
  }

  function isSecureContextOk_() {
    return window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  }

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isIOS_() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isInAppBrowser_() {
    const ua = navigator.userAgent || "";
    return /Line|FBAN|FBAV|Instagram/i.test(ua);
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
    playTone_(1350, 110, "sine", 0.25);
  }

  function playErrorSound() {
    playTone_(260, 160, "square", 0.22);
    setTimeout(() => playTone_(220, 170, "square", 0.22), 180);
  }

  document.addEventListener("click", unlockAudio_, { passive: true });
  document.addEventListener("touchstart", unlockAudio_, { passive: true });
  document.addEventListener("pointerdown", unlockAudio_, { passive: true });

  function bumpIdle_() {
    if (!cameraStarted) return;

    if (idleTimer) clearTimeout(idleTimer);

    idleTimer = setTimeout(() => {
      stopCamera(true);
    }, CAMERA_IDLE_TIMEOUT_MS);
  }

  function clearResultCard_() {
    resultGrid.innerHTML = "";
    resultHint.textContent = "พร้อมสแกน...";
    resultCard.classList.add("is-hidden");
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

    preferredOrder.forEach(k => {
      if (record[k] != null && record[k] !== "") {
        keys.push(k);
        used.add(k);
      }
    });

    Object.keys(record).forEach(k => {
      if (!used.has(k) && record[k] != null && record[k] !== "") {
        keys.push(k);
      }
    });

    keys.forEach(key => {
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

    setTimeout(() => resultCard.classList.remove("flash"), 250);
  }

  clearResult.addEventListener("click", clearResultCard_);

  window.addEventListener("pagehide", () => {
    stopCamera(true, true);
  });

  window.addEventListener("beforeunload", () => {
    stopCamera(true, true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && cameraStarted) {
      stopCamera(true, true);
    }
  });

  window.onclick = (e) => {
    if (e.target.id !== 'cameraSelect') {
      searchInput.focus();
    }
  };

  searchInput.addEventListener('input', () => {
    searchInput.value = normalizeCode_(searchInput.value);
    bumpIdle_();
  });

  searchInput.addEventListener('keyup', (e) => {
    bumpIdle_();
    if (e.key === 'Enter') runSearch(searchInput.value);
  });

  searchBtn.addEventListener('click', () => {
    bumpIdle_();
    runSearch(searchInput.value);
  });

  startButton.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    try {
      await unlockAudio_();
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
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === "videoinput");
    } catch (_) {
      return [];
    }
  }

  function pickDefaultDevice_(devices) {
    if (!devices?.length) return "";

    if (isMobile_()) {
      const back = devices.find(d => /back|rear|environment|หลัง/i.test(d.label || ""));
      return (back?.deviceId) || devices[0].deviceId || "";
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

    cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
  }

  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      playErrorSound();
      return Swal.fire({
        icon: 'error',
        title: 'ไม่รองรับกล้อง',
        text: 'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง',
        confirmButtonText: 'ตกลง'
      });
    }

    if (!isSecureContextOk_()) {
      playErrorSound();
      return Swal.fire({
        icon: 'warning',
        title: 'ต้องเปิดผ่าน HTTPS',
        text: 'การใช้กล้องต้องเปิดเว็บผ่าน HTTPS หรือ localhost เท่านั้น',
        confirmButtonText: 'ตกลง'
      });
    }

    if (isInAppBrowser_()) {
      await Swal.fire({
        icon: 'info',
        title: 'แนะนำให้เปิดด้วย Chrome / Safari',
        html: `<div style="font-size:14px;text-align:left">
          บางเครื่องเมื่อเปิดผ่าน LINE / Facebook / Instagram จะเปิดกล้องไม่เสถียร<br><br>
          แนะนำให้กดเปิดด้วยเบราว์เซอร์หลักของเครื่อง แล้วค่อยใช้งานสแกน
        </div>`,
        confirmButtonText: 'เข้าใจแล้ว'
      });
    }

    if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraStarted = true;
      setCameraStatus("กล้องพร้อมสแกน", "live");
      bumpIdle_();
      resumeDecode_();
      return;
    }

    const permission = await queryCameraPermission_();
    if (permission === "denied") {
      playErrorSound();
      return Swal.fire({
        icon: 'warning',
        title: 'ไม่ได้รับอนุญาตใช้กล้อง',
        html: `<div style="text-align:left;font-size:14px">
          กรุณาอนุญาตกล้องในการตั้งค่า แล้วกลับมากด “เปิดกล้อง” อีกครั้ง<br><br>
          • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
          • Android: Site settings → Camera → Allow
        </div>`,
        confirmButtonText: 'ตกลง',
        allowOutsideClick: false
      });
    }

    try {
      setCameraStatus("กำลังเปิดกล้อง...", "loading");
      await openCameraOnce_();
      await refreshCameraSelect_();

      cameraStarted = true;
      setCameraStatus("กล้องพร้อมสแกน", "live");
      bumpIdle_();
      resumeDecode_();
    } catch (err) {
      console.error(err);
      playErrorSound();
      setCameraStatus("เปิดกล้องไม่สำเร็จ", "error");

      const name = err?.name || "CameraError";
      let msg = "ไม่สามารถเปิดกล้องได้";
      if (name === "NotAllowedError") msg = "คุณกดไม่อนุญาตกล้อง หรือระบบบล็อกสิทธิ์กล้อง";
      if (name === "NotFoundError") msg = "ไม่พบกล้องในอุปกรณ์นี้";
      if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่";
      if (name === "OverconstrainedError") msg = "อุปกรณ์ไม่รองรับข้อกำหนดกล้องที่เลือก";

      return Swal.fire({
        icon: 'error',
        title: 'เปิดกล้องไม่สำเร็จ',
        text: msg,
        confirmButtonText: 'ตกลง'
      });
    }
  }

  async function openCameraOnce_() {
    await stopCamera(true, true);

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
      qrVideo.srcObject = stream;
      qrVideo.setAttribute("playsinline", "true");
      qrVideo.muted = true;
      await qrVideo.play();

      const track = stream.getVideoTracks()[0];
      if (track) {
        const settings = track.getSettings ? track.getSettings() : {};
        if (settings.deviceId) currentDeviceId = settings.deviceId;
      }

      return true;
    };

    const selectedId = cameraSelect.value || currentDeviceId || "";

    // 1) exact deviceId
    if (selectedId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: selectedId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 24, max: 30 }
          }
        });
        currentDeviceId = selectedId;
        return;
      } catch (_) {}
    }

    // 2) environment camera
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
      return;
    } catch (_) {}

    // 3) simple facingMode
    try {
      await tryOpen({
        audio: false,
        video: {
          facingMode: "environment"
        }
      });
      return;
    } catch (_) {}

    // 4) any camera
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
      resumeDecode_();
    } catch (err) {
      console.error(err);
      playErrorSound();
      cameraStarted = false;
      setCameraStatus("สลับกล้องไม่สำเร็จ", "error");

      Swal.fire({
        icon: 'error',
        title: 'สลับกล้องไม่สำเร็จ',
        text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
        confirmButtonText: 'ตกลง'
      });
    }
  }

  async function stopCamera(fromIdle, silent = false) {
    apiBusy = false;
    cameraStarted = false;
    decoding = false;

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try {
        activeStream.getTracks().forEach(t => t.stop());
      } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;

    setCameraStatus("กล้องปิดอยู่", "idle");

    if (fromIdle && !silent) {
      Swal.fire({
        icon: 'info',
        title: 'ปิดกล้องอัตโนมัติ',
        text: 'ไม่มีการใช้งานเกิน 2 นาที ระบบปิดกล้องให้เพื่อประหยัดแบตเตอรี่',
        timer: 1800,
        showConfirmButton: false
      });
    }
  }

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

      if (err && !(err instanceof ZXing.NotFoundException)) {
        // ไม่ต้องแจ้งทุก error ของ ZXing เพราะมันจะเด้งบ่อยระหว่างหาโค้ด
      }

      if (!result) return;

      bumpIdle_();

      const now = Date.now();
      if (apiBusy) return;
      if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

      const text = normalizeCode_(result.getText());
      if (!text) return;

      if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

      lastScanAt = now;
      lastText = text;
      lastTextAt = now;

      playScanSound();

      apiBusy = true;
      pauseDecode_();

      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
        bumpIdle_();

        setTimeout(() => {
          if (cameraStarted) resumeDecode_();
        }, AUTO_RESTART_MS);
      }
    });
  }

  async function runSearch(query) {
    query = normalizeCode_(query);
    if (!query) return;

    bumpIdle_();
    const reqId = ++currentRequestId;
    setCameraStatus("กำลังค้นหา...", "loading");

    try {
      const res = await gasJsonpWithRetry({ action: "search", query }, MAX_API_RETRY);
      if (reqId !== currentRequestId) return;

      if (!res || typeof res !== "object") {
        throw new Error("รูปแบบข้อมูลตอบกลับไม่ถูกต้อง");
      }

      const status = String(res.status || "");

      if (res.ok && status === "success") {
        const record = res.data?.record || {};
        showResult(record, res.detail || "บันทึกสำเร็จ");
        setCameraStatus("บันทึกสำเร็จ", "success");

        await Swal.fire({
          icon: 'success',
          title: res.title || 'บันทึกสำเร็จ',
          text: res.detail || '',
          confirmButtonText: 'ตกลง',
          allowOutsideClick: false,
          timer: 2500
        });

        searchInput.value = '';
        return;
      }

      if (res.ok && status === "duplicate") {
        playErrorSound();
        setCameraStatus("พบข้อมูลซ้ำ", "warning");

        if (res.data?.record) {
          showResult(res.data.record, res.detail || "ข้อมูลนี้ออกระบบแล้ว");
        }

        await Swal.fire({
          icon: 'warning',
          title: res.title || 'บันทึกซ้ำไม่ได้',
          text: res.detail || '',
          confirmButtonText: 'ตกลง',
          allowOutsideClick: false
        });

        searchInput.value = '';
        return;
      }

      playErrorSound();
      setCameraStatus("เกิดข้อผิดพลาด", "error");

      await Swal.fire({
        icon: 'error',
        title: res.title || 'เกิดข้อผิดพลาด',
        text: res.detail || res.error || 'ไม่สามารถประมวลผลได้',
        confirmButtonText: 'ตกลง',
        allowOutsideClick: false
      });

      searchInput.value = '';
    } catch (err) {
      console.error(err);
      if (reqId !== currentRequestId) return;

      playErrorSound();
      setCameraStatus("เชื่อมต่อไม่สำเร็จ", "error");

      await Swal.fire({
        icon: 'error',
        title: 'เชื่อมต่อไม่สำเร็จ',
        text: String(err?.message || err),
        confirmButtonText: 'ตกลง',
        allowOutsideClick: false
      });
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
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("timeout เรียก Apps Script"));
      }, API_TIMEOUT_MS);

      window[cbName] = (data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
      };

      function cleanup() {
        try {
          delete window[cbName];
        } catch (_) {
          window[cbName] = undefined;
        }

        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
      }

      script.src = url;
      script.async = true;
      document.body.appendChild(script);
    });
  }

  async function gasJsonpWithRetry(params, retries = 1) {
    try {
      return await gasJsonp(params);
    } catch (err) {
      const msg = String(err?.message || err || "");
      const retriable =
        /timeout/i.test(msg) ||
        /network\/script error/i.test(msg);

      if (!retriable || retries <= 0) throw err;

      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return gasJsonpWithRetry(params, retries - 1);
    }
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

  setCameraStatus("กล้องปิดอยู่", "idle");

  // focus initial
  searchInput.focus();

  // แนะนำ iOS เรื่อง Add to Home Screen เพื่อให้เปิดกล้องเสถียรกว่าเดิม
  if (isIOS_() && isInAppBrowser_()) {
    setCameraStatus("แนะนำเปิดผ่าน Safari", "warning");
  }
});


