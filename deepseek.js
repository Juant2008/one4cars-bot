const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===== CONFIGURACIÓN DEEPSEEK =====
// La API key se lee de la variable de entorno DEEPSEEK_API_KEY (recomendado en Render),
// o de un archivo deepseek_key.txt en la misma carpeta (también lo escribe el comando `ia key`).
const KEY_FILE = path.join(__dirname, 'deepseek_key.txt');

function leerKey() {
    const env = (process.env.DEEPSEEK_API_KEY || '').trim();
    if (env) return env;
    try {
        if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
    } catch (e) {}
    return '';
}

let API_KEY = leerKey();

function persistirKey(key) {
    try {
        fs.writeFileSync(KEY_FILE, key.trim(), 'utf8');
    } catch (e) {
        console.log('[IA] No se pudo guardar deepseek_key.txt:', e.message);
    }
}

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const API_URL = 'https://api.deepseek.com/chat/completions';
const BALANCE_URL = 'https://api.deepseek.com/user/balance';

// Estado interno de la IA
let iaHabilitada = API_KEY.length > 0;      // Si no hay key, nunca usamos IA
let cooldownHasta = 0;                      // Timestamp hasta cuando NO llamar a la API
const COOLDOWN_MS = 5 * 60 * 1000;          // 5 minutos de espera tras un error temporal
const ERRORES_SALDO = [400, 401, 402, 403, 429]; // Códigos que indican saldo/key no válida o rate limit

let promptCache = null;
function cargarPrompt() {
    if (promptCache) return promptCache;
    try {
        const p = path.join(__dirname, 'instrucciones.txt');
        if (fs.existsSync(p)) {
            promptCache = fs.readFileSync(p, 'utf8');
        }
    } catch (e) {}
    if (!promptCache) promptCache = '';
    return promptCache;
}

// Construye el system prompt con datos en tiempo real (fecha y dólar)
function construirPrompt(dolarInfo) {
    const base = cargarPrompt();
    const fecha = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'full', timeStyle: 'short' });
    return base
        .replace(/\$\{fecha\}/g, fecha)
        .replace(/\$\{txtOficial\}/g, (dolarInfo && dolarInfo.bcv) || 'Cargando...')
        .replace(/\$\{txtParalelo\}/g, (dolarInfo && dolarInfo.paralelo) || 'Cargando...');
}

// Verifica saldo restante en DeepSeek
async function verificarSaldo() {
    if (!iaHabilitada || !API_KEY) return null;
    try {
        const r = await axios.get(BALANCE_URL, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' },
            timeout: 15000
        });
        const info = r.data && r.data.balance_infos && r.data.balance_infos[0];
        if (info) {
            const total = parseFloat(info.total_balance) || 0;
            return {
                saldo: total,
                disponible: info.is_available !== false && total > 0,
                currency: info.currency
            };
        }
    } catch (e) {
        const status = e.response && e.response.status;
        if (status === 401 || status === 402 || status === 403) {
            console.log('[IA] ❌ Key de DeepSeek no válida o saldo agotado al verificar saldo.');
            iaHabilitada = false;
        }
    }
    return null;
}

// Llama a deepseek-chat. Devuelve el texto de respuesta o null si falla.
async function preguntar(mensaje, dolarInfo) {
    if (!iaHabilitada) return null;
    if (!API_KEY) {
        iaHabilitada = false;
        return null;
    }
    if (Date.now() < cooldownHasta) return null;

    try {
        const resp = await axios.post(API_URL, {
            model: MODEL,
            messages: [
                { role: 'system', content: construirPrompt(dolarInfo) },
                { role: 'user', content: mensaje }
            ],
            max_tokens: 400,
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        const texto = resp.data && resp.data.choices && resp.data.choices[0]
            && resp.data.choices[0].message && resp.data.choices[0].message.content;
        if (!texto || !texto.trim()) return null;
        return texto.trim();
    } catch (e) {
        const status = e.response && e.response.status;
        const detalle = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
        console.log(`[IA] Error DeepSeek (${status}): ${detalle}`);

        if (ERRORES_SALDO.includes(status)) {
            // Saldo agotado o key inválida → desactivar la IA y volver al bot clásico
            iaHabilitada = false;
            console.log('[IA] 🔴 Saldo de DeepSeek agotado o key inválida. El bot vuelve al modo clásico sin IA.');
            return null;
        }

        // Error temporal (red, timeout, etc.) → esperar y reintentar después
        cooldownHasta = Date.now() + COOLDOWN_MS;
        return null;
    }
}

function estaHabilitada() {
    return iaHabilitada && Date.now() >= cooldownHasta;
}

// Actualiza la API key en caliente y la guarda para que sobreviva reinicios
function setKey(key) {
    if (key) {
        API_KEY = key.trim();
        persistirKey(API_KEY);
        iaHabilitada = true;
        cooldownHasta = 0;
        return true;
    }
    return false;
}

// Permite forzar estado (para comandos de admin)
function forzarEstado(habil) {
    iaHabilitada = habil && API_KEY.length > 0;
    cooldownHasta = 0;
}

module.exports = { preguntar, verificarSaldo, estaHabilitada, setKey, forzarEstado };
