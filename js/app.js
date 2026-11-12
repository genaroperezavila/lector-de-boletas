// GastosPro · by Genaro_Perez
// App de boletas y rendiciones: foto → timbre/OCR → gasto → planilla Excel de la empresa.
import * as DB from './db.js';
import { preparePhoto, readTimbre, readText, warmOcr } from './scan.js';
import { CATEGORIAS, shortName, guessCategory, buildDetalle, splitDetalle, ruleKeys, applyRules } from './rules.js';
import { nearestComuna, fmtRut, norm } from './parse.js';
import { buildPlanilla, readPlanilla } from './xlsx.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = '$') => (cur === '$' ? '$ ' : cur + ' ') + Math.round(Number(n) || 0).toLocaleString('es-CL');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const fmtDay = (iso) => { if (!iso) return 'Sin fecha'; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };
const plural = (n, a, b) => `${n.toLocaleString('es-CL')} ${n === 1 ? a : b}`;

const DEFAULT_CFG = {
  nombre: '', codigo: '',
  lineas: ['FMFO', 'PET', 'AGRI', 'PERU', 'Administracion'],
  formas: [{ label: 'Tarjeta empresa', valor: 'CREDITO' }, { label: 'VISA', valor: 'VISA' }, { label: 'Efectivo / propio', valor: '' }],
  categorias: CATEGORIAS,
  retencionDias: 60, usarGPS: true,
  lastLinea: null, lastForma: null,
};

const S = { cfg: null, rends: [], cur: null, gastos: [], rules: {}, comercios: [], comunas: [], template: null, urls: [] };

// =====================================================================
// utilidades de interfaz
// =====================================================================
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function busy(text) { $('#busy').hidden = !text; if (text) $('#busyText').textContent = text; }
function show(view) {
  for (const v of ['vHome', 'vEdit', 'vRend', 'vSet']) $('#' + v).hidden = v !== view;
  $('#dock').hidden = view !== 'vHome';
  // botón "atrás" de Android: cierra la hoja abierta en vez de salir de la app
  if (view !== 'vHome' && !S.pushed) { history.pushState({ sheet: true }, ''); S.pushed = true; }
  if (view === 'vHome') {
    if (S.pushed) { S.pushed = false; S.ignorePop = true; history.back(); }
    window.scrollTo(0, S.homeScroll || 0);
  }
}
function ask(html, buttons) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    $('#dlgBody').innerHTML = html + `<div class="dlg-actions">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    $('#dlgBody').querySelectorAll('[data-i]').forEach((x) => x.onclick = () => { d.close(); resolve(buttons[x.dataset.i].value); });
    d.onclose = () => resolve(undefined);
    d.showModal();
  });
}
const blobUrl = (b) => { const u = URL.createObjectURL(b); S.urls.push(u); return u; };
function freeUrls() { S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls = []; }
function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
async function shareOrDownload(files, title) {
  const fs = files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }));
  try { if (navigator.canShare && navigator.canShare({ files: fs })) { await navigator.share({ files: fs, title }); return 'shared'; } }
  catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  for (const f of files) downloadBlob(f.blob, f.name);
  return 'downloaded';
}
const formaLabel = (v) => (S.cfg.formas.find((f) => f.valor === v) || { label: v || 'Propio' }).label;

// =====================================================================
// datos
// =====================================================================
async function loadAll() {
  S.cfg = { ...DEFAULT_CFG, ...(await DB.kvGet('cfg', {})) };
  S.rules = await DB.kvGet('rules', {});
  S.comercios = await DB.kvGet('comercios', []);
  S.template = await DB.kvGet('template', null);
  S.rends = (await DB.all('rends')).sort((a, b) => b.createdAt - a.createdAt);
  if (!S.rends.length) S.rends = [await newRend()];
  const curId = await DB.kvGet('curRend', null);
  S.cur = S.rends.find((r) => r.id === curId) || S.rends.find((r) => r.estado === 'abierta') || S.rends[0];
  await loadGastos();
}
async function loadGastos() { S.gastos = (await DB.byIndex('gastos', 'rendId', S.cur.id)).sort(sortGastos); }
const sortGastos = (a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.createdAt - b.createdAt;
const saveCfg = () => DB.kvSet('cfg', S.cfg);

async function newRend(extra = {}) {
  const d = new Date();
  const r = { id: DB.uid(), nombre: 'Rendición ' + d.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' }), gpa: '', proposito: '', ccosto: '', fechaInforme: '', estado: 'abierta', createdAt: Date.now(), ...extra };
  await DB.put('rends', r);
  return r;
}
async function setCurrent(r) { S.cur = r; await DB.kvSet('curRend', r.id); await loadGastos(); renderHome(); }

// =====================================================================
// pantalla principal
// =====================================================================
async function renderHome() {
  freeUrls();
  const r = S.cur, gs = S.gastos;
  $('#rpName').textContent = r.gpa ? `GPA ${r.gpa}` : r.nombre;
  $('#rpSub').textContent = `${plural(gs.length, 'gasto', 'gastos')} · ${r.estado === 'exportada' ? 'enviada' : 'abierta'}${r.gpa ? ' · ' + r.nombre : ''}`;
  const tot = gs.filter((g) => (g.moneda || '$') === '$').reduce((a, g) => a + (Number(g.monto) || 0), 0);
  $('#barTotal').textContent = money(tot);

  // avisos
  const ban = [];
  if (!S.template) ban.push(`<div class="banner"><b>Falta tu planilla de rendición.</b> Cárgala una vez en Ajustes para poder exportar el Excel de la empresa.<br><button class="btn ghost" id="goSet">Ir a Ajustes</button></div>`);
  if (S.storageWarn) ban.push(`<div class="banner">${S.storageWarn}</div>`);
  $('#banner').innerHTML = ban.join('');
  $('#goSet') && ($('#goSet').onclick = openSettings);

  const el = $('#list');
  if (!gs.length) {
    el.innerHTML = `<div class="empty"><h2>Sin gastos en esta rendición</h2>
      <p>Toca <b>Boleta</b> para fotografiar una. El programa lee el timbre electrónico o el texto, y tú solo confirmas la categoría y la línea.</p></div>`;
    return;
  }
  const photos = new Map();
  await Promise.all(gs.filter((g) => g.photoId).map(async (g) => { const p = await DB.get('photos', g.photoId); if (p && p.thumb) photos.set(g.id, blobUrl(p.thumb)); }));
  const days = new Map();
  for (const g of [...gs].reverse()) { const k = g.fecha || ''; if (!days.has(k)) days.set(k, []); days.get(k).push(g); }
  el.innerHTML = [...days].map(([day, list]) => `
    <div class="day"><span>${esc(fmtDay(day))}</span><span>${money(list.reduce((a, g) => a + ((g.moneda || '$') === '$' ? Number(g.monto) || 0 : 0), 0))}</span></div>
    ${list.map((g) => `<button class="g" data-id="${g.id}">
      <span class="th" ${photos.get(g.id) ? `style="background-image:url('${photos.get(g.id)}')"` : ''}>${photos.get(g.id) ? '' : (g.photoId ? 'foto<br>borrada' : 'sin<br>foto')}</span>
      <span><span class="det">${esc(g.detalle)}</span>
        <span class="sub"><span>${esc(g.linea || '—')}</span><span>${esc(formaLabel(g.forma))}</span><span class="stamp ${g.origen}">${{ timbre: 'TIMBRE', ocr: 'OCR', manual: 'MANUAL', planilla: 'PLANILLA' }[g.origen] || ''}</span></span></span>
      <span class="amt">${money(g.monto, g.moneda)}</span></button>`).join('')}`).join('');
  el.querySelectorAll('.g').forEach((b) => b.onclick = () => openEdit(S.gastos.find((g) => g.id === b.dataset.id)));
}

// =====================================================================
// captura
// =====================================================================
const queue = [];
$('#btnCam').onclick = () => { warmOcr(); $('#inCam').click(); };
$('#btnGal').onclick = () => { warmOcr(); $('#inGal').click(); };
$('#btnManual').onclick = () => openEdit(draft({ origen: 'manual' }));
$('#inCam').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; enqueue(f, true); };
$('#inGal').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; enqueue(f, false); };

function enqueue(files, fromCamera) { for (const f of files) queue.push({ f, fromCamera }); if (!S.editing) nextInQueue(); }
async function nextInQueue() {
  const item = queue.shift();
  if (!item) return;
  try { await processPhoto(item.f, item.fromCamera); }
  catch (e) { busy(null); console.error(e); toast('No se pudo leer la foto: ' + e.message, 5000); nextInQueue(); }
}

function draft(extra = {}) {
  return {
    id: DB.uid(), rendId: S.cur.id, fecha: today(), monto: '', moneda: '$', comercio: '', ciudad: '', categoria: null,
    linea: S.cfg.lastLinea || S.cfg.lineas[0] || '', forma: S.cfg.lastForma ?? (S.cfg.formas[0] ? S.cfg.formas[0].valor : ''),
    detalle: '', detalleManual: false, nota: '', origen: 'manual', createdAt: Date.now(), ...extra, _new: true,
  };
}

function getPosition() {
  if (!S.cfg.usarGPS || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) => {
    const t = setTimeout(() => res(null), 9000);
    navigator.geolocation.getCurrentPosition((p) => { clearTimeout(t); res(p.coords); }, () => { clearTimeout(t); res(null); }, { enableHighAccuracy: false, maximumAge: 600000, timeout: 8500 });
  });
}

async function processPhoto(file, fromCamera) {
  busy('Preparando foto…');
  const posP = fromCamera ? getPosition() : Promise.resolve(null);
  const ph = await preparePhoto(file);
  const g = draft({ origen: 'manual' });
  g._photo = ph.photo; g._thumb = ph.thumb;

  busy('Buscando el timbre electrónico…');
  const tim = await readTimbre(ph.bmp);
  let ocrInfo = null;
  if (tim) {
    const t = tim.ted;
    Object.assign(g, { origen: 'timbre', fecha: t.fecha, monto: t.monto, rut: t.rut, folio: t.folio, tipo: t.tipo, razonSocial: t.razonSocial, item: t.item });
    g.comercio = shortName(t.razonSocial) || '';
    g.categoria = guessCategory({ razonSocial: t.razonSocial, item: t.item });
  } else {
    busy('Leyendo el texto de la boleta (OCR)…');
    ocrInfo = await readText(ph.bmp, S.comunas);
    Object.assign(g, { origen: 'ocr', fecha: ocrInfo.fecha || g.fecha, monto: ocrInfo.monto || '', rut: ocrInfo.rut, folio: ocrInfo.folio, tipo: ocrInfo.tipo, razonSocial: ocrInfo.razonSocial });
    g.comercio = ocrInfo.razonSocial ? shortName(ocrInfo.razonSocial) : '';
    g.categoria = guessCategory({ razonSocial: ocrInfo.razonSocial, texto: ocrInfo.text });
    g.ciudad = ocrInfo.ciudad || '';
    g._ocrText = ocrInfo.text;
  }
  // lo que el usuario corrigió antes para este RUT / comercio
  Object.assign(g, applyRules(g, S.rules));
  // ciudad por GPS (solo si la boleta es de hoy: la foto se tomó donde ocurrió el gasto)
  const pos = await posP;
  if (pos && g.fecha === today()) { g.lat = pos.latitude; g.lng = pos.longitude; const c = nearestComuna(pos.latitude, pos.longitude, S.comunas); if (c && !g.ciudad) g.ciudad = c; }
  busy(null);
  openEdit(g);
  // con timbre y sin ciudad: leer el texto en segundo plano para encontrar la comuna
  if (tim && !g.ciudad) {
    readText(ph.bmp, S.comunas).then((o) => {
      if (S.editing !== g || $('#fCiudad').value) return;
      if (o.ciudad) { $('#fCiudad').value = o.ciudad; g.ciudad = o.ciudad; refreshDetalle(); }
    }).catch(() => {});
  }
}

// =====================================================================
// formulario
// =====================================================================
function chips(el, items, current, onPick, addLabel) {
  el.innerHTML = items.map((it, i) => `<button type="button" class="chip" data-i="${i}" aria-pressed="${it.value === current}">${esc(it.label)}</button>`).join('') +
    (addLabel ? `<button type="button" class="chip add" data-add="1">${addLabel}</button>` : '');
  el.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { el.querySelectorAll('[data-i]').forEach((x) => x.setAttribute('aria-pressed', x === b)); onPick(items[b.dataset.i].value); });
  const add = el.querySelector('[data-add]');
  if (add) add.onclick = async () => {
    const v = prompt('Nombre nuevo:'); if (!v || !v.trim()) return;
    onPick(v.trim(), true);
  };
}

function refreshDetalle() {
  const g = S.editing; if (!g || g.detalleManual) return;
  g.comercio = $('#fComercio').value; g.ciudad = $('#fCiudad').value;
  $('#fDetalle').value = buildDetalle(g);
}

async function openEdit(g) {
  S.homeScroll = window.scrollY;
  S.editing = g;
  const isNew = !!g._new;
  $('#eTitle').textContent = isNew ? (g.origen === 'manual' && !g._photo ? 'Gasto sin boleta' : 'Nueva boleta') : 'Editar gasto';
  // foto
  let photoBlob = g._photo || null;
  if (!photoBlob && g.photoId) { const p = await DB.get('photos', g.photoId); photoBlob = p && (p.blob || p.thumb); }
  $('#ePhotoBox').hidden = !photoBlob;
  if (photoBlob) { $('#ePhoto').src = blobUrl(photoBlob); $('#ePhoto').onclick = () => window.open($('#ePhoto').src, '_blank'); }
  const st = { timbre: '<span class="stamp timbre">TIMBRE</span> Datos leídos del timbre electrónico', ocr: '<span class="stamp ocr">OCR</span> Leído del texto: revisa monto y fecha', manual: '', planilla: '<span class="stamp planilla">PLANILLA</span> Importado del Excel' };
  $('#eStatus').innerHTML = isNew ? st[g.origen] || '' : (st[g.origen] || '');
  // campos
  $('#fMonto').value = g.monto ? Math.round(g.monto).toLocaleString('es-CL') : '';
  $('#fMoneda').value = g.moneda || '$';
  $('#fFecha').value = g.fecha || today();
  $('#fCiudad').value = g.ciudad || '';
  $('#fComercio').value = g.comercio || '';
  $('#fNota').value = g.nota || '';
  $('#fDetalle').value = g.detalle || buildDetalle(g);
  const cats = [...new Set([...S.cfg.categorias, ...(g.categoria ? [g.categoria] : [])])];
  const pickCat = (v, isNewItem) => { g.categoria = v; if (isNewItem) { S.cfg.categorias.push(norm(v)); saveCfg(); g.categoria = norm(v); renderChips(); } refreshDetalle(); };
  const pickLinea = (v, isNewItem) => { g.linea = v; if (isNewItem) { S.cfg.lineas.push(v); saveCfg(); renderChips(); } };
  const pickForma = (v) => { g.forma = v; };
  function renderChips() {
    chips($('#cCat'), [...new Set([...S.cfg.categorias, ...(g.categoria ? [g.categoria] : [])])].map((c) => ({ label: c.charAt(0) + c.slice(1).toLowerCase(), value: c })), g.categoria, pickCat, '+ otra');
    chips($('#cLinea'), S.cfg.lineas.map((l) => ({ label: l, value: l })), g.linea, pickLinea, '+ otra');
    chips($('#cForma'), S.cfg.formas.map((f) => ({ label: f.label, value: f.valor })), g.forma, pickForma);
  }
  void cats; renderChips();
  const meta = [];
  if (g.tipo) meta.push({ 33: 'Factura', 34: 'Factura exenta', 39: 'Boleta', 41: 'Boleta exenta' }[g.tipo] || 'DTE ' + g.tipo);
  if (g.folio) meta.push('N° ' + g.folio);
  if (g.rut) meta.push('RUT ' + fmtRut(g.rut));
  if (g.razonSocial) meta.push(g.razonSocial);
  $('#eMeta').textContent = meta.join(' · ');
  $('#eDanger').innerHTML = isNew ? '' : `<button class="btn danger block" id="eDel">Eliminar gasto</button>
    ${S.rends.length > 1 ? `<label><span>Mover a otra rendición</span><select id="eMove">${S.rends.map((r) => `<option value="${r.id}" ${r.id === g.rendId ? 'selected' : ''}>${esc(r.gpa ? 'GPA ' + r.gpa + ' · ' : '')}${esc(r.nombre)}</option>`).join('')}</select></label>` : ''}`;
  if (!isNew) {
    $('#eDel').onclick = async () => {
      if (await ask('<h3>¿Eliminar este gasto?</h3><p>También se borra su foto.</p>', [{ label: 'Cancelar', cls: 'ghost' }, { label: 'Eliminar', cls: 'danger', value: true }])) {
        await DB.del('gastos', g.id); if (g.photoId) await DB.del('photos', g.photoId);
        await closeEdit(); toast('Gasto eliminado');
      }
    };
  }
  show('vEdit');
  $('#vEdit').scrollTop = 0;
}

$('#fComercio').oninput = refreshDetalle;
$('#fCiudad').oninput = refreshDetalle;
$('#fDetalle').oninput = () => { if (S.editing) S.editing.detalleManual = true; $('#detHint').textContent = 'Detalle escrito a mano. Bórralo completo para que vuelva a armarse solo.'; if (!$('#fDetalle').value.trim()) { S.editing.detalleManual = false; refreshDetalle(); } };
$('#fMonto').oninput = (e) => { const d = e.target.value.replace(/\D/g, ''); e.target.value = d ? Number(d).toLocaleString('es-CL') : ''; };
$('#eCancel').onclick = async () => { S.editing = null; await closeEdit(); };

async function closeEdit() {
  S.editing = null;
  await loadGastos(); await renderHome(); show('vHome');
  if (queue.length) setTimeout(nextInQueue, 150);
}

$('#eSave').onclick = async () => {
  const g = S.editing; if (!g) return;
  const monto = Number($('#fMonto').value.replace(/\D/g, ''));
  if (!monto) { toast('Falta el monto.'); $('#fMonto').focus(); return; }
  if (!$('#fFecha').value) { toast('Falta la fecha.'); return; }
  Object.assign(g, {
    monto, moneda: $('#fMoneda').value, fecha: $('#fFecha').value, ciudad: $('#fCiudad').value.trim(),
    comercio: $('#fComercio').value.trim(), nota: $('#fNota').value.trim(),
  });
  if (!g.categoria) { toast('Elige una categoría.'); return; }
  g.detalle = (g.detalleManual ? $('#fDetalle').value : buildDetalle(g)).toUpperCase().trim();
  const mv = $('#eMove'); if (mv && mv.value !== g.rendId) g.rendId = mv.value;

  // ¿duplicado?
  if (g._new) {
    const allG = await DB.all('gastos');
    const dup = allG.find((x) => (g.rut && g.folio && x.rut === g.rut && x.folio === g.folio) || (x.rendId === g.rendId && x.fecha === g.fecha && Number(x.monto) === monto && norm(x.comercio) === norm(g.comercio)));
    if (dup && !(await ask(`<h3>Esta boleta parece repetida</h3><p>Ya existe: ${esc(dup.detalle)}, ${money(dup.monto)} del ${esc(fmtDay(dup.fecha))}.</p>`, [{ label: 'No guardar', cls: 'ghost' }, { label: 'Guardar igual', value: true }]))) return;
  }
  // foto
  if (g._photo) { g.photoId = g.photoId || DB.uid(); await DB.put('photos', { id: g.photoId, blob: g._photo, thumb: g._thumb, createdAt: Date.now() }); }
  const rec = { ...g }; for (const k of Object.keys(rec)) if (k.startsWith('_')) delete rec[k];
  await DB.put('gastos', rec);
  // aprender
  const rule = { categoria: g.categoria, comercio: g.comercio };
  for (const k of ruleKeys(g)) S.rules[k] = rule;
  await DB.kvSet('rules', S.rules);
  if (g.comercio && !S.comercios.includes(g.comercio)) { S.comercios.push(g.comercio); await DB.kvSet('comercios', S.comercios); fillDatalists(); }
  S.cfg.lastLinea = g.linea; S.cfg.lastForma = g.forma; await saveCfg();
  if (S.cur.estado === 'exportada' && g._new) toast('Ojo: esta rendición ya se había exportado. Vuelve a exportarla para incluir este gasto.', 5000);
  else toast(g._new ? `Guardado: ${money(monto, g.moneda)}` : 'Cambios guardados');
  await closeEdit();
};

// =====================================================================
// rendiciones
// =====================================================================
$('#rendPick').onclick = () => openRend();
$('#rBack').onclick = async () => { await renderHome(); show('vHome'); };

async function openRend() {
  S.homeScroll = window.scrollY;
  const r = S.cur, gs = S.gastos;
  const sum = (key) => { const m = new Map(); for (const g of gs) { const k = key(g); m.set(k, (m.get(k) || 0) + (Number(g.monto) || 0)); } return [...m].sort((a, b) => b[1] - a[1]); };
  const pesos = gs.filter((g) => (g.moneda || '$') === '$');
  const total = pesos.reduce((a, g) => a + Number(g.monto || 0), 0);
  const propio = pesos.filter((g) => !g.forma).reduce((a, g) => a + Number(g.monto || 0), 0);
  const conFoto = gs.filter((g) => g.photoId).length;
  $('#rBody').innerHTML = `
    <div class="card">
      <h3>${esc(r.nombre)} <span class="pill ${r.estado}">${r.estado === 'exportada' ? 'enviada ' + new Date(r.exportedAt).toLocaleDateString('es-CL') : 'abierta'}</span></h3>
      <div class="big">${money(total)}</div>
      <p class="hint">${plural(gs.length, 'gasto', 'gastos')} · ${plural(conFoto, 'con foto', 'con foto')}${propio ? ` · saldo a tu favor ${money(propio)}` : ''}</p>
      <button class="btn block" id="rExport">Exportar planilla Excel + fotos</button>
      ${r.estado === 'exportada' ? '<button class="btn ghost block" id="rReopen">Reabrir para seguir agregando</button>' : ''}
    </div>
    <div class="card"><h3>Datos de la planilla</h3>
      <label><span>Nombre de la rendición (solo para ti)</span><input id="rNombre" value="${esc(r.nombre)}"></label>
      <div class="grid2"><label><span>N° GPA</span><input id="rGpa" value="${esc(r.gpa)}" placeholder="3/26"></label>
      <label><span>Fecha del informe</span><input id="rFecha" type="date" value="${esc(r.fechaInforme || today())}"></label></div>
      <label><span>Destino del viaje / propósito del gasto</span><input id="rProp" value="${esc(r.proposito)}"></label>
      <label><span>C. costo / línea</span><input id="rCc" value="${esc(r.ccosto || [...new Set(gs.map((g) => g.linea).filter(Boolean))].join(','))}"></label>
    </div>
    <div class="card"><h3>Por línea</h3>${sum((g) => g.linea || '—').map(([k, v]) => `<div class="sumrow"><span>${esc(k)}</span><b>${money(v)}</b></div>`).join('') || '<p class="hint">Sin gastos</p>'}</div>
    <div class="card"><h3>Por categoría</h3>${sum((g) => g.categoria || '—').map(([k, v]) => `<div class="sumrow"><span>${esc(k)}</span><b>${money(v)}</b></div>`).join('') || '<p class="hint">Sin gastos</p>'}</div>
    <div class="card"><h3>Por forma de pago</h3>${sum((g) => formaLabel(g.forma)).map(([k, v]) => `<div class="sumrow"><span>${esc(k)}</span><b>${money(v)}</b></div>`).join('') || '<p class="hint">Sin gastos</p>'}</div>
    <div class="card"><h3>Todas las rendiciones</h3><div class="rlist">${S.rends.map((x) => `<button data-r="${x.id}" aria-current="${x.id === r.id}"><span>${esc(x.gpa ? 'GPA ' + x.gpa + ' · ' : '')}${esc(x.nombre)}</span><span class="pill ${x.estado}">${x.estado === 'exportada' ? 'enviada' : 'abierta'}</span></button>`).join('')}</div>
      <button class="btn ghost block" id="rNew">Nueva rendición</button>
      ${S.rends.length > 1 ? '<button class="btn danger block" id="rDel">Eliminar esta rendición</button>' : ''}</div>`;
  const saveHeader = async () => {
    Object.assign(r, { nombre: $('#rNombre').value.trim() || r.nombre, gpa: $('#rGpa').value.trim(), fechaInforme: $('#rFecha').value, proposito: $('#rProp').value.trim(), ccosto: $('#rCc').value.trim() });
    await DB.put('rends', r);
  };
  ['#rNombre', '#rGpa', '#rFecha', '#rProp', '#rCc'].forEach((s) => $(s).onchange = saveHeader);
  $('#rExport').onclick = async () => { await saveHeader(); exportRend(r); };
  $('#rReopen') && ($('#rReopen').onclick = async () => { r.estado = 'abierta'; await DB.put('rends', r); openRend(); });
  $('#rNew').onclick = async () => { await saveHeader(); const n = await newRend(); S.rends.unshift(n); await setCurrent(n); openRend(); toast('Nueva rendición creada'); };
  $('#rDel') && ($('#rDel').onclick = async () => {
    if (!(await ask(`<h3>¿Eliminar «${esc(r.nombre)}»?</h3><p>Se borran sus ${plural(gs.length, 'gasto', 'gastos')} y sus fotos. No se puede deshacer.</p>`, [{ label: 'Cancelar', cls: 'ghost' }, { label: 'Eliminar todo', cls: 'danger', value: true }]))) return;
    for (const g of gs) { await DB.del('gastos', g.id); if (g.photoId) await DB.del('photos', g.photoId); }
    await DB.del('rends', r.id); S.rends = S.rends.filter((x) => x.id !== r.id);
    await setCurrent(S.rends[0]); openRend();
  });
  $('#rBody').querySelectorAll('[data-r]').forEach((b) => b.onclick = async () => { await saveHeader(); await setCurrent(S.rends.find((x) => x.id === b.dataset.r)); openRend(); });
  show('vRend');
  $('#vRend').scrollTop = 0;
}

const slug = (s) => norm(s).replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

async function exportRend(r) {
  if (!S.template) { toast('Primero carga tu planilla en Ajustes.'); return openSettings(); }
  const gs = [...S.gastos].sort(sortGastos);
  if (!gs.length) { toast('No hay gastos para exportar.'); return; }
  busy('Armando la planilla…');
  try {
    const header = { nombre: S.cfg.nombre || undefined, codigo: S.cfg.codigo || undefined, gpa: r.gpa, fechaInforme: r.fechaInforme || today(), proposito: r.proposito, ccosto: r.ccosto };
    const xlsx = await buildPlanilla(JSZip, S.template.data, header, gs.map((g) => ({ fecha: g.fecha, detalle: g.detalle, linea: g.linea, moneda: g.moneda || '$', monto: g.monto, forma: g.forma })));
    const base = `Rendicion${r.gpa ? '_GPA_' + r.gpa.replace(/[^\w]+/g, '-') : ''}_${slug(S.cfg.nombre || 'gastos')}_${today()}`;
    const files = [{ blob: new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: base + '.xlsx' }];
    // fotos numeradas con la fila de la planilla
    const zip = new JSZip(); let n = 0;
    const start = S.template.layout?.dataStart || 14;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]; if (!g.photoId) continue;
      const p = await DB.get('photos', g.photoId); if (!p || !p.blob) continue;
      zip.file(`F${String(start + i).padStart(3, '0')}_${g.fecha}_${slug(g.detalle)}_${Math.round(g.monto)}.jpg`, p.blob); n++;
    }
    if (n) files.push({ blob: await zip.generateAsync({ type: 'blob' }), name: base + '_fotos.zip' });
    busy(null);
    const res = await shareOrDownload(files, 'Rendición ' + (r.gpa || r.nombre));
    if (res === 'cancel') return;
    r.estado = 'exportada'; r.exportedAt = Date.now(); await DB.put('rends', r);
    toast(`Planilla con ${plural(gs.length, 'gasto', 'gastos')}${n ? ` y ${plural(n, 'foto', 'fotos')}` : ''} lista.`, 4500);
    openRend();
  } catch (e) { busy(null); console.error(e); toast('Error al exportar: ' + e.message, 6000); }
}

// =====================================================================
// ajustes
// =====================================================================
$('#btnMenu').onclick = () => openSettings();
$('#sBack').onclick = async () => { await renderHome(); show('vHome'); };

async function openSettings() {
  S.homeScroll = window.scrollY;
  const c = S.cfg;
  const st = await DB.storageInfo();
  $('#sBody').innerHTML = `
    <div class="card"><h3>Tus datos</h3>
      <label><span>Nombre (como va en la planilla)</span><input id="sNombre" value="${esc(c.nombre)}"></label>
      <label><span>Código de empleado</span><input id="sCodigo" value="${esc(c.codigo)}"></label></div>
    <div class="card"><h3>Planilla de rendición</h3>
      ${S.template ? `<p class="hint">Usando <b>${esc(S.template.name)}</b>: gastos desde la fila ${S.template.layout.dataStart}. El programa agrega o quita filas según los gastos y corrige las fórmulas.</p>` : '<p class="warn">Aún no cargas la planilla de la empresa.</p>'}
      <button class="btn block" id="sTpl">${S.template ? 'Cambiar planilla' : 'Cargar planilla (.xlsx)'}</button>
      <input type="file" id="sTplIn" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></div>
    <div class="card"><h3>Líneas / centros de costo</h3>
      <label><span>Separadas por coma</span><input id="sLineas" value="${esc(c.lineas.join(', '))}"></label></div>
    <div class="card"><h3>Formas de pago</h3>
      <p class="hint">Una por línea: <b>Nombre = valor en la columna FORMA PAGO</b>. Sin valor = lo pagaste tú (saldo a tu favor).</p>
      <textarea id="sFormas" rows="4" style="width:100%;border:1px solid var(--rule);border-radius:8px;padding:.6rem;font:inherit">${esc(c.formas.map((f) => `${f.label} = ${f.valor}`).join('\n'))}</textarea></div>
    <div class="card"><h3>Fotos y espacio</h3>
      <label><span>Borrar fotos de rendiciones enviadas después de (días)</span><input id="sRet" type="number" min="7" value="${c.retencionDias}"></label>
      <label class="switch" style="display:flex;gap:.6rem;align-items:center"><input type="checkbox" id="sGps" style="width:auto;min-height:0" ${c.usarGPS ? 'checked' : ''}> Usar la ubicación del teléfono para la ciudad</label>
      <p class="hint">Espacio usado: ${(st.usage / 1048576).toFixed(1)} MB${st.persisted ? ' · almacenamiento protegido' : ' · <span class="warn">Android podría borrar los datos si falta espacio: haz respaldos.</span>'}</p></div>
    <div class="card"><h3>Respaldo</h3>
      <p class="hint">Todo vive en este teléfono. Guarda un respaldo en Drive o en el PC de vez en cuando.</p>
      <button class="btn block" id="sBackup">Crear respaldo (.zip)</button>
      <button class="btn ghost block" id="sRestore">Restaurar desde respaldo</button>
      <input type="file" id="sRestoreIn" accept=".zip" hidden></div>
    <p class="hint" style="text-align:center;margin-top:1.4rem">GastosPro 2.0 · by Genaro_Perez</p>`;
  const save = async () => {
    c.nombre = $('#sNombre').value.trim(); c.codigo = $('#sCodigo').value.trim();
    c.lineas = $('#sLineas').value.split(',').map((x) => x.trim()).filter(Boolean);
    c.formas = $('#sFormas').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [a, ...b] = l.split('='); return { label: a.trim(), valor: b.join('=').trim().toUpperCase() }; });
    c.retencionDias = Math.max(7, Number($('#sRet').value) || 60); c.usarGPS = $('#sGps').checked;
    await saveCfg();
  };
  $('#sBody').querySelectorAll('input:not([type=file]),textarea').forEach((x) => x.onchange = save);
  $('#sTpl').onclick = () => $('#sTplIn').click();
  $('#sTplIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importTemplate(f); };
  $('#sBackup').onclick = backup;
  $('#sRestore').onclick = () => $('#sRestoreIn').click();
  $('#sRestoreIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); };
  show('vSet');
  $('#vSet').scrollTop = 0;
}

async function importTemplate(file) {
  busy('Revisando la planilla…');
  try {
    const data = await file.arrayBuffer();
    const info = await readPlanilla(JSZip, data);
    S.template = { name: file.name, data, layout: info.layout, savedAt: Date.now() };
    await DB.kvSet('template', S.template);
    if (info.header.nombre && !S.cfg.nombre) S.cfg.nombre = String(info.header.nombre);
    if (info.header.codigo && !S.cfg.codigo) S.cfg.codigo = String(info.header.codigo);
    if (info.lineas.length) S.cfg.lineas = [...new Set([...info.lineas, ...S.cfg.lineas])];
    // formas de pago usadas en la planilla
    for (const v of new Set(info.gastos.map((g) => g.forma))) if (!S.cfg.formas.some((f) => f.valor === v)) S.cfg.formas.push({ label: v || 'Propio', valor: v });
    // aprender categorías y comercios del historial
    let learned = 0;
    for (const g of info.gastos) {
      const { categoria, resto } = splitDetalle(g.detalle);
      if (!categoria || !resto) continue;
      const com = shortName(resto);
      if (!S.rules['COM:' + com]) { S.rules['COM:' + com] = { categoria, comercio: com }; learned++; }
      if (!S.comercios.includes(com)) S.comercios.push(com);
    }
    await DB.kvSet('rules', S.rules); await DB.kvSet('comercios', S.comercios); await saveCfg(); fillDatalists();
    busy(null);
    const imp = info.gastos.length ? await ask(`<h3>Planilla cargada</h3><p>Formato reconocido: gastos desde la fila ${info.layout.dataStart}. Aprendí ${plural(learned, 'comercio', 'comercios')} de tu historial.</p>
      <p>Esta planilla trae <b>${plural(info.gastos.length, 'gasto', 'gastos')}</b> (${money(info.gastos.reduce((a, g) => a + g.monto, 0))}). ¿Quieres traerlos como una rendición para seguir agregando ahí?</p>`,
      [{ label: 'Solo usar el formato', cls: 'ghost' }, { label: 'Traer los gastos', value: true }]) : false;
    if (imp) {
      const r = await newRend({ nombre: 'Importada ' + (info.header.gpa ? 'GPA ' + info.header.gpa : file.name.replace(/\.xlsx$/i, '')), gpa: info.header.gpa || '', proposito: String(info.header.proposito || ''), ccosto: String(info.header.ccosto || ''), fechaInforme: info.header.fechaInforme || '' });
      for (const x of info.gastos) {
        const { categoria, resto } = splitDetalle(x.detalle);
        await DB.put('gastos', { id: DB.uid(), rendId: r.id, fecha: x.fecha, monto: x.monto, moneda: x.moneda || '$', comercio: shortName(resto || ''), ciudad: '', categoria: categoria || 'OTROS', linea: x.linea, forma: x.forma, detalle: x.detalle, detalleManual: true, nota: '', origen: 'planilla', createdAt: Date.now() + x.fila });
      }
      S.rends.unshift(r); await setCurrent(r);
      toast(`${plural(info.gastos.length, 'gasto importado', 'gastos importados')}`);
    }
    openSettings();
  } catch (e) { busy(null); console.error(e); toast('No pude leer la planilla: ' + e.message, 6000); }
}

async function backup() {
  busy('Creando respaldo…');
  const zip = new JSZip();
  const data = { version: 2, fecha: new Date().toISOString(), cfg: S.cfg, rules: S.rules, comercios: S.comercios, rends: await DB.all('rends'), gastos: await DB.all('gastos'), curRend: S.cur.id };
  if (S.template) { data.template = { name: S.template.name, layout: S.template.layout }; zip.file('plantilla.xlsx', S.template.data); }
  for (const p of await DB.all('photos')) { if (p.blob) zip.file(`fotos/${p.id}.jpg`, p.blob); if (p.thumb) zip.file(`fotos/${p.id}_min.jpg`, p.thumb); }
  zip.file('datos.json', JSON.stringify(data));
  const blob = await zip.generateAsync({ type: 'blob' });
  busy(null);
  await shareOrDownload([{ blob, name: `GastosPro_respaldo_${today()}.zip` }], 'Respaldo GastosPro');
  await DB.kvSet('lastBackup', Date.now());
}

async function restore(file) {
  if (!(await ask('<h3>¿Restaurar respaldo?</h3><p>Se agregan las rendiciones, gastos y fotos del respaldo. Lo que ya tienes no se borra; si un gasto existe en ambos, queda la versión del respaldo.</p>', [{ label: 'Cancelar', cls: 'ghost' }, { label: 'Restaurar', value: true }]))) return;
  busy('Restaurando…');
  try {
    const zip = await JSZip.loadAsync(file);
    const data = JSON.parse(await zip.file('datos.json').async('string'));
    for (const r of data.rends) await DB.put('rends', r);
    for (const g of data.gastos) await DB.put('gastos', g);
    const ids = new Set(Object.keys(zip.files).filter((n) => n.startsWith('fotos/')).map((n) => n.slice(6).replace(/(_min)?\.jpg$/, '')));
    for (const id of ids) {
      const big = zip.file(`fotos/${id}.jpg`), small = zip.file(`fotos/${id}_min.jpg`);
      await DB.put('photos', { id, blob: big ? await big.async('blob') : null, thumb: small ? await small.async('blob') : null, createdAt: Date.now() });
    }
    S.rules = { ...data.rules, ...S.rules }; await DB.kvSet('rules', S.rules);
    S.comercios = [...new Set([...(data.comercios || []), ...S.comercios])]; await DB.kvSet('comercios', S.comercios);
    if (!S.cfg.nombre && data.cfg) { S.cfg = { ...S.cfg, ...data.cfg }; await saveCfg(); }
    if (zip.file('plantilla.xlsx') && !S.template) { S.template = { ...data.template, data: await zip.file('plantilla.xlsx').async('arraybuffer'), savedAt: Date.now() }; await DB.kvSet('template', S.template); }
    await loadAll(); busy(null); fillDatalists(); await renderHome(); show('vHome');
    toast(`Respaldo restaurado: ${plural(data.gastos.length, 'gasto', 'gastos')}`);
  } catch (e) { busy(null); toast('No se pudo restaurar: ' + e.message, 6000); }
}

// =====================================================================
// limpieza de fotos (rendiciones ya enviadas)
// =====================================================================
async function cleanupPhotos() {
  const limit = Date.now() - S.cfg.retencionDias * 864e5;
  const sent = new Set((await DB.all('rends')).filter((r) => r.estado === 'exportada').map((r) => r.id));
  if (!sent.size) return;
  let n = 0;
  for (const g of await DB.all('gastos')) {
    if (!g.photoId || !sent.has(g.rendId) || g.createdAt > limit) continue;
    const p = await DB.get('photos', g.photoId);
    if (p && p.blob) { await DB.put('photos', { ...p, blob: null, deletedAt: Date.now() }); n++; }
  }
  if (n) toast(`Se borraron ${plural(n, 'foto', 'fotos')} de rendiciones enviadas hace más de ${S.cfg.retencionDias} días.`, 5000);
}

function fillDatalists() {
  $('#dlComunas').innerHTML = S.comunas.map((c) => `<option value="${esc(c.name)}">`).join('');
  $('#dlComercios').innerHTML = S.comercios.slice(-400).map((c) => `<option value="${esc(c)}">`).join('');
}

// =====================================================================
// inicio
// =====================================================================
(async function init() {
  try { S.comunas = await (await fetch('lib/comunas.json')).json(); } catch { S.comunas = []; }
  await loadAll();
  fillDatalists();
  await renderHome();
  show('vHome');
  cleanupPhotos().then(() => renderHome());
  const st = await DB.storageInfo();
  if (!st.persisted && S.gastos.length) {
    const ok = await DB.askPersist();
    if (!ok) S.storageWarn = 'Android no garantiza guardar los datos de esta app para siempre. Instálala en la pantalla de inicio y crea respaldos desde Ajustes.';
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('popstate', async () => {
    if (S.ignorePop) { S.ignorePop = false; return; }
    S.pushed = false;
    if (!$('#vEdit').hidden) { S.editing = null; await closeEdit(); }
    else if (!$('#vHome').hidden) return;
    else { await renderHome(); show('vHome'); }
  });
})();
