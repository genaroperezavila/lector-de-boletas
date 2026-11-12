// GastosPro · by Genaro_Perez
// Lectura de boletas chilenas: timbre electrónico (TED) y texto OCR.

export const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// ---------------- RUT ----------------
export function rutDV(num) {
  let s = 0, m = 2;
  for (let i = String(num).length - 1; i >= 0; i--) { s += Number(String(num)[i]) * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (s % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}
export function cleanRut(s) {
  const m = String(s || '').replace(/[.\s]/g, '').toUpperCase().match(/^(\d{6,9})-?([\dK])$/);
  return m ? `${m[1]}-${m[2]}` : null;
}
export const validRut = (s) => { const r = cleanRut(s); return !!r && rutDV(r.split('-')[0]) === r.split('-')[1]; };
export function fmtRut(s) {
  const r = cleanRut(s); if (!r) return s || '';
  const [n, d] = r.split('-');
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + d;
}

// ---------------- Timbre electrónico (PDF417 del SII) ----------------
const TIPOS = { 33: 'Factura', 34: 'Factura exenta', 39: 'Boleta', 41: 'Boleta exenta', 46: 'Factura de compra', 52: 'Guía de despacho', 56: 'Nota de débito', 61: 'Nota de crédito', 110: 'Factura de exportación' };
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : ''; };
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

/** Devuelve los datos del timbre o null si el texto no es un TED. */
export function parseTED(text) {
  if (!text || !/<TED[\s>]/.test(text)) return null;
  const dd = tag(text, 'DD') || text;
  const caf = tag(dd, 'CAF');
  const td = Number(tag(dd, 'TD'));
  const mnt = Number(tag(dd, 'MNT'));
  const fe = tag(dd, 'FE');
  if (!fe || !Number.isFinite(mnt)) return null;
  return {
    rut: cleanRut(tag(dd, 'RE')) || tag(dd, 'RE'),
    tipo: td, tipoNombre: TIPOS[td] || `DTE ${td}`,
    folio: tag(dd, 'F'),
    fecha: fe.slice(0, 10),
    monto: mnt,
    razonSocial: unesc(tag(tag(caf, 'DA') || caf, 'RS')),
    item: unesc(tag(dd, 'IT1')),
    receptor: unesc(tag(dd, 'RSR')),
    hora: (tag(dd, 'TSTED').split('T')[1] || '').slice(0, 5),
  };
}

// ---------------- Texto OCR ----------------
const MESES = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12 };
const pad = (n) => String(n).padStart(2, '0');
function isoDate(d, m, y) {
  y = Number(y); if (y < 100) y += 2000;
  d = Number(d); m = Number(m);
  if (!(y >= 2015 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function findDate(text, today = new Date()) {
  const t = norm(text);
  const cands = [];
  for (const m of t.matchAll(/\b(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})\b/g)) { const d = isoDate(m[1], m[2], m[3]); if (d) cands.push({ d, i: m.index, near: /FECHA|EMISION/.test(t.slice(Math.max(0, m.index - 25), m.index)) }); }
  for (const m of t.matchAll(/\b(20\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})\b/g)) { const d = isoDate(m[3], m[2], m[1]); if (d) cands.push({ d, i: m.index, near: /FECHA/.test(t.slice(Math.max(0, m.index - 25), m.index)) }); }
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:DE\s+)?(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEPT?|SET|OCT|NOV|DIC)[A-Z]*\.?\s*(?:DE(?:L)?\s+)?(\d{2,4})\b/g)) { const d = isoDate(m[1], MESES[m[2].slice(0, 3)], m[3]); if (d) cands.push({ d, i: m.index, near: true }); }
  const limit = new Date(today.getTime() + 2 * 864e5).toISOString().slice(0, 10);
  const ok = cands.filter((c) => c.d <= limit);
  ok.sort((a, b) => (b.near - a.near) || (a.i - b.i));
  return ok[0] ? ok[0].d : null;
}

// Montos chilenos: $ 56.947 · 56.947 · $56947 · 56,947 (algunas impresoras)
function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(/\$?\s*(\d{1,3}(?:[.,]\d{3})+|\d{3,7})(?![\d.,]*\d)/g)) {
    const v = Number(m[1].replace(/[.,]/g, ''));
    if (v >= 100 && v < 50000000) out.push(v);
  }
  return out;
}
export function findTotal(text) {
  const lines = norm(text).split(/\n/);
  let best = null;
  lines.forEach((l, i) => {
    if (/\bTOTAL\b|MONTO\s+(A\s+)?PAGAR|TOTAL\s+A\s+PAGAR|A\s+PAGAR/.test(l) && !/SUB\s*-?\s*TOTAL|TOTAL\s+(IVA|NETO|EXENTO|DESC|ITEM|ART)|IVA\b|PROPINA\s+SUG/.test(l)) {
      const a = amountsIn(l).concat(amountsIn(lines[i + 1] || ''));
      if (a.length) { const v = Math.max(...a); const score = (/A\s+PAGAR|TOTAL\s*\$/.test(l) ? 2 : 1); if (!best || score > best.score || (score === best.score && v > best.v)) best = { v, score }; }
    }
  });
  if (best) return best.v;
  const all = lines.flatMap(amountsIn);
  return all.length ? Math.max(...all) : null;
}
export function findRut(text) {
  for (const m of norm(text).matchAll(/(\d{1,2}[.,\s]?\d{3}[.,\s]?\d{3})\s*-\s*([\dK])/g)) {
    const r = cleanRut(m[1].replace(/[.,\s]/g, '') + '-' + m[2]);
    if (r && validRut(r) && !/^6{7,8}-6$/.test(r)) return r;
  }
  return null;
}
export function findFolio(text) {
  const m = norm(text).match(/(?:FOLIO|BOLETA[^\n\d]{0,25}|FACTURA[^\n\d]{0,25}|\bN[°ºOE*]\.?)\s*:?\s*(\d{3,10})/);
  return m ? m[1] : null;
}
export function findTipo(text) {
  const t = norm(text);
  if (/FACTURA\s+ELECTRONICA|\bFACTURA\b/.test(t)) return 33;
  if (/BOLETA/.test(t)) return 39;
  return null;
}
/** Nombre del comercio: primera línea "con letras" del encabezado que no sea basura. */
export function findMerchant(text) {
  const lines = (text || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines.slice(0, 8)) {
    const n = norm(l);
    if (n.replace(/[^A-Z]/g, '').length < 4) continue;
    if (/^(RUT|R\.U\.T|GIRO|DIRECCION|FONO|TEL|BOLETA|FACTURA|FECHA|CASA MATRIZ|SUCURSAL|S\.I\.I|WWW|HTTP)/.test(n)) continue;
    return l.replace(/\s{2,}/g, ' ');
  }
  return '';
}

/** Interpreta el texto OCR completo de una boleta. */
export function parseReceiptText(text, comunas = []) {
  return {
    fecha: findDate(text),
    monto: findTotal(text),
    rut: findRut(text),
    folio: findFolio(text),
    tipo: findTipo(text),
    razonSocial: findMerchant(text),
    ciudad: findComuna(text, comunas),
  };
}

export function findComuna(text, comunas) {
  if (!comunas || !comunas.length) return null;
  const t = ' ' + norm(text).replace(/[^A-Z0-9]+/g, ' ') + ' ';
  let best = null;
  for (const c of comunas) {
    const n = ' ' + norm(c.name).replace(/[^A-Z0-9]+/g, ' ') + ' ';
    if (n.trim().length < 4) continue;
    const i = t.indexOf(n);
    if (i >= 0 && (!best || n.length > best.n.length)) best = { name: c.name, n };
  }
  return best ? best.name : null;
}

/** Comuna más cercana a una coordenada GPS (centroides de las 345 comunas). */
export function nearestComuna(lat, lng, comunas) {
  let best = null, bd = Infinity;
  for (const c of comunas) {
    const dx = (c.lng - lng) * Math.cos((lat * Math.PI) / 180), dy = c.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = c; }
  }
  return best && Math.sqrt(bd) * 111 < 60 ? best.name : null;   // a menos de ~60 km
}
