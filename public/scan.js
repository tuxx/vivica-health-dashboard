// ---------- Barcode scanning (log-food modal) ----------
// Decodes a barcode via the device camera (webcam on desktop, rear camera on mobile)
// using the vendored html5-qrcode library, then feeds the digits into the exact same
// search path manual typing already uses — no separate barcode endpoint exists upstream,
// scanning is purely a client-side input method.

let html5Qrcode = null; // the active Html5Qrcode instance, or null when not scanning

// Every open/close/camera-switch operation runs through this chain so they can never
// overlap. Without it, closing the modal (which stops the camera without waiting) and
// then quickly reopening it could let a fresh startScan() begin while the old stop was
// still mid-flight — forceReleaseCameraTracks() would then find the *new* stream (the
// old one's video element already gone) and kill it, making the camera look like it
// never opens.
let scanOpChain = Promise.resolve();
function runExclusive(fn) {
  scanOpChain = scanOpChain.then(fn, fn);
  return scanOpChain;
}

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
  // Defensive: if a previous attempt left a camera stream open (e.g. it errored out
  // before reaching stopScan()), release it first — a still-held track can make the
  // getUserMedia() call inside getCameras() below fail outright with no usable camera
  // list at all, which looks like "no dropdown + generic failure" from the outside.
  await stopScan();

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
    await handleScanError(err);
    return;
  }

  if (!cameras || !cameras.length) {
    setScanError('No camera was found on this device. Type the barcode digits manually instead.');
    return;
  }

  const backCamera = cameras.find((cam) => /back|rear|environment/i.test(cam.label || ''));

  if (cameras.length > 1) {
    const select = $('#scan-camera-select');
    for (const cam of cameras) {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = cam.label || cam.id;
      select.appendChild(opt);
    }
    select.value = (backCamera || cameras[0]).id;
    select.classList.remove('hidden');
  }

  // getCameras() briefly opens its own probe stream (to read device labels) and
  // stops it right before returning. On some Chrome/Android camera stacks the
  // hardware hasn't finished releasing that stream yet, so starting a real one
  // immediately afterward throws AbortError ("Starting videoinput failed") —
  // a short breather here avoids hitting that race in the common case.
  await delay(350);

  // Start by deviceId rather than a bare {facingMode: 'environment'} constraint —
  // on some Android/Chrome camera stacks (notably phones with multiple rear lenses)
  // a facingMode-only constraint throws OverconstrainedError/fails outright, while
  // starting a specific deviceId (same as picking one from the dropdown) works
  // reliably. Guess the rear camera from its label; fall back to the first camera
  // if nothing matches (single-camera devices, or generic/unlabeled cameras).
  await startScan((backCamera || cameras[0]).id);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

$('#scan-camera-select').addEventListener('change', (e) => {
  const cameraId = e.target.value;
  runExclusive(async () => {
    await stopScan();
    await startScan(cameraId);
  });
});

let scanStartedAt = 0;

// How many times to retry an AbortError before giving up and telling the user. One
// retry wasn't always enough in practice — some phones' camera hardware takes longer
// than a single ~500ms breather to actually release a just-closed stream, so this
// backs off further on each attempt (500ms, 1000ms, 1500ms) before surfacing an error.
const MAX_START_ATTEMPTS = 4;

async function startScan(cameraIdOrConstraints, attempt = 1) {
  try {
    // Explicitly request the browser's native BarcodeDetector when available (Chrome/
    // Android — it's the same OS-level ML-based scanner real barcode/camera apps use,
    // and is far faster and more forgiving of angle/distance than the JS fallback
    // decoder this library uses when it's unavailable, e.g. on iOS Safari).
    html5Qrcode = new Html5Qrcode('scan-reader', {
      useBarCodeDetectorIfSupported: true,
      formatsToSupport: SCAN_FORMATS,
      verbose: false
    });
    scanStartedAt = Date.now();
    await html5Qrcode.start(
      cameraIdOrConstraints,
      {
        fps: 15,
        // No qrbox — scan the full frame instead of a small cropped region. The library
        // requires the whole barcode to fall within the qrbox to detect it, so a small
        // box meant the paper had to be positioned precisely (and close, since the box
        // stays a fixed size regardless of distance). Scanning the entire frame matches
        // how native scanner apps behave: the barcode can be anywhere in view.
        formatsToSupport: SCAN_FORMATS,
        // Passing videoConstraints makes the library use ONLY these constraints for
        // getUserMedia (it ignores the deviceId passed as the first argument above in
        // that case) — so the deviceId has to be repeated in here to keep the back-camera
        // selection working. Requesting a higher resolution gives the decoder more detail
        // to work with at a normal distance; focusMode: 'continuous' (best-effort, ignored
        // by browsers/devices that don't support it) asks for continuous autofocus instead
        // of whatever fixed/far-biased focus behavior was making close-up scans blurry.
        videoConstraints: {
          deviceId: { exact: cameraIdOrConstraints },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: 'continuous' }]
        }
      },
      onScanSuccess,
      onScanFrameFailure
    );
    setScanStatus('Point the camera at a barcode…');
  } catch (err) {
    // When start() fails partway through (e.g. this AbortError), html5-qrcode can have
    // already acquired the camera's MediaStream internally before the failure — but
    // since it never finished setting up, that stream is orphaned: its own stop()/
    // clear() can't reach it (the library never recorded it), so it isn't stopped by
    // anything the library exposes. forceReleaseCameraTracks() finds it directly via
    // the DOM instead and stops it, regardless of what the library thinks happened.
    forceReleaseCameraTracks();
    if (err && err.name === 'AbortError' && attempt < MAX_START_ATTEMPTS) {
      setScanStatus('Still preparing the camera…');
      await delay(500 * attempt);
      await startScan(cameraIdOrConstraints, attempt + 1);
      return;
    }
    await handleScanError(err);
  }
}

// Safety net independent of html5-qrcode's own bookkeeping: directly stop any live
// camera tracks still attached under the scan reader. Covers cases where the library's
// start()/stop() lifecycle leaves a stream running that it no longer has a handle to.
function forceReleaseCameraTracks() {
  document.querySelectorAll('#scan-reader video').forEach((video) => {
    const stream = video.srcObject;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((track) => track.stop());
    }
    video.srcObject = null;
  });
}

function onScanFrameFailure() {
  // Fires continuously for every frame where nothing was decoded — not an error state.
  if (scanStartedAt && Date.now() - scanStartedAt > 20000) {
    setScanStatus('Still looking… make sure the barcode is well-lit and in focus.');
    scanStartedAt = 0; // only nudge once
  }
}

async function onScanSuccess(decodedText) {
  await runExclusive(stopScan);
  closeScanModal();
  $('#search-input').value = decodedText;
  runNutritionSearch(decodedText);
}

async function handleScanError(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || err || '');
  let text;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission/i.test(msg)) {
    text = 'Camera access was denied. Allow camera access in your browser settings, or type the barcode digits manually below.';
  } else if (name === 'NotFoundError' || /not\s*found/i.test(msg)) {
    text = 'No camera was found on this device. Type the barcode digits manually instead.';
  } else if (name === 'NotReadableError' || name === 'TrackStartError' || /in use/i.test(msg)) {
    text = "Couldn't access the camera (it may be in use by another app). Type the barcode digits manually instead.";
  } else {
    text = 'Could not start the camera. Type the barcode digits manually instead.';
  }
  // Always append the raw error so it's visible on-device without remote debugging —
  // the categorized message above can be wrong (browsers don't always set err.name).
  setScanError(`${text} (${name || 'Error'}: ${msg})`);
  // Awaited (not fire-and-forget) so callers running inside the runExclusive queue
  // (see top of file) don't return before this cleanup actually finishes.
  await stopScan();
}

async function stopScan() {
  if (html5Qrcode) {
    const instance = html5Qrcode;
    html5Qrcode = null;
    try { await instance.stop(); } catch { /* not currently scanning */ }
    try { instance.clear(); } catch { /* nothing to clear */ }
  }
  // Always run, even when there was no tracked instance — catches streams orphaned
  // by a failed start() (see the comment in startScan's catch block).
  forceReleaseCameraTracks();
}

function closeScanModal() {
  $('#scan-modal').classList.add('hidden');
  runExclusive(stopScan);
}

$('#scan-barcode-btn').addEventListener('click', () => runExclusive(openScanModal));
$('#scan-modal-close').addEventListener('click', closeScanModal);
$('#scan-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeScanModal();
});
$('#scan-use-manual').addEventListener('click', () => {
  closeScanModal();
  $('#search-input').focus();
});
