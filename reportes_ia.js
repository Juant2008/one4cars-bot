/**
 * Reportes IA en lenguaje natural sobre juant200_venezon.
 * Genera SQL de solo lectura con DeepSeek, lo valida y luego redacta la respuesta.
 * Solo para administradores.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let poolRef = null;
const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const KEY_FILE = path.join(__dirname, 'deepseek_key.txt');
const LOG_FILE = path.join(__dirname, 'reportes_ia.log');

const TABLAS_PERMITIDAS = new Set([
  'tab_productos', 'tab_facturas', 'tab_facturas_reng', 'tab_clientes', 'tab_vendedores',
  'tab_pedidos', 'tab_pedidos_reng', 'tab_agenda_visitas', 'tab_visitas', 'tab_porcentaje',
  'bot_fit_producto', 'bot_oem_producto', 'bot_leads', 'historial_chat', 'control_chat',
  'bot_config', 'orden', 'orden_articulos'
]);

let esquemaCache = null;

function init(pool) { poolRef = pool; }

function leerKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (k) return k;
    }
  } catch (e) {}
  return (process.env.DEEPSEEK_API_KEY || '').trim();
}

async function cargarEsquema() {
  if (esquemaCache) return esquemaCache;
  const [rows] = await poolRef.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = 'juant200_venezon'
       AND TABLE_NAME IN (${[...TABLAS_PERMITIDAS].map(() => '?').join(',')})
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [...TABLAS_PERMITIDAS]
  );
  const porTabla = new Map();
  for (const r of rows) {
    if (!porTabla.has(r.TABLE_NAME)) porTabla.set(r.TABLE_NAME, []);
    porTabla.get(r.TABLE_NAME).push(`${r.COLUMN_NAME} ${r.COLUMN_TYPE}`);
  }
  esquemaCache = [...porTabla.entries()].map(([t, cols]) => `${t}:\n  ${cols.join(', ')}`).join('\n\n');
  return esquemaCache;
}

async function llamar(messages, maxTokens = 500) {
  const key = leerKey();
  if (!key) throw new Error('DeepSeek API key no configurada');
  const resp = await axios.post(API_URL, {
    model: MODEL,
    messages,
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
  const txt = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content;
  if (!txt) throw new Error('DeepSeek no devolvió respuesta');
  try { return JSON.parse(txt); } catch (e) {
    const m = String(txt).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Respuesta de IA no es JSON válido');
  }
}

async function llamarTexto(messages, maxTokens = 400) {
  const key = leerKey();
  if (!key) throw new Error('DeepSeek API key no configurada');
  const resp = await axios.post(API_URL, {
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
  const txt = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content;
  return String(txt || '').trim();
}

function validarSQL(sql) {
  let s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!/^(select)\b/i.test(s)) throw new Error('Solo se permite SELECT');
  if (/;/.test(s)) throw new Error('No se permiten múltiples sentencias');
  if (/\b(insert|update|delete|drop|alter|create|truncate|rename|grant|revoke|replace|load_file|outfile)\b/i.test(s)) {
    throw new Error('La consulta contiene una operación no permitida');
  }
  if (/@\w+|information_schema|mysql\.|performance_schema|sys\./i.test(s)) {
    throw new Error('La consulta intenta acceder a datos del sistema');
  }
  const tablas = [...s.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi)].map(m => m[1]);
  if (!tablas.length) throw new Error('La consulta no indica ninguna tabla');
  for (const t of tablas) {
    if (!TABLAS_PERMITIDAS.has(t)) throw new Error(`Tabla no permitida: ${t}`);
  }
  if (!/\blimit\b/i.test(s)) s += ' LIMIT 200';
  return s;
}

async function preguntar(pregunta) {
  if (!poolRef) return 'El reporte IA no está inicializado.';
  const q = String(pregunta || '').trim().slice(0, 600);
  if (!q) return 'Escriba la pregunta del reporte. Ejemplo: "¿cuánto vendí hoy?"';

  try {
    const esquema = await cargarEsquema();
    const fecha = new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
    let gen;
    try {
      gen = await llamar([
      {
        role: 'system',
        content: `Eres un analista de datos de ONE4CARS (autopartes al mayor en Venezuela).
Convierte la pregunta del administrador en UNA consulta MySQL SELECT.
Base de datos: juant200_venezon. Fecha de hoy: ${fecha}.

ESQUEMA DISPONIBLE:
${esquema}

REGLAS:
- Solo SELECT. Una sola sentencia. Sin INSERT/UPDATE/DELETE/DROP/ALTER.
- Usa solo las tablas del esquema. No uses information_schema.
- Precios: tab_productos.precio_minimo está en USD. Stock = cantidad_existencia + cantidad_existencia_almacen.
- Saldo de una factura = (total - abono_factura). NO dividir por porcentaje. total ya está en USD.
- Facturas pendientes: pagada = 'NO' AND anulado = 'no'. Facturas vencidas: además fecha_reg <= DATE_SUB(CURDATE(), INTERVAL 30 DAY).
- Clientes: tab_clientes (nombres, celular, clave = RIF sin letra, cedula = RIF con letra, vendedor, tipo, zona, activo).
- Ventas por producto: tab_facturas_reng (id_factura, producto = CÓDIGO del producto, id_producto = ID numérico interno, cantidad, precio_unitario, precio_total). Para "clientes que compraron el producto X" usa r.producto = 'X' (NO uses id_producto con el código). Une r.id_factura = f.id_factura, f.id_cliente = c.id_cliente y filtra f.anulado = 'no'.
- Productos: tab_productos.producto es el código; tab_productos.descripcion el nombre; tab_productos.id_producto el ID interno.
- Pedidos: tab_pedidos y tab_pedidos_reng.
- Visitas: tab_agenda_visitas.
- Leads mayoristas: bot_leads.
- Si la pregunta es ambigua, elige la interpretación más útil y explica en "explicacion".
- Devuelve SOLO JSON: {"sql":"SELECT ...","explicacion":"..."}`
      },
      { role: 'user', content: q }
      ], 1000);
    } catch (e) {
      if (/JSON/i.test(e.message || '')) {
        gen = await llamar([
          { role: 'system', content: 'Devuelve SOLO un objeto JSON válido, sin markdown, con las claves "sql" y "explicacion". La SQL debe ser un único SELECT en una línea.' },
          { role: 'user', content: q + '\n\nRecuerda: SOLO JSON válido.' }
        ], 1000);
      } else { throw e; }
    }

    const sql = validarSQL(gen.sql);
    const inicio = Date.now();
    const [rows] = await Promise.race([
      poolRef.query(sql),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo de consulta agotado')), 9000))
    ]);
    const datos = (rows || []).slice(0, 200);
    const resumenDatos = JSON.stringify(datos).slice(0, 8000);

    const respuesta = await llamarTexto([
      {
        role: 'system',
        content: `Eres el analista de ONE4CARS. Responde en español, breve y claro, usando SOLO las filas reales.
No inventes cifras. Si no hay filas, dilo. Usa formato WhatsApp (*negritas*), sin tablas markdown.
Incluye la cifra principal y, si aporta, 2 o 3 detalles.`
      },
      {
        role: 'user',
        content: `Pregunta: ${q}\nSQL ejecutado: ${sql}\nFilas (${datos.length}): ${resumenDatos}`
      }
    ], 400);

    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify({
        fecha: new Date().toISOString(), pregunta: q, sql, filas: datos.length, ms: Date.now() - inicio
      }) + '\n', 'utf8');
    } catch (e) {}

    return respuesta || 'No pude redactar el reporte.';
  } catch (e) {
    console.log('[REPORTES-IA] Error:', e.message);
    if (e.response && e.response.status === 402) {
      return '⚠️ *La IA de reportes no tiene saldo en DeepSeek.*\n\nRecarga el saldo de DeepSeek para volver a usar las consultas con IA.\n\nMientras tanto puedes usar las consultas directas:\n• _qué clientes compraron el producto 510018 este año_\n• _estado de cuenta de DAVERFREN_\n• _cartera de MARTIN RAMIREZ_\n• _a dónde debería vender hoy_';
    }
    return `No pude generar el reporte: ${e.message}`;
  }
}

module.exports = { init, preguntar, cargarEsquema };
