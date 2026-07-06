// ---------- Barcode scanning (log-food modal) ----------
// Decodes a barcode via the device camera (webcam on desktop, rear camera on mobile)
// using the vendored html5-qrcode library, then feeds the digits into the exact same
// search path manual typing already uses — no separate barcode endpoint exists upstream,
// scanning is purely a client-side input method.

let html5Qrcode = null; // the active Html5Qrcode instance, or null when not scanning

const SCAN_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128
];

function setScanStatus(text) {
  $('#scan-status').textContent = text;
  $('#scan-status').classList.remove('hidden');
  $('#scan-error').classList.add('hidden');
}
function setScanError(text) {
  $('#scan-error').textContent = text;
  $('#scan-error').classList.remove('hidden');
  $('#scan-status').classList.add('hidden');
}

async function openScanModal() {
  $('#scan-modal').classList.remove('hidden');
  $('#scan-error').classList.add('hidden');
  $('#scan-camera-select').classList.add('hidden');
  $('#scan-camera-select').innerHTML = '';
  setScanStatus('Requesting camera access…');

  if (!navigator.mediaDevices) {
    setScanError('Camera scanning requires a secure connection (HTTPS). Type the barcode digits manually instead.');
    return;
  }

  let cameras = [];
  try {
    cameras = await Html5Qrcode.getCameras();
  } catch (err) {
    handleScanError(err);
    return;
  }

  if (!cameras || !cameras.length) {
    setScanError('No camera was found on this device. Type the barcode digits manually instead.');
    return;
  }

  if (cameras.length > 1) {
    const select = $('#scan-camera-select');
    const backCamera = cameras.find((cam) => /back|rear|environment/i.test(cam.label || ''));
    for (const cam of cameras) {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = cam.label || cam.id;
      select.appendChild(opt);
    }
    select.value = (backCamera || cameras[0]).id;
    select.classList.remove('hidden');
  }

  // Always prefer the rear/environment-facing camera by default — getCameras()'s
  // enumeration order isn't guaranteed to put the back camera first, so picking
  // cameras[0] on multi-camera devices (i.e. most phones) can land on the front
  // camera. facingMode is the reliable way to ask for "the back one" up front;
  // the dropdown (when shown) is just a manual override from there.
  await startScan({ facingMode: 'environment' });
}

$('#scan-camera-select').addEventListener('change', async (e) => {
  await stopScan();
  await startScan(e.target.value);
});

let scanStartedAt = 0;

async function startScan(cameraIdOrConstraints) {
  try {
    html5Qrcode = new Html5Qrcode('scan-reader');
    scanStartedAt = Date.now();
    await html5Qrcode.start(
      cameraIdOrConstraints,
      { fps: 10, qrbox: { width: 250, height: 150 }, formatsToSupport: SCAN_FORMATS },
      onScanSuccess,
      onScanFrameFailure
    );
    setScanStatus('Point the camera at a barcode…');
  } catch (err) {
    handleScanError(err);
  }
}

function onScanFrameFailure() {
  // Fires continuously for every frame where nothing was decoded — not an error state.
  if (scanStartedAt && Date.now() - scanStartedAt > 20000) {
    setScanStatus('Still looking… make sure the barcode is well-lit and in focus.');
    scanStartedAt = 0; // only nudge once
  }
}

async function onScanSuccess(decodedText) {
  await stopScan();
  closeScanModal();
  $('#search-input').value = decodedText;
  runNutritionSearch(decodedText);
}

function handleScanError(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || err || '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission/i.test(msg)) {
    setScanError('Camera access was denied. Allow camera access in your browser settings, or type the barcode digits manually below.');
  } else if (name === 'NotFoundError' || /not\s*found/i.test(msg)) {
    setScanError('No camera was found on this device. Type the barcode digits manually instead.');
  } else if (name === 'NotReadableError' || name === 'TrackStartError' || /in use/i.test(msg)) {
    setScanError("Couldn't access the camera (it may be in use by another app). Type the barcode digits manually instead.");
  } else {
    setScanError('Could not start the camera. Type the barcode digits manually instead.');
  }
  stopScan();
}

async function stopScan() {
  if (!html5Qrcode) return;
  const instance = html5Qrcode;
  html5Qrcode = null;
  try { await instance.stop(); } catch { /* not currently scanning */ }
  try { instance.clear(); } catch { /* nothing to clear */ }
}

function closeScanModal() {
  $('#scan-modal').classList.add('hidden');
  stopScan();
}

$('#scan-barcode-btn').addEventListener('click', openScanModal);
$('#scan-modal-close').addEventListener('click', closeScanModal);
$('#scan-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeScanModal();
});
$('#scan-use-manual').addEventListener('click', () => {
  closeScanModal();
  $('#search-input').focus();
});
