// GastosPro · by Genaro_Perez
// Procesa la foto: la achica para guardarla, busca el timbre electrónico (PDF417) y, si no está, usa OCR.
import { parseTED, parseReceiptText } from './parse.js';

const MAX_STORE = 1600;     // px del lado mayor de la foto guardada
const THUMB = 220;

async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    const img = new Image(); img.src = url; await img.decode(); URL.revokeObjectURL(url);
    return img;
  }
}
function drawScaled(src, maxSide) {
  const w = src.width, h = src.height, k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

/** Prepara foto para guardar (≈200-400 KB) y miniatura. */
export async function preparePhoto(file) {
  const bmp = await loadBitmap(file);
  const big = drawScaled(bmp, MAX_STORE);
  const photo = await toBlob(big, 0.8);
  const thumb = await toBlob(drawScaled(big, THUMB), 0.7);
  return { bmp, photo, thumb, width: big.width, height: big.height };
}

// ---------------- timbre electrónico ----------------
let zxingReady = null;
function zxing() {
  if (!zxingReady) {
    zxingReady = (async () => {
      if (!window.ZXingWASM) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'lib/zxing/zxing-reader.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      ZXingWASM.prepareZXingModule({ overrides: { locateFile: (p) => (p.endsWith('.wasm') ? new URL('lib/zxing/zxing_reader.wasm', location.href).href : p) }, fireImmediately: true });
      return ZXingWASM;
    })();
  }
  return zxingReady;
}

function rotated(src, deg) {
  const r = (deg * Math.PI) / 180, cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * cos + src.height * sin); c.height = Math.round(src.width * sin + src.height * cos);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(r); ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Busca y decodifica el timbre. Devuelve { ted, raw } o null. */
export async function readTimbre(bmp, onStep = () => {}) {
  // 1) Detector nativo de Android (rápido y tolera fotos torcidas)
  try {
    if ('BarcodeDetector' in window) {
      const fmts = await BarcodeDetector.getSupportedFormats();
      if (fmts.includes('pdf417')) {
        const det = new BarcodeDetector({ formats: ['pdf417'] });
        for (const src of [bmp, drawScaled(bmp, 2200)]) {
          const codes = await det.detect(src);
          for (const c of codes) { const ted = parseTED(c.rawValue); if (ted) return { ted, raw: c.rawValue, via: 'nativo' }; }
        }
      }
    }
  } catch (e) { console.warn('BarcodeDetector', e); }
  // 2) ZXing (WebAssembly), probando ángulos por si la foto quedó torcida
  try {
    const Z = await zxing();
    const base = drawScaled(bmp, 1800);
    const angles = [0, 2, -2, 4, -4, 6, -6, 8, -8, 11, -11, 90, -90];
    for (const a of angles) {
      onStep(a);
      const c = a ? rotated(base, a) : base;
      const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
      const res = await Z.readBarcodes(data, { formats: ['PDF417'], tryHarder: true, tryRotate: false, maxNumberOfSymbols: 1 });
      for (const r of res) { const ted = parseTED(r.text); if (ted) return { ted, raw: r.text, via: 'zxing' }; }
    }
  } catch (e) { console.warn('ZXing', e); }
  return null;
}

// ---------------- OCR ----------------
let ocrWorker = null;
async function getOcr() {
  if (!ocrWorker) {
    if (!window.Tesseract) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'lib/tesseract.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    ocrWorker = Tesseract.createWorker('spa', 1, {
      workerPath: new URL('lib/worker.min.js', location.href).href,
      corePath: new URL('lib/tesseract-core/', location.href).href,
      langPath: new URL('lib/lang', location.href).href,
      gzip: true, cacheMethod: 'none', workerBlobURL: false,
    });
  }
  return ocrWorker;
}
export function warmOcr() { getOcr().catch(() => {}); }

function ocrCanvas(bmp) {
  // gris + contraste: los tickets térmicos suelen salir pálidos
  const c = drawScaled(bmp, 1500);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 16) { const v = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; if (v < min) min = v; if (v > max) max = v; }
  const span = Math.max(40, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const v = ((0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) - min) * (255 / span);
    d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v));
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function readText(bmp, comunas) {
  const w = await getOcr();
  const { data } = await w.recognize(ocrCanvas(bmp));
  return { text: data.text, ...parseReceiptText(data.text, comunas) };
}
