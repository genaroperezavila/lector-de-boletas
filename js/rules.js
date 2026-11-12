// GastosPro · by Genaro_Perez
// Clasificación automática del gasto y texto "DETALLE" con el estilo de la planilla Rheintek.
import { norm } from './parse.js';

export const CATEGORIAS = ['COMBUSTIBLE', 'ALIMENTACION', 'ALOJAMIENTO', 'MATERIALES', 'PEAJE', 'ESTACIONAMIENTO',
  'PASAJE AEREO', 'TRANSPORTE', 'SUPERMERCADO', 'OTROS'];

// Marca → [nombre corto, categoría]. Orden importa: lo más específico primero.
const BRANDS = [
  [/\bPRONTO\b/, 'PRONTO', 'ALIMENTACION'], [/\bUPA!?\b|\bUPITA\b/, 'UPA', 'ALIMENTACION'], [/SPACIO ?1/, 'SPACIO1', 'ALIMENTACION'],
  [/\bCOPEC\b|PETROLEOS DE CHILE/, 'COPEC', 'COMBUSTIBLE'], [/\bSHELL\b|\bENEX\b|EMPRESA NACIONAL DE ENERGIA/, 'SHELL', 'COMBUSTIBLE'],
  [/\bARAMCO\b|\bESMAX\b/, 'ARAMCO', 'COMBUSTIBLE'], [/PETROBRAS/, 'PETROBRAS', 'COMBUSTIBLE'], [/\bTERPEL\b/, 'TERPEL', 'COMBUSTIBLE'],
  [/SODIMAC|HOMECENTER/, 'SODIMAC', 'MATERIALES'], [/\bEASY\b|CENCOSUD RETAIL.*EASY/, 'EASY', 'MATERIALES'], [/CONSTRUMART/, 'CONSTRUMART', 'MATERIALES'],
  [/\bIMPERIAL\b/, 'IMPERIAL', 'MATERIALES'], [/CHILEMAT/, 'CHILEMAT', 'MATERIALES'], [/FERRETER/, null, 'MATERIALES'], [/\bMTS\b/, 'MTS', 'MATERIALES'],
  [/RODAMIENTO|ELECTRIC|ELECTRO|INDUSTRIAL|HIDRAULIC|PERNO|SOLDADUR/, null, 'MATERIALES'],
  [/\bIBIS\b/, 'IBIS', 'ALOJAMIENTO'], [/NOVOTEL/, 'NOVOTEL', 'ALOJAMIENTO'], [/HOLIDAY INN/, 'HOLIDAY INN', 'ALOJAMIENTO'],
  [/\bHOTEL\b|\bHOSTAL\b|HOSPEDAJE|CABANA|APART|\bLODGE\b|AIRBNB|\bMOTEL\b/, null, 'ALOJAMIENTO'],
  [/\bLATAM\b/, 'LATAM', 'PASAJE AEREO'], [/SKY AIRLINE|\bSKY\b/, 'SKY', 'PASAJE AEREO'], [/JETSMART|JET SMART/, 'JETSMART', 'PASAJE AEREO'],
  [/\bJUMBO\b/, 'JUMBO', 'SUPERMERCADO'], [/TOTTUS/, 'TOTTUS', 'SUPERMERCADO'], [/\bLIDER\b|WALMART/, 'LIDER', 'SUPERMERCADO'],
  [/UNIMARC/, 'UNIMARC', 'SUPERMERCADO'], [/SANTA ISABEL/, 'SANTA ISABEL', 'SUPERMERCADO'], [/ACUENTA/, 'ACUENTA', 'SUPERMERCADO'],
  [/ESTACIONAMIENTO|PARKING|\bSABA\b|PARQUIMETRO/, null, 'ESTACIONAMIENTO'],
  [/AUTOPISTA|COSTANERA|VESPUCIO|RUTA DEL MAIPO|MAIPO PONIENTE|\bACSA\b|PEAJE|\bTAG\b|AUTOVIA|CONCESION/, null, 'PEAJE'],
  [/\bUBER\b/, 'UBER', 'TRANSPORTE'], [/CABIFY/, 'CABIFY', 'TRANSPORTE'], [/\bDIDI\b/, 'DIDI', 'TRANSPORTE'], [/\bTAXI\b|RADIOTAXI|TRANSFER/, null, 'TRANSPORTE'],
  [/TUR ?BUS|PULLMAN|BUSES/, null, 'TRANSPORTE'],
  [/RESTAURA|\bCAFE\b|CAFETERIA|PARRILLA|SUSHI|PIZZ|MCDONALD|BURGER|DOGGIS|JUAN MAESTRO|FUENTE DE SODA|PANADERIA|PASTELERIA|EMPANADA|COMIDA|CASINO|\bBAR\b|SANGUCH|CHURRASC/, null, 'ALIMENTACION'],
];
const FUEL_ITEM = /DIESEL|PETROLEO|GASOLINA|BENCINA|\bG ?9[357]\b|\b9[357] ?OCT|KEROSEN|COMBUSTIBLE|\bLTS?\b|LITROS/;

const LEGAL = /\b(RESTAURANT(E)?|SOC\.?|S\.?\s?A\.?|SPA|S\.?P\.?A\.?|LTDA\.?|LIMITADA|E\.?I\.?R\.?L\.?|Y\s+CIA\.?|Y\s+COMPANIA|SOCIEDAD|COMERCIAL(IZADORA)?|INVERSIONES|EMPRESA(S)?|CHILE|DE\s+CHILE|S\s+A)\b/g;

export function shortName(razonSocial) {
  const n = norm(razonSocial);
  for (const [re, name] of BRANDS) if (name && re.test(n)) return name;
  const s = n.replace(LEGAL, ' ').replace(/[^A-Z0-9&! ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').slice(0, 4).join(' ') || n.slice(0, 30);
}

export function guessCategory({ razonSocial = '', comercio = '', item = '', texto = '' }) {
  const n = norm([razonSocial, comercio].join(' '));
  const it = norm(item);
  if (FUEL_ITEM.test(it)) return 'COMBUSTIBLE';
  for (const [re, , cat] of BRANDS) if (re.test(n)) {
    // una boleta "COPEC" que no es combustible (ej. café de la tienda) es alimentación
    if (cat === 'COMBUSTIBLE' && it && !FUEL_ITEM.test(it)) return 'ALIMENTACION';
    return cat;
  }
  const t = norm(texto);
  if (FUEL_ITEM.test(t)) return 'COMBUSTIBLE';
  for (const [re, , cat] of BRANDS) if (re.test(t)) return cat;
  return null;
}

/** Texto para la columna DETALLE: "COMBUSTIBLE COPEC LAS CONDES" */
export function buildDetalle(g) {
  const parts = [g.categoria, g.comercio, g.ciudad].map((x) => norm(x || '').trim()).filter(Boolean);
  // evita repetir la ciudad si ya viene en el nombre del comercio
  if (parts.length === 3 && parts[1].endsWith(parts[2])) parts.pop();
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** Separa un DETALLE histórico en categoría y resto (para aprender del Excel importado). */
export function splitDetalle(detalle) {
  const n = norm(detalle).trim();
  for (const c of CATEGORIAS) if (n.startsWith(c + ' ')) return { categoria: c, resto: n.slice(c.length + 1) };
  return { categoria: guessCategory({ comercio: n }) , resto: n };
}

// -------- aprendizaje: lo que el usuario corrige se recuerda por RUT y por comercio --------
export const ruleKeys = (g) => [g.rut ? 'RUT:' + g.rut : null, g.comercio ? 'COM:' + shortName(g.comercio) : null].filter(Boolean);

export function applyRules(g, rules) {
  for (const k of ruleKeys(g)) {
    const r = rules[k];
    if (r) {
      return {
        ...g,
        categoria: g.categoriaFija ? g.categoria : (r.categoria || g.categoria),
        comercio: r.comercio || g.comercio,
        ciudad: g.ciudad || r.ciudad || '',
        _regla: k,
      };
    }
  }
  return g;
}
