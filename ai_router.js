/**
 * ONE4CARS - Enrutador de intenciones con IA (DeepSeek)
 *
 * Filosofía: el asistente puede entender lenguaje natural y conversar, pero
 * SOLO puede ejecutar las acciones declaradas en comandos.json. Los enlaces,
 * precios, stock y datos sensibles nunca los inventa el modelo: se resuelven
 * con el catálogo oficial o con la base de datos del bot.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const COMANDOS_FILE = path.join(DIR, 'comandos.json');
const INSTRUCCIONES_FILE = path.join(DIR, 'instrucciones.txt');
const KEY_FILE = path.join(DIR, 'deepseek_key.txt');
const LOG_FILE = path.join(DIR, 'ai_decisions.jsonl');
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const API_URL = 'https://api.deepseek.com/chat/completions';

let catalogoCache = null;
let instruccionesCache = null;
let fallosSeguidos = 0;
let pausaHasta = 0;

function leerKey() {
    try {
        if (fs.existsSync(KEY_FILE)) {
            const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
            if (k) return k;
        }
    } catch (e) {}
    return (process.env.DEEPSEEK_API_KEY || '').trim();
}

function cargarCatalogo() {
    if (catalogoCache) return catalogoCache;
    try {
        catalogoCache = JSON.parse(fs.readFileSync(COMANDOS_FILE, 'utf8'));
    } catch (e) {
        console.log('[ROUTER] No se pudo leer comandos.json:', e.message);
        catalogoCache = { acciones: [], reglas_globales: [], entrenamiento: { ejemplos_por_accion: {} } };
    }
    return catalogoCache;
}

function recargarCatalogo() {
    catalogoCache = null;
    return cargarCatalogo();
}

function guardarCatalogo(texto) {
    const data = typeof texto === 'string' ? JSON.parse(texto) : texto;
    if (!data || !Array.isArray(data.acciones)) throw new Error('El catálogo debe incluir un arreglo "acciones".');
    fs.writeFileSync(COMANDOS_FILE, JSON.stringify(data, null, 2), 'utf8');
    catalogoCache = data;
    return data;
}

function cargarInstrucciones() {
    if (instruccionesCache) return instruccionesCache;
    try {
        instruccionesCache = fs.readFileSync(INSTRUCCIONES_FILE, 'utf8');
    } catch (e) {
        instruccionesCache = '';
    }
    return instruccionesCache;
}

function recargarInstrucciones() {
    instruccionesCache = null;
    return cargarInstrucciones();
}

function idsPermitidos() {
    return new Set(cargarCatalogo().acciones.map(a => a.id));
}

function bloqueAcciones() {
    const cat = cargarCatalogo();
    const ejemplos = (cat.entrenamiento && cat.entrenamiento.ejemplos_por_accion) || {};
    return cat.acciones.map(a => {
        const ex = [...(a.ejemplos || []), ...(ejemplos[a.id] || [])].slice(0, 12);
        return [
            `- ${a.id} (${a.tipo}): ${a.descripcion || a.titulo || ''}`,
            ex.length ? `  Ejemplos reales: ${ex.map(e => `"${e}"`).join(' | ')}` : ''
        ].filter(Boolean).join('\n');
    }).join('\n');
}

function bloqueReglas() {
    const cat = cargarCatalogo();
    return (cat.reglas_globales || []).map(r => `- ${r}`).join('\n');
}

function construirPrompt(contexto = {}) {
    const fecha = new Date().toLocaleString('es-VE', {
        timeZone: 'America/Caracas', dateStyle: 'full', timeStyle: 'short'
    });
    const dolar = contexto.dolar || {};
    const base = cargarInstrucciones()
        .replace(/\$\{fecha\}/g, fecha)
        .replace(/\$\{txtOficial\}/g, dolar.bcv || 'Cargando...')
        .replace(/\$\{txtParalelo\}/g, dolar.paralelo || 'Cargando...')
        .replace(/\$\{txtBinance\}/g, dolar.binance || 'Cargando...');

    return `${base}

============================================================
 ENRUTADOR DE ACCIONES (OBLIGATORIO)
============================================================
Eres RODI, el asistente virtual de ONE4CARS. Tu trabajo es entender lo que
el cliente quiere y elegir UNA acción permitida. No eres un chatbot libre:
conversas con naturalidad, pero actúas dentro de estos parámetros.

REGLAS GLOBALES
${bloqueReglas()}

ACCIONES PERMITIDAS
${bloqueAcciones()}

CRITERIOS DE DECISIÓN
1. Si el mensaje pide un servicio del catálogo, elige esa acción. No uses
   "responder" para evadir una acción de tipo respuesta, producto, estado de
   cuenta, pedido, asesor o visitas.
2. Si el mensaje es una consulta de producto (pieza, código, marca, modelo,
   año, stock o precio), elige "consulta_productos" y coloca en
   parametros.busqueda el texto útil para buscar en inventario.
3. Si pide saldo, deuda, facturas o monto a pagar, elige "estado_cuenta".
   Si el mensaje incluye un RIF, colócalo en parametros.rif.
4. Si pide comprar, ordenar o formalizar un pedido, elige "tomar_pedido".
   No prometas precios ni stock: el sistema los confirma.
5. Si pide una persona, tiene un reclamo o el caso requiere validación
   manual, elige "asesor".
6. Si es un saludo, elige "saludo". Si pide el menú, elige "menu".
7. Si no está claro, elige "aclarar" y escribe una pregunta breve.
8. Para conversación general permitida (horarios, garantía, quiénes son,
   agradecimiento), elige "responder" y redacta una respuesta breve.
9. Nunca inventes enlaces, precios, stock, saldos, fechas ni promociones.
   Si falta un dato, pide el dato o deriva a "asesor".

CONTEXTO DE ESTA CONVERSACIÓN
- Cliente: ${contexto.nombre || 'No identificado'}
- Teléfono: ${contexto.telefono || 'No disponible'}
- Rol: ${contexto.esAdmin ? 'administrador' : (contexto.vendedor ? 'vendedor' : 'cliente')}
- Sesión validada: ${contexto.sesionValidada ? 'sí' : 'no'}
- Últimos mensajes: ${JSON.stringify(contexto.historial || []).slice(-3000)}

FORMATO DE SALIDA
Responde SOLO un objeto JSON válido, sin markdown ni texto adicional:
{"accion":"<id_permitido>","parametros":{"busqueda":"","rif":""},"respuesta":"<texto breve si aplica>","confianza":0.0}

La confianza debe estar entre 0 y 1. Si dudas, usa confianza menor a 0.55.
`;
}

function logDecision(entrada) {
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify({ fecha: new Date().toISOString(), ...entrada }) + '\n', 'utf8');
    } catch (e) {}
}

function parsearJSON(texto) {
    if (!texto) return null;
    try { return JSON.parse(texto); } catch (e) {}
    const m = String(texto).match(/\{[\s\S]*\}/);
    if (m) {
        try { return JSON.parse(m[0]); } catch (e) {}
    }
    return null;
}

function normalizarDecision(raw) {
    const permitidos = idsPermitidos();
    const d = raw && typeof raw === 'object' ? raw : {};
    let accion = String(d.accion || d.action || '').trim().toLowerCase();
    if (!permitidos.has(accion)) accion = 'responder';
    const confianza = Math.max(0, Math.min(1, Number(d.confianza ?? d.confidence ?? 0.5)));
    const parametros = (d.parametros && typeof d.parametros === 'object') ? d.parametros : {};
    const respuesta = typeof d.respuesta === 'string' ? d.respuesta.trim() : '';
    return { accion, parametros, respuesta, confianza };
}

function normalizarTexto(t) {
    return String(t || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9ñ\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Coincidencia local de alta precisión con los ejemplos del catálogo.
// Evita llamar a la API para los comandos más frecuentes y permite que el
// usuario "entrene" frases nuevas agregándolas en comandos.json.
function coincidenciaLocal(mensaje) {
    const t = normalizarTexto(mensaje);
    if (!t || t.length > 80) return null;
    const cat = cargarCatalogo();
    const extras = (cat.entrenamiento && cat.entrenamiento.ejemplos_por_accion) || {};
    let mejor = null;
    for (const a of (cat.acciones || [])) {
        if (a.id === 'responder' || a.id === 'aclarar') continue;
        const frases = [...(a.ejemplos || []), ...(extras[a.id] || [])];
        for (const f of frases) {
            const nf = normalizarTexto(f);
            if (!nf || nf.length < 3) continue;
            let score = 0;
            if (t === nf) score = 1;
            else if (t.length <= 60 && (t.startsWith(nf + ' ') || t.endsWith(' ' + nf) || t.includes(' ' + nf + ' '))) score = 0.86;
            if (score > (mejor ? mejor.confianza : 0)) {
                const params = {};
                if (a.tipo === 'producto') params.busqueda = mensaje;
                if (a.id === 'estado_cuenta') {
                    const m = String(mensaje || '').match(/\b([jvg e]?[-\s]?\d{6,10})\b/i);
                    if (m) params.rif = m[1].replace(/[^a-zA-Z0-9]/g, '');
                }
                mejor = { accion: a.id, parametros: params, respuesta: '', confianza: score, origen: 'local' };
            }
        }
    }
    return mejor;
}

// Red de seguridad determinista: si el modelo elige "responder" para una
// intención que tiene una acción oficial, se corrige la ruta. Así el bot
// puede conversar libremente sin salirse de los parámetros del negocio.
function aplicarGuardas(mensaje, decision) {
    const t = normalizarTexto(mensaje);
    const d = { ...decision, parametros: { ...(decision.parametros || {}) } };
    if (d.accion === 'responder') {
        if (/\b(interesado|interesada|me interesa|me interesan|comprar al mayor|compra al mayor|mayorista|distribuidor|soy (una )?tienda|tengo (un )?negocio|tengo (un )?local|comprar al por mayor)\b/.test(t)) {
            return { ...d, accion: 'registro_mayorista', confianza: Math.max(d.confianza, 0.8) };
        }
        if (/\b(hablar con|asesor|operador|humano|reclamo|queja|no me responde|urgencia)\b/.test(t)) {
            return { ...d, accion: 'asesor', confianza: Math.max(d.confianza, 0.72) };
        }
        if (/\b(cuanto debo|saldo|deuda|factura|estado de cuenta|pendiente|abono|monto a pagar)\b/.test(t)) {
            return { ...d, accion: 'estado_cuenta', confianza: Math.max(d.confianza, 0.72) };
        }
        if (/\b(pago|pagar|pago movil|transferencia|deposito|cuenta bancaria|datos bancarios|medios de pago)\b/.test(t)) {
            return { ...d, accion: 'medios_pago', confianza: Math.max(d.confianza, 0.7) };
        }
        if (/\b(precio|stock|disponible|tienen|tiene|busco|repuesto|pieza|filtro|bujia|rodamiento|correa|bomba|amortiguador|pastilla|disco|embrague)\b/.test(t)) {
            return { ...d, accion: 'consulta_productos', parametros: { ...d.parametros, busqueda: mensaje }, confianza: Math.max(d.confianza, 0.7) };
        }
        if (/\b(donde esta mi pedido|seguimiento|despacho|rastrear|envio|guia)\b/.test(t)) {
            return { ...d, accion: 'despacho', confianza: Math.max(d.confianza, 0.7) };
        }
    }
    if (d.accion === 'consulta_productos' && !d.parametros.busqueda) {
        d.parametros.busqueda = mensaje;
    }
    if (d.accion === 'estado_cuenta' && !d.parametros.rif) {
        const m = String(mensaje || '').match(/\b([jvg e]?[-\s]?\d{6,10})\b/i);
        if (m) d.parametros.rif = m[1].replace(/[^a-zA-Z0-9]/g, '');
    }
    return d;
}

/**
 * Decide la acción para un mensaje.
 * @param {string} mensaje Texto del usuario.
 * @param {object} contexto { nombre, telefono, esAdmin, vendedor, sesionValidada, dolar, historial }
 * @returns {Promise<{accion:string,parametros:object,respuesta:string,confianza:number}>}
 */
async function decidir(mensaje, contexto = {}) {
    const key = leerKey();
    if (!key) {
        return { accion: 'responder', parametros: {}, respuesta: '', confianza: 0, error: 'sin_key' };
    }
    if (Date.now() < pausaHasta) {
        return { accion: 'responder', parametros: {}, respuesta: '', confianza: 0, error: 'cooldown' };
    }
    const local = coincidenciaLocal(mensaje);
    if (local) {
        logDecision({
            telefono: contexto.telefono || '',
            mensaje: String(mensaje || '').slice(0, 500),
            accion: local.accion,
            confianza: local.confianza,
            parametros: local.parametros,
            origen: 'local'
        });
        return local;
    }
    const system = construirPrompt(contexto);
    const historial = Array.isArray(contexto.historial) ? contexto.historial.slice(-40) : [];
    const messages = [{ role: 'system', content: system }];
    for (const h of historial) {
        if (!h || !h.rol || !h.contenido) continue;
        messages.push({ role: h.rol === 'model' ? 'assistant' : 'user', content: String(h.contenido).slice(0, 500) });
    }
    messages.push({ role: 'user', content: String(mensaje || '').slice(0, 1200) });

    try {
        const resp = await axios.post(API_URL, {
            model: MODEL,
            messages,
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_tokens: 500
        }, {
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        const texto = resp.data && resp.data.choices && resp.data.choices[0] &&
            resp.data.choices[0].message && resp.data.choices[0].message.content;
        const decision = aplicarGuardas(mensaje, normalizarDecision(parsearJSON(texto)));
        fallosSeguidos = 0;
        logDecision({
            telefono: contexto.telefono || '',
            mensaje: String(mensaje || '').slice(0, 500),
            accion: decision.accion,
            confianza: decision.confianza,
            parametros: decision.parametros,
            respuesta: decision.respuesta.slice(0, 500)
        });
        return decision;
    } catch (e) {
        const status = e.response && e.response.status;
        const detalle = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
        console.log(`[ROUTER] Error DeepSeek (${status}): ${detalle}`);
        fallosSeguidos += 1;
        if (fallosSeguidos >= 2) {
            pausaHasta = Date.now() + 5 * 60 * 1000;
            console.log('[ROUTER] IA en pausa 5 minutos tras dos fallos. Se usa el flujo clásico.');
        }
        logDecision({ telefono: contexto.telefono || '', mensaje: String(mensaje || '').slice(0, 500), accion: 'error', error: detalle });
        return { accion: 'responder', parametros: {}, respuesta: '', confianza: 0, error: detalle };
    }
}

function ultimasDecisiones(n = 40) {
    try {
        const lineas = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
        return lineas.slice(-n).reverse().map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
    } catch (e) { return []; }
}

module.exports = {
    decidir,
    construirPrompt,
    cargarCatalogo,
    recargarCatalogo,
    guardarCatalogo,
    cargarInstrucciones,
    recargarInstrucciones,
    ultimasDecisiones,
    idsPermitidos,
    leerKey
};

// Prueba rápida: node ai_router.js "texto del cliente"
if (require.main === module) {
    const texto = process.argv.slice(2).join(' ') || 'Hola, necesito saber cuánto debo';
    decidir(texto, { nombre: 'Cliente de prueba', telefono: '584140000000', dolar: {} })
        .then(d => { console.log(JSON.stringify(d, null, 2)); process.exit(0); })
        .catch(e => { console.error(e); process.exit(1); });
}
