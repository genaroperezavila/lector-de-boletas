// GastosPro · by Genaro_Perez
// Llena la planilla de rendición de la empresa (formato Rheintek) editando el XML del .xlsx:
// conserva logo, estilos, bordes y fórmulas; agrega o quita filas de gastos y corrige los rangos.

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const xesc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => XML_ESC[c]);
const xunesc = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

export const colNum = (c) => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const toSerial = (iso) => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
export const fromSerial = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 864e5).toISOString().slice(0, 10);

// ---------------- lectura del libro ----------------
async function openBook(JSZip, data) {
  const zip = await JSZip.loadAsync(data);
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const firstSheet = wb.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  const target = rels.match(new RegExp(`Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${firstSheet[1]}"`));
  const sheetPath = 'xl/' + target[1].replace(/^\/?xl\//, '');
  const sheet = await zip.file(sheetPath).async('string');
  const ssXml = zip.file('xl/sharedStrings.xml') ? await zip.file('xl/sharedStrings.xml').async('string') : '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xunesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  return { zip, wb, rels, sheetPath, sheet, shared };
}

function splitSheet(sheet) {
  const a = sheet.indexOf('<sheetData>'), b = sheet.indexOf('</sheetData>');
  if (a < 0) throw new Error('La planilla no tiene datos (sheetData).');
  const body = sheet.slice(a + 11, b);
  const rows = [...body.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)].map((m) => ({ xml: m[0], r: Number(m[0].match(/\br="(\d+)"/)[1]) }));
  return { head: sheet.slice(0, a + 11), rows, tail: sheet.slice(b) };
}

const cellsOf = (rowXml) => [...rowXml.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => {
  const x = m[0];
  const ref = x.match(/\br="([A-Z]+)(\d+)"/);
  return { xml: x, col: ref[1], row: Number(ref[2]), s: (x.match(/\bs="(\d+)"/) || [])[1], t: (x.match(/\bt="(\w+)"/) || [])[1],
    v: (x.match(/<v>([\s\S]*?)<\/v>/) || [])[1], is: (x.match(/<is>([\s\S]*?)<\/is>/) || [])[1], f: x.match(/<f\b([^>]*)(?:\/>|>([\s\S]*?)<\/f>)/) };
});

function cellValue(c, shared) {
  if (!c) return null;
  if (c.t === 's') return shared[Number(c.v)] ?? '';
  if (c.t === 'inlineStr') return xunesc([...(c.is || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
  if (c.t === 'str') return xunesc(c.v || '');
  if (c.v == null) return null;
  return isNaN(Number(c.v)) ? xunesc(c.v) : Number(c.v);
}

/** Ubica las zonas del formato: encabezado de columnas, primera y última fila de gastos, fila IVA. */
function detectLayout(rows, shared) {
  const grid = new Map();
  for (const row of rows) for (const c of cellsOf(row.xml)) grid.set(c.col + c.row, c);
  const val = (ref) => { const v = cellValue(grid.get(ref), shared); return typeof v === 'string' ? v.trim().toUpperCase() : v; };
  let header = null;
  for (const row of rows) if (val('C' + row.r) === 'DETALLE' || val('B' + row.r) === 'FECHA' && val('C' + row.r) === 'DETALLE') { header = row.r; break; }
  if (!header) throw new Error('No encontré la fila de títulos (FECHA / DETALLE) en la planilla.');
  // la fila +2 es la fila "arrastre" (=+I13); los gastos parten en +3
  const dataStart = header + 3;
  let iva = null;
  for (const row of rows) if (row.r > dataStart && ['C', 'D', 'B'].some((c) => val(c + row.r) === 'IVA')) { iva = row.r; break; }
  if (!iva) throw new Error('No encontré la fila "IVA" que cierra la lista de gastos.');
  return { header, dataStart, dataEnd: iva - 1, iva, grid, val };
}

// ---------------- fórmulas ----------------
// Recorre las referencias de celda fuera de los textos entre comillas.
function mapRefs(formula, fn) {
  return formula.split(/("[^"]*")/).map((part, i) => i % 2 ? part
    : part.replace(/(^|[^A-Za-z0-9_.$!])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g,
      (m, pre, dc, col, dr, row) => pre + fn({ dc, col, dr, row: Number(row) }))).join('');
}
const shiftFormula = (f, mapRow) => mapRefs(f, (r) => `${r.dc}${r.col}${r.dr}${mapRow(r.row)}`);
// Traduce una fórmula compartida (t="shared") a la posición de otra celda.
const translateShared = (f, dRow, dCol) => mapRefs(f, (r) => `${r.dc}${r.dc ? r.col : colName(colNum(r.col) + dCol)}${r.dr}${r.dr ? r.row : r.row + dRow}`);

function setCell(rowXml, col, row, content) {
  // content: { num } | { str } | { formula } | null (vaciar)
  const re = new RegExp(`<c\\b[^>]*\\br="${col}${row}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const m = rowXml.match(re);
  const s = m ? (m[0].match(/\bs="(\d+)"/) || [])[1] : null;
  const sAttr = s ? ` s="${s}"` : '';
  let x;
  if (!content) x = `<c r="${col}${row}"${sAttr}/>`;
  else if (content.num != null) x = `<c r="${col}${row}"${sAttr}><v>${content.num}</v></c>`;
  else if (content.formula) x = `<c r="${col}${row}"${sAttr}><f>${xesc(content.formula)}</f></c>`;
  else x = `<c r="${col}${row}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xesc(content.str)}</t></is></c>`;
  if (m) return rowXml.replace(m[0], x);
  // insertar en orden de columna
  const cells = cellsOf(rowXml);
  const after = cells.filter((c) => colNum(c.col) < colNum(col)).pop();
  if (after) return rowXml.replace(after.xml, after.xml + x);
  return rowXml.replace(/(<row\b[^>]*>)/, `$1${x}`).replace(/<row\b([^>]*)\/>/, `<row$1>${x}</row>`);
}

// ---------------- API pública ----------------

/** Lee una planilla ya llenada: cabecera y lista de gastos. */
export async function readPlanilla(JSZip, data) {
  const b = await openBook(JSZip, data);
  const { rows } = splitSheet(b.sheet);
  const L = detectLayout(rows, b.shared);
  const v = (ref) => cellValue(L.grid.get(ref), b.shared);
  const gastos = [];
  for (let r = L.dataStart; r <= L.dataEnd; r++) {
    const fecha = v('B' + r), detalle = v('C' + r), monto = v('I' + r);
    if (!detalle && !monto) continue;
    gastos.push({
      fecha: typeof fecha === 'number' ? fromSerial(fecha) : String(fecha || ''),
      detalle: String(detalle || '').trim(),
      linea: String(v('G' + r) || '').trim(), moneda: String(v('H' + r) || '$').trim() || '$',
      monto: Number(monto) || 0, forma: String(v('J' + r) || '').trim(), fila: r,
    });
  }
  // líneas / centros de costo: lista bajo el título "Línea" del resumen
  const lineas = [];
  let start = null;
  for (let r = L.iva + 1; r <= L.iva + 20; r++) {
    const c = v('C' + r);
    if (start == null) { if (typeof c === 'string' && /^L[IÍ]NEA$/i.test(c.trim())) start = r; continue; }
    if (typeof c !== 'string' || !c.trim()) break;
    lineas.push(c.trim());
  }
  const header = {
    nombre: v('C6') || '', codigo: v('G6') || '', gpa: v('K3') != null ? String(v('K3')) : '',
    fechaInforme: typeof v('B8') === 'number' ? fromSerial(v('B8')) : '', proposito: v('C8') || '', ccosto: v('G8') || '',
  };
  return { header, gastos, lineas: [...new Set(lineas)], layout: { dataStart: L.dataStart, dataEnd: L.dataEnd, capacity: L.dataEnd - L.dataStart + 1 } };
}

/**
 * Genera la planilla de la empresa con los gastos.
 * @param data   ArrayBuffer del .xlsx plantilla (el del usuario)
 * @param header { nombre, codigo, gpa, fechaInforme, proposito, ccosto }
 * @param gastos [{ fecha:'YYYY-MM-DD', detalle, linea, moneda, monto, forma }]
 * @returns Uint8Array del nuevo .xlsx
 */
export async function buildPlanilla(JSZip, data, header, gastos, { minRows = 20, extraRows = 3 } = {}) {
  const b = await openBook(JSZip, data);
  const { head, rows, tail } = splitSheet(b.sheet);
  const L = detectLayout(rows, b.shared);
  const oldCount = L.dataEnd - L.dataStart + 1;
  const count = Math.max(gastos.length + extraRows, minRows);
  const delta = count - oldCount;
  const newEnd = L.dataStart + count - 1;
  const mapRow = (r) => (r < L.dataStart ? r : r <= L.dataEnd ? (r === L.dataEnd ? newEnd : Math.min(r, newEnd)) : r + delta);

  // fórmulas compartidas del original (para reescribir las que dependen de filas que se regeneran)
  const sharedF = {};
  for (const row of rows) for (const c of cellsOf(row.xml)) {
    if (c.f && /t="shared"/.test(c.f[1]) && c.f[2] != null) sharedF[c.f[1].match(/si="(\d+)"/)[1]] = { text: xunesc(c.f[2]), col: colNum(c.col), row: c.row };
  }
  const fixFormulaCell = (cellXml, col, row, newRow) => {
    const f = cellXml.match(/<f\b([^>]*)(?:\/>|>([\s\S]*?)<\/f>)/);
    if (!f) return cellXml.replace(`r="${col}${row}"`, `r="${col}${newRow}"`);
    let text = f[2] != null ? xunesc(f[2]) : null;
    if (/t="shared"/.test(f[1])) {
      const m = sharedF[f[1].match(/si="(\d+)"/)[1]];
      text = text != null ? text : m ? translateShared(m.text, row - m.row, colNum(col) - m.col) : '';
    }
    const ft = shiftFormula(text, mapRow);
    const s = (cellXml.match(/\bs="(\d+)"/) || [])[1];
    return `<c r="${col}${newRow}"${s ? ` s="${s}"` : ''}><f>${xesc(ft)}</f></c>`;
  };

  // estilos de la fila modelo (primera fila de gastos)
  const model = rows.find((r) => r.r === L.dataStart);
  const modelAttrs = (model.xml.match(/<row\b([^>]*)>/) || ['', ''])[1].replace(/\s*\br="\d+"/, '');
  const styles = {};
  for (const c of cellsOf(model.xml)) styles[c.col] = c.s;
  const order = Object.keys(styles).sort((a, b2) => colNum(a) - colNum(b2));
  const ensure = ['B', 'C', 'G', 'H', 'I', 'J', 'K', 'L'];
  for (const c of ensure) if (!order.includes(c)) order.push(c);
  order.sort((a, b2) => colNum(a) - colNum(b2));

  const sorted = [...gastos].sort((a, b2) => (a.fecha || '').localeCompare(b2.fecha || ''));
  const dataRows = [];
  for (let i = 0; i < count; i++) {
    const r = L.dataStart + i, g = sorted[i];
    const cell = (col, inner, t) => { const s = styles[col] ? ` s="${styles[col]}"` : ''; return inner == null ? `<c r="${col}${r}"${s}/>` : `<c r="${col}${r}"${s}${t ? ` t="${t}"` : ''}>${inner}</c>`; };
    const str = (v) => (v ? `<is><t xml:space="preserve">${xesc(v)}</t></is>` : null);
    const cells = order.map((col) => {
      if (!g) return col === 'L' ? cell('L', `<f>SUM(I${r}:K${r})</f>`) : cell(col, null);
      switch (col) {
        case 'B': return cell('B', g.fecha ? `<v>${toSerial(g.fecha)}</v>` : null);
        case 'C': return cell('C', str(g.detalle), g.detalle ? 'inlineStr' : null);
        case 'G': return cell('G', str(g.linea), g.linea ? 'inlineStr' : null);
        case 'H': return cell('H', str(g.moneda || '$'), 'inlineStr');
        case 'I': return cell('I', `<v>${Math.round(Number(g.monto) || 0)}</v>`);
        case 'J': return cell('J', str(g.forma), g.forma ? 'inlineStr' : null);
        case 'L': return cell('L', `<f>SUM(I${r}:K${r})</f>`);
        default: return cell(col, null);
      }
    });
    dataRows.push(`<row r="${r}"${modelAttrs ? ' ' + modelAttrs.trim() : ''}>${cells.join('')}</row>`);
  }

  // filas de cabecera (sin cambios de posición) con los datos de la rendición
  const out = [];
  for (const row of rows) {
    if (row.r >= L.dataStart) break;
    let x = row.xml;
    // fórmulas de cabecera que apunten a la zona de datos
    x = x.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (cx) => {
      const ref = cx.match(/\br="([A-Z]+)(\d+)"/);
      return /<f\b/.test(cx) ? fixFormulaCell(cx, ref[1], Number(ref[2]), Number(ref[2])) : cx;
    });
    const set = (ref, content) => { const m = ref.match(/([A-Z]+)(\d+)/); if (Number(m[2]) === row.r) x = setCell(x, m[1], row.r, content); };
    if (header) {
      if (header.nombre != null) set('C6', { str: header.nombre });
      if (header.codigo != null) set('G6', { str: header.codigo });
      if (header.gpa != null) set('K3', { str: header.gpa });
      if (header.fechaInforme) set('B8', { num: toSerial(header.fechaInforme) });
      if (header.proposito != null) set('C8', { str: header.proposito });
      if (header.ccosto != null) set('G8', { str: header.ccosto });
    }
    out.push(x);
  }
  out.push(...dataRows);
  // filas de resumen desplazadas
  for (const row of rows) {
    if (row.r <= L.dataEnd) continue;
    const nr = row.r + delta;
    let x = row.xml.replace(/^<row\b([^>]*?)\br="\d+"/, `<row$1r="${nr}"`);
    x = x.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (cx) => {
      const ref = cx.match(/\br="([A-Z]+)(\d+)"/);
      return fixFormulaCell(cx, ref[1], Number(ref[2]), nr);
    });
    out.push(x);
  }

  let body = head + out.join('') + tail;
  const lastRow = Math.max(...rows.map((r) => r.r)) + delta;
  body = body.replace(/<dimension ref="([A-Z]+)\d+:([A-Z]+)\d+"\/>/, `<dimension ref="$1${1}:$2${lastRow}"/>`);
  body = body.replace(/(<mergeCell ref=")([^"]+)(")/g, (m, a, ref, c) => a + ref.replace(/([A-Z]+)(\d+)/g, (mm, col, rr) => col + mapRow(Number(rr))) + c);
  body = body.replace(/(\bsqref=")([^"]+)(")/g, (m, a, ref, c) => a + ref.replace(/([A-Z]+)(\d+)/g, (mm, col, rr) => col + mapRow(Number(rr))) + c);
  body = body.replace(/<selection\b[^>]*\/>/, '<selection activeCell="B1" sqref="B1"/>');
  b.zip.file(b.sheetPath, body);

  // que Excel recalcule todo al abrir; la cadena de cálculo antigua ya no sirve
  let wb = b.wb;
  wb = /<calcPr\b/.test(wb) ? wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`) : wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  b.zip.file('xl/workbook.xml', wb);
  if (b.zip.file('xl/calcChain.xml')) {
    b.zip.remove('xl/calcChain.xml');
    b.zip.file('xl/_rels/workbook.xml.rels', b.rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, ''));
    const ct = await b.zip.file('[Content_Types].xml').async('string');
    b.zip.file('[Content_Types].xml', ct.replace(/<Override\b[^>]*calcChain[^>]*\/>/, ''));
  }
  return b.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
