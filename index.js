const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const axios = require('axios');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

// ===== LECTURA DE IMÁGENES / PEDIDOS POR OCR (GRATUITO con Tesseract.js) =====
let tesseractWorker = null;
async function getOcrWorker() {
    if (!tesseractWorker) {
        try {
            // 'spa' = idioma español (se descarga automáticamente la primera vez)
            tesseractWorker = await Tesseract.createWorker('spa');
            console.log("[OCR] ✅ Worker de Tesseract listo (español).");
        } catch (e) {
            console.log("[OCR] Error creando worker Tesseract:", e.message);
            tesseractWorker = null;
        }
    }
    return tesseractWorker;
}

async function reiniciarOcrWorker() {
    try { if (tesseractWorker) await tesseractWorker.terminate(); } catch (e) {}
    tesseractWorker = null;
}

async function preprocesarImagen(buffer) {
    try {
        return await sharp(buffer)
            .resize({ width: 2000, withoutEnlargement: false })
            .grayscale()
            .sharpen()
            .linear(1.8, -40)
            .toBuffer();
    } catch (e) {
        console.log("[OCR] No se pudo pre-procesar la imagen:", e.message);
        return buffer;
    }
}

async function extraerTextoDeImagen(msg) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, pino({ level: 'silent' }));
        if (!buffer || buffer.length === 0) return null;
        const buffPre = await preprocesarImagen(buffer);
        const worker = await getOcrWorker();
        if (!worker) return null;
        const { data } = await worker.recognize(buffPre);
        const texto = (data.text || '').trim();
        return texto || null;
    } catch (e) {
        console.log("[OCR] Error al leer la imagen:", e.message);
        try { await reiniciarOcrWorker(); } catch (e2) {}
        return null;
    }
}

// Corrige errores típicos de OCR en códigos de producto (1→L, 4→A, 0→O, 8→B, etc.)
function variantesCodigoOcr(codigo) {
    const mapa = {
        'O': '0', 'o': '0', 'Q': '0', 'D': '0', 'J': '0',
        'l': '1', 'L': '1', 'I': '1', 'i': '1', '|': '1', '!': '1',
        'A': '4', 'Z': '2', 'z': '2', 'S': '5', 's': '5', 'B': '8',
        'G': '6', 'T': '7'
    };
    const variantes = new Set([codigo.toUpperCase()]);
    // Variante totalmente normalizada: "MFLALO" → "MF1410"
    variantes.add(codigo.toUpperCase().split('').map(ch => mapa[ch] || ch).join(''));
    // Reemplazos simples (un solo carácter)
    for (let i = 0; i < codigo.length; i++) {
        const ch = codigo[i];
        if (mapa[ch]) variantes.add(codigo.slice(0, i) + mapa[ch] + codigo.slice(i + 1));
    }
    // Reemplazos dobles (dos caracteres)
    for (let i = 0; i < codigo.length && variantes.size < 16; i++) {
        const ch = codigo[i];
        if (!mapa[ch]) continue;
        for (let j = i + 1; j < codigo.length; j++) {
            const ch2 = codigo[j];
            if (mapa[ch2]) {
                variantes.add(codigo.slice(0, i) + mapa[ch] + codigo.slice(i + 1, j) + mapa[ch2] + codigo.slice(j + 1));
            }
            if (variantes.size >= 16) break;
        }
    }
    return [...variantes];
}

// CAPTURA GLOBAL DE ERRORES EVITA QUE EL BOT MUERA
process.on('unhandledRejection', (err) => {
    const msg = err?.message || err;
    console.log("[UNHANDLED] Error no capturado:", msg);
    if (msg === "Connection Closed" && socketBot) {
        setTimeout(() => startBot(), 3000);
    }
});
process.on('uncaughtException', (err) => {
    console.log("[UNCAUGHT] Error crítico:", err?.message || err);
});

// MODULOS EXTERNOS
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing');
const notificador = require('./notificador_local');
const ia = require('./deepseek');

// CONFIGURACION
const PORT = process.env.PORT || 10000;
const PDF_URL_CATALOGO = process.env.PDF_URL_CATALOGO || 'https://www.one4cars.com/catalogo.pdf';

// LISTA DE ADMINISTRADORES
const ADMIN_IDS = ["228621243408492", "97899534934200"];   
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'one4cars.com',
    user: process.env.DB_USER || 'juant200_one4car',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'juant200_venezon',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'UTF8_SPANISH_CI'
});
const poolLocal = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'venezon',
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    charset: 'UTF8_SPANISH_CI'
});

// Flag: detectar si la BD local está disponible
let localDBAvailable = false;
(async () => {
    try {
        await poolLocal.execute("SELECT 1");
        localDBAvailable = true;
        console.log("[DB] ✅ BD Local disponible.");
    } catch (e) {
        localDBAvailable = false;
        console.log("[DB] ⚠️ BD Local no disponible (normal en Render).");
    }
})();
const dualExecute = async (sql, params) => {
    const r = await pool.execute(sql, params);
    try { await poolLocal.execute(sql, params); } catch (e) { console.log("[DUAL] Local error:", e.message); }
    return r;
};

const BROWSERS = [
    ["ONE4CARS", "Chrome", "1.0.0"],
    ["ONE4CARS", "Safari", "1.0.0"],
    ["ONE4CARS", "Edge", "1.0.0"],
    ["ONE4CARS", "Firefox", "1.0.0"],
    ["ONE4CARS BOT", "Chrome", "2.0.0"],
    ["ONE4CARS CRM", "Chrome", "1.5.0"],
    ["Chrome", "Linux", "120.0.0"],
    ["Safari", "MacOS", "17.0.0"],
    ["Edge", "Windows", "118.0.0"],
    ["Firefox", "Windows", "119.0.0"]
];
let browserIndex = 0;
function getBrowser() {
    const b = BROWSERS[browserIndex];
    browserIndex = (browserIndex + 1) % BROWSERS.length;
    return b;
}

const MENU_TEXT = `📋 *MENÚ PRINCIPAL ONE4CARS*

1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/
2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/
3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/
4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/
5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/
6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/
7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/
8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/
9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto.

_Escriba el número de la opción o su consulta directamente._`;

// ===== MAPA DE INTENCIONES REFORMULADO (Para evitar falsos positivos) =====
const MENU_INTENTIONS = {
    '1': {
        keywords: ['medios de pago', 'pago movil', 'datos de pago', 'como pagar', 'datos bancarios', 'cuentas para pagar'],
        response: `1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/`
    },
    '2': {
        keywords: ['estado de cuenta', 'cuanto debo', 'listado de facturas pendiente', 'mi saldo', 'facturas pendientes', 'mi deuda', 'listado de facturas', 'cuentas por cobrar'],
        response: `2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/`
    },
    '3': {
        keywords: ['lista de precios', 'listado de precios', 'catalogo de precios', 'cuanto cuestan' , 'pasame la lista', 'ver precios'],
        response: `3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/`
    },
    '4': {
        keywords: ['tomar pedido', 'hacer un pedido', 'quiero comprar', 'realizar pedido'],
        response: `4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/`
    },
    '5': {
        keywords: ['mis clientes', 'lista de vendedores', 'mis vendedores', 'ver mis clientes'],
        response: `5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/`
    },
    '6': {
        keywords: ['afiliar cliente', 'registrar cliente', 'dar de alta cliente', 'nuevo cliente'],
        response: `6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/`
    },
    '7': {
        keywords: ['consulta de productos', 'buscar en inventario', 'ver disponibilidad',  'saber de sus productos', 'buscar repuesto'],
        response: `7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/`
    },
    '8': {
        keywords: ['seguimiento despacho', 'donde esta mi pedido', 'estatus del envio', 'rastrear pedido'],
        response: `8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/`
    },
    '9': {
        keywords: ['asesor humano', 'hablar con un operador', 'soporte humano', 'quiero hablar con alguien', 'ayuda de un operador', 'contactar asesor', 'contacta un asesor', 'asesor de filtros', 'asesor se comunique', 'hablar con asesor', 'operador humano', 'comuniquen con un asesor', 'comunique con un asesor', 'asesor me contacte'],
        response: `9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto. 👩‍💻`
    },
    '10': {
        keywords: ['visitas hoy', 'visitas de hoy', 'reporte de visitas', 'agenda de hoy', 'cuantas visitas tengo hoy', 'visitas del dia'],
        response: `VISITAS_HOY`
    }
};

let qrCodeData = "Iniciando...";
let socketBot = null;
let botStarting = false; // Mutex para evitar llamadas concurrentes a startBot()
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...', binance: 'Cargando...' };
let notificadorInterval = null;
const pendientesConfirmacion = new Map();
const carritoCompras = new Map();
const agendaVisitas = new Map();
const pendingProductSelection = new Map();
const multiItemOrders = new Map();
const pendienteFactura = new Map();
const lastFallbackSent = new Map();
const FALLBACK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos
const lastMessageTimes = new Map(); // Evitar respuestas duplicadas
const DUPLICATE_COOLDOWN_MS = 10000; // 10 segundos

// Frases de auto-respuesta automática de clientes (mensajes de bienvenida/auto-reply) que deben ignorarse
const AUTO_REPLY_CLIENTE = [
    'gracias por comunicarte con el departamento de compras',
    'gracias por comunicarte con el departamento de ventas',
    'gracias por comunicarte con',
    'favor indícanos nombre de la empresa',
    'apóyanos con la siguiente información',
    'cuáles son tus 3 productos',
    'condiciones de pago, descuentos y días de crédito',
    'envía también la lista al correo',
    'para comunicarse con ventas',
    'mensaje automático',
    'auto-reply',
    'automatic reply',
    'soy un bot',
    'soy el asistente virtual',
    'en breve te atenderemo',
    'este es un mensaje automático'
];

const VISIT_KEYWORDS = [
    'me visite', 'me visiten', 'me visita', 'pase por', 'pasar por',
    'venga a', 'vengan a', 'viene a', 'vienen a', 'pasen por',
    'que pase', 'que pasen', 'el vendedor', 'lo vendedore',
    'me vea', 'me vean', 'hacer una visita', 'agendar visita', 'agendar una visita',
    'programar visita', 'programar una visita', 'quiero visita', 'necesito visita',
    'no me visita', 'no me visitan', 'tiempo que no me visita',
    'venga a verme', 'vengan a verme', 'pase a verme',
    'pasar a cobrar', 'paso a cobrar', 'pase a cobrar',
    'cobrar', 'cuando puede', 'cuando puedas',
    'proximo', 'visiten', 'visitar', 'visitarme',
    'pases por', 'pase por el', 'pasas por', 'pasar por el',
    'una visita', 'solicito visita', 'requiero visita',
    'me comunique', 'se comunique', 'asesor me visite',
    'quiero que me visiten', 'necesito que me visiten',
    'pueden visitarme', 'pueden pasar', 'puede pasar',
    'agendarme una visita', 'visita domicilio', 'visita domiciliaria',
    'vendedor me visite', 'vendedor me visiten',
    'asesor se comunique conmigo', 'comunique conmigo',
    'contactar para una visita', 'coordinar visita',
    'cobro', 'cobranza', 'por el cobro', 'para el cobro',
    'pasen por el cobro', 'pasar por el cobro', 'pase por el cobro',
    'pasar a cobro', 'paso a cobro', 'pase a cobro',
    'cobrar',
    'un vendedor', 'vendedor', 'quiero un vendedor', 'necesito un vendedor',
    'me visita un vendedor', 'envien un vendedor', 'envíen un vendedor',
    'manden un vendedor', 'mandame un vendedor', 'mándame un vendedor'
];

const DIAS_SEMANA = {
    'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
    'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6, 'domingo': 0
};

const PRODUCT_KEYWORDS = [
    'filtro', 'filtros', 'aceite', 'bujia', 'bujias', 'freno', 'frenos',
    'pastilla', 'pastillas', 'disco', 'discos', 'correa', 'correas',
    'rodamiento', 'rodamientos', 'rodaje', 'amortiguador', 'amortiguadores',
    'reten', 'retones', 'estopera', 'estoperas', 'empaque', 'empaques',
    'caucho', 'cauchos', 'neumatico', 'neumaticos', 'goma', 'gomas',
    'bateria', 'baterias', 'radiador', 'radiadores', 'ventilador', 'ventiladores',
    'alternador', 'alternadores', 'arranque', 'motor', 'motores',
    'valvula', 'valvulas', 'sensor', 'sensores', 'switch', 'interruptor',
    'manguera', 'mangueras', 'tapa', 'tapas', 'tanque', 'tanques',
    'bomba', 'bombas', 'inyector', 'inyectores', 'carburador', 'carburadores',
    'culata', 'culatas', 'cigueñal', 'cigüeñal', 'piston', 'pistones',
    'anillo', 'anillos', 'casquillo', 'casquillos', 'biela', 'bielas',
    'leva', 'levas', 'arbol', 'árbol', 'banda', 'bandas', 'cadena', 'cadenas',
    'tensor', 'tensores', 'polea', 'poleas', 'alternador', 'alternadores',
    'compresor', 'compresores', 'aire', 'acondicionado', 'calefaccion',
    'luz', 'luces', 'foco', 'focos', 'farol', 'faroles', 'lampara', 'lamparas',
    'parrilla', 'parachoques', 'guardafango', 'capot', 'capota',
    'puerta', 'puertas', 'manija', 'manijas', 'manilla', 'manillas',
    'cristal', 'cristales', 'vidrio', 'vidrios', 'parabrisas',
    'espejo', 'espejos', 'retrovisor', 'retrovisores',
    'asiento', 'asientos', 'tablero', 'instrumentos', 'reloj', 'relojes',
    'volante', 'volantes', 'bocina', 'bocinas', 'claxon',
    'llanta', 'llantas', 'rin', 'rines', 'tapa', 'tapas',
    'suspension', 'suspensión', 'barra', 'barras', 'estabilizador',
    'cruceta', 'crucetas', 'muñon', 'muñones', 'uniones de estopera', 'munon', 'munones', 'lapiz de barra', 'lápiz de barra', 'barra estabilizadora',
    'rotula', 'rotulas', 'axial', 'terminal', 'terminales',
    'caja', 'direccion', 'cremallera', 'cardan', 'cardanes',
    'embrague', 'clutch', 'presion', 'presión', 'plato', 'platos',
    'transmision', 'transmisión', 'diferencial', 'junta', 'juntas',
    'homocinetica', 'homocinética', 'homocinetico', 'homocinético',
    'tripoide', 'tripoides', 'maza', 'cubo', 'rueda', 'ruedas',
    'tornillo', 'tornillos', 'tuerca', 'tuercas', 'perno', 'pernos',
    'esparrago', 'esparragos', 'arandela', 'arandelas', 'seguro', 'seguros',
    'pasador', 'pasadores', 'chaveta', 'chavetas',
    'silenciador', 'silenciadores', 'tubo', 'tubos', 'escape', 'escarpe',
    'multiple', 'múltiple', 'colector', 'colectores',
    'catalizador', 'catalizadores', 'oxigeno', 'oxígeno',
    'liquido', 'líquido', 'refrigerante', 'anticongelante',
    'lubricante', 'grasa', 'aceite', 'hidraulico', 'hidráulico',
    'lata', 'latas', 'pintura', 'pinturas', 'thinner', 'solvente',
    'pulido', 'cera', 'ceras', 'shampoo', 'silicona',
    'kit', 'kits', 'juego', 'juegos', 'set', 'pack',
    'original', 'alternativo', 'generico', 'genérico', 'importado',
    'codigo', 'código', 'pieza', 'piezas', 'parte', 'partes',
    'rodamiento', 'descripcion', 'precio', 'costo', 'valor',
    'marca', 'marcas', 'modelo', 'modelos', 'ano', 'año', 'años',
    'diesel', 'gasolina', 'gas', 'gnv', 'electrico', 'eléctrico',
    'delantero', 'delanteros', 'delantera', 'trasero', 'traseros', 'trasera',
    'superior', 'inferior', 'lateral', 'central', 'interior', 'exterior',
    'rolinera', 'rolineras', 'ruleman', 'rulemanes', 'cojinete', 'cojinetes',
    'sello', 'sellos', 'packing', 'empaquetadura', 'empaquetaduras',
    'silicon', 'silicona', 'pegamento', 'pega', 'adhesivo',
    'limpiador', 'limpiadores', 'desengrasante', 'desengrasantes',
    'bujia', 'bujias', 'cable', 'cables', 'bobina', 'bobinas',
    'distribuidor', 'distribuidores', 'rotor', 'rotor',
    'tapa', 'tapas', 'delco', 'plato', 'platinos',
    'modulo', 'módulo', 'módulos', 'electronico', 'electrónico',
    'fusible', 'fusibles', 'relay', 'relays', 'relé', 'rele',
    'computadora', 'computador', 'ecu', 'centralita',
    'llave', 'llaves', 'switch', 'cerradura', 'cerraduras',
    'bocacho', 'bocachos', 'trompo', 'trompos', 'campana', 'campanas',
    'tambor', 'tambores', 'plato', 'platos', 'balata', 'balatas',
    'zapata', 'zapatas', 'cilindro', 'cilindros', 'bomba', 'bombas',
    'servofreno', 'servofrenos', 'master', 'booster',
    'muelle', 'muelles', 'resorte', 'resortes', 'espiral',
    'plato', 'platos', 'disco', 'discos', 'campana', 'campanas',
    'caliper', 'calipers', 'mordaza', 'mordazas', 'pistola', 'pistolas',
    'pinza', 'pinzas', 'tester', 'multimetro', 'probador',
    'gata', 'gatas', 'gato', 'gatos', 'hidraulico', 'hidráulico',
    'cargador', 'cargadores', 'arrancador', 'arrancadores', 'pasacorriente'
];

// ===== FUNCIONES DE APOYO =====

function normalizar(texto) {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") 
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?!]/g, "") 
        .toLowerCase()
        .trim();
}

function extraerNombreDeSaludo(rawText) {
    if (!rawText || rawText.trim().length < 3) return null;
    const t = rawText.trim();
    const m = t.match(/^(?:hola|saludos?|buenos?\s*(?:dias|día|días|tardes|noches)?|buenas|que tal|qué tal)\s+([A-Za-zÁÉÍÓÚáéíóúñÑüÜ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúñÑüÜ]+)?)/i);
    if (m) {
        let name = m[1].trim();
        name = name.replace(/\s+(?:como|disculpa|disculpe|permiso|una|quisiera|necesito|queria|quería|te|le|les|me|puedes|podrias|podrías).*/i, '').trim();
        name = name.replace(/[.,!?;:]+$/, '').trim();
        if (name.length >= 2 && !/^\d+$/.test(name) && !['yo','tu','el','ella','ellos','nosotros','vosotros','esto','eso','aqui','alli','señor','señora','don','doña','dias','día','días','hoy'].includes(name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) {
            return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        }
    }
    return null;
}

function limpiarRIF(texto) {
    return texto.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function soloNumerosRIF(texto) {
    return texto.replace(/\D/g, '');
}

// ===== DETECCIÓN DE MENSAJES AUTOMÁTICOS DEL BOT =====
// Registra lo que el bot envía para NO confundirlo con escritura manual del vendedor.
const botEnvios = new Map(); // jid -> [{ texto, ts }]

function extraerTextoContenido(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (content.text) return String(content.text);
    if (content.caption) return String(content.caption);
    return '';
}
function normalizarParaComparar(t) {
    return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function registrarEnvioBot(jid, texto) {
    const t = normalizarParaComparar(texto);
    if (!t || !jid) return;
    if (!botEnvios.has(jid)) botEnvios.set(jid, []);
    const arr = botEnvios.get(jid);
    arr.push({ texto: t, ts: Date.now() });
    if (arr.length > 30) arr.splice(0, arr.length - 30);
    if (botEnvios.size > 500) {
        const exp = Date.now() - 60000;
        for (const [k, v] of botEnvios) {
            const filtrado = v.filter(x => x.ts > exp);
            if (filtrado.length === 0) botEnvios.delete(k); else botEnvios.set(k, filtrado);
        }
    }
}
function esEnvioBotReciente(jid, texto) {
    const t = normalizarParaComparar(texto);
    if (!t || !jid) return false;
    const arr = botEnvios.get(jid);
    if (!arr) return false;
    const ahora = Date.now();
    return arr.some(x => x.texto === t && (ahora - x.ts) < 30000);
}

async function safeSendMessage(jid, content) {
    try {
        if (!socketBot) throw new Error("Socket no inicializado");
        registrarEnvioBot(jid, extraerTextoContenido(content));
        await socketBot.sendMessage(jid, content);
        console.log(`[MSG] ✅ Mensaje enviado a ${jid}`);
    } catch (e) {
        console.log(`[MSG] ❌ Error enviando mensaje:`, e.message);
    }
}

function isBotReady() {
    return socketBot && socketBot.user && socketBot.user.id;
}

function formatWhatsApp(jid) {
    if (!jid) return null;
    if (jid.toString().includes('@')) return jid;
    let clean = jid.toString().replace(/\D/g, ''); 
    if (clean.startsWith('580')) { clean = '58' + clean.substring(3); }
    if (clean.length > 15) return `${clean}@lid`;
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000;
    await sleep(ms);
};
const humanDelay = async (minSec = 40, maxSec = 90) => {
    const ms = Math.floor(Math.random() * ((maxSec - minSec) * 1000 + 1)) + minSec * 1000;
    await sleep(ms);
};
const randomBatchPause = async (baseMinutes = 12) => {
    const extra = Math.floor(Math.random() * 6); // 0-5 extra minutes
    const ms = (baseMinutes + extra) * 60 * 1000;
    await sleep(ms);
};
const MESSAGE_TEMPLATES = {
    visita: [
        (n) => `👋 Hola *${n}*, soy asesor de ONE4CARS. Queremos coordinar una visita para conocer sus necesidades y ofrecerle nuestros productos. ¿Qué día le queda cómodo?`,
        (n) => `📅 *${n}*, tenemos novedades en ONE4CARS. ¿Podemos agendar una visita esta semana para mostrarle nuestras ofertas?`,
        (n) => `🚗 Hola *${n}*, desde ONE4CARS queremos hacerle una visita de cortesía para ver cómo podemos seguir sirviéndole. ¿Podemos pasar esta semana?`,
        (n) => `🛞 *${n}*, le saluda su asesor ONE4CARS. Queremos visitarlo para presentarle nuestros nuevos productos y precios. ¿Cuándo podría recibirnos?`,
        (n) => `⭐ Hola *${n}*, soy su enlace ONE4CARS. Nos gustaría pasar por su negocio para una visita de seguimiento y atención. ¿Qué día le parece bien?`,
        (n) => `🔧 *${n}*, reciba un cordial saludo de ONE4CARS. Queremos agendar una visita para conocer sus requerimientos y ofrecerle lo mejor. ¿Estaría disponible esta semana?`,
        (n) => `📞 *${n}*, buenos días. Le habla su asesor ONE4CARS. Quisiéramos coordinar un día para visitarlo y conversar sobre cómo podemos ayudarle a crecer. ¿Cuándo sería ideal para usted?`,
        (n) => `🎯 *${n}*, en ONE4CARS queremos ofrecerle una atención más cercana. ¿Podemos agendar una visita esta semana para conocer sus necesidades y mostrarle nuestras soluciones?`,
        (n) => `🤝 Hola *${n}*, soy de ONE4CARS. Valoramos su confianza y queremos visitarlo personalmente para seguir fortaleciendo nuestra relación comercial. ¿Qué día le funciona?`,
        (n) => `📋 *${n}*, le escribe su asesor ONE4CARS. Queremos pasar por su establecimiento para conocer sus requerimientos actuales y ofrecerle lo mejor de nuestro catálogo. ¿Podemos coordinar una visita?`
    ],
    cobranza60: [
        (n, f, divisas, dias, bcv) => `🧾 *AVISO DE PAGO PENDIENTE*\n\nHola *${n}*, la factura *N° ${f}* emitida presenta un saldo de *$${divisas}* que ya superó los ${dias} días de vencida. Le agradecemos realizar el pago a la brevedad para mantener su historial al día.\n\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nQuedamos a su disposición. 🚗`,
        (n, f, divisas, dias, bcv) => `⚠️ *NOTIFICACIÓN DE VENCIMIENTO*\n\nHola *${n}*, le recordamos que la factura *N° ${f}* tiene ${dias} días de vencida con un saldo de *$${divisas}*. Le solicitamos proceder al pago lo antes posible.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nGracias por su atención. 🚗`,
        (n, f, divisas, dias, bcv) => `📋 *RECORDATORIO DE PAGO*\n\nEstimado(a) *${n}*, la factura *N° ${f}* se encuentra vencida desde hace ${dias} días con un saldo pendiente de *$${divisas}*. Agradecemos su pronta gestión de pago.\n\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nSaludos cordiales. 🚗`,
        (n, f, divisas, dias, bcv) => `📌 *CUENTA POR COBRAR*\n\nHola *${n}*, le notificamos que la factura *N° ${f}* por *$${divisas}* tiene ${dias} días de vencida. Le solicitamos cancelar a la brevedad para evitar recargos.\n\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nAgradecemos su atención. 🚗`,
        (n, f, divisas, dias, bcv) => `⏰ *VENCIMIENTO DE FACTURA*\n\nEstimado(a) *${n}*, la factura *N° ${f}* por *$${divisas}* acumula ${dias} días de retraso. Le agradecemos ponerse al día con su pago.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nQuedamos a la espera de su gestión. 🚗`,
        (n, f, divisas, dias, bcv) => `📢 *PAGO PENDIENTE*\n\nHola *${n}*, le recordamos que la factura *N° ${f}* con saldo de *$${divisas}* está vencida desde hace ${dias} días. Le solicitamos realizar el pago lo antes posible.\n\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nGracias por su comprensión. 🚗`,
        (n, f, divisas, dias, bcv) => `📄 *ESTADO DE CUENTA*\n\nEstimado(a) *${n}*, su factura *N° ${f}* por *$${divisas}* presenta ${dias} días de vencida. Le invitamos a cancelar para mantener su récord comercial al día.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nSaludos cordiales. 🚗`,
        (n, f, divisas, dias, bcv) => `🔴 *AVISO IMPORTANTE*\n\nHola *${n}*, la factura *N° ${f}* con saldo de *$${divisas}* tiene ${dias} días de vencida. Le agradecemos gestionar el pago a la brevedad.\n\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nQuedamos a su disposición. 🚗`,
        (n, f, divisas, dias, bcv) => `📬 *NOTIFICACIÓN DE COBRANZA*\n\nEstimado(a) *${n}*, le informamos que la factura *N° ${f}* por *$${divisas}* se encuentra vencida (${dias} días). Le solicitamos proceder al pago.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nAgradecemos su pronta respuesta. 🚗`,
        (n, f, divisas, dias, bcv) => `📑 *SALDO PENDIENTE*\n\nHola *${n}*, la factura *N° ${f}* emitida por *$${divisas}* supera los ${dias} días de vencida. Le agradecemos cancelar lo antes posible.\n\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nGracias por su gestión. 🚗`
    ],
    recordatorioEstado: [
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Recordatorio de Pago* 🚗\n\nEstimado(a) *${n}*, le escribimos de manera cordial para recordarle que la nota ${nota} por un Monto de $${divisas} se encuentra vencida desde hace ${dias}. Le solicitamos proceder con el pago a la brevedad para evitar suspensiones en el servicio y mantener su historial comercial al día.\n\n💰 Realice su pago ahora y continúe disfrutando de nuestros productos y atención preferencial.\nTotal Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nAgradecemos su pronta gestión. ¡Gracias por confiar en ONE4CARS! 🚀`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Aviso de Pago Pendiente* 🚗\n\nHola *${n}*, por medio del presente le recordamos que la nota ${nota} por $${divisas} se encuentra pendiente de pago desde hace ${dias}. Le agradecemos regularizar su situación a la mayor brevedad.\n\n💳 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nQuedamos atentos a su gestión. ¡Gracias por preferirnos! 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Notificación de Deuda* 🚗\n\nEstimado(a) *${n}*, le comunicamos cordialmente que la nota ${nota} por $${divisas} acumula ${dias} de vencida. Le solicitamos efectuar el pago para mantener su cuenta al día.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nA la espera de su pronta respuesta. ¡Saludos! 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Cuenta por Cobrar* 🚗\n\nHola *${n}*, le recordamos que la nota ${nota} por $${divisas} tiene ${dias} de vencida. Le agradecemos cancelar a la brevedad para mantener su historial al día.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nGracias por su atención. 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Aviso de Vencimiento* 🚗\n\nEstimado(a) *${n}*, la nota ${nota} por $${divisas} se encuentra vencida (${dias}). Le solicitamos proceder con el pago para evitar suspensiones.\n\n💳 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nAgradecemos su gestión. 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Nota Pendiente* 🚗\n\nHola *${n}*, le escribimos para informarle que la nota ${nota} por $${divisas} acumula ${dias} de vencida. Le agradecemos ponerse al día.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nQuedamos a su disposición. 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Estado de Cuenta* 🚗\n\nEstimado(a) *${n}*, su nota ${nota} por $${divisas} está pendiente de pago desde hace ${dias}. Le solicitamos cancelar a la brevedad.\n\n💳 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nGracias por su preferencia. 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Deuda Pendiente* 🚗\n\nHola *${n}*, le notificamos que la nota ${nota} por $${divisas} tiene ${dias} de vencida. Le agradecemos regularizar su situación.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nSaludos cordiales. 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Aviso de Cobro* 🚗\n\nEstimado(a) *${n}*, la nota ${nota} por $${divisas} supera los ${dias} de vencida. Le solicitamos efectuar el pago a la brevedad.\n\n💳 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nAgradecemos su atención. 🚗`,
        (n, nota, divisas, dias, bcv) => `📢 *ONE4CARS — Saldo Vencido* 🚗\n\nHola *${n}*, su nota ${nota} por $${divisas} se encuentra vencida desde hace ${dias}. Le agradecemos proceder con el pago.\n\n💰 Total Divisas: $${divisas}\nTotal Bs: ${bcv}\n\nGracias por confiar en ONE4CARS. 🚗`
    ],
    recordatorioVisita: [
        (n) => `👋 Hola *${n}*, un cordial saludo del equipo ONE4CARS. Queremos invitarlo a agendar una visita de uno de nuestros asesores para atender sus requerimientos y ofrecerle lo mejor de nuestro catálogo. ¿Podemos visitarlo esta semana?`,
        (n) => `📅 *${n}*, en ONE4CARS queremos mantenernos cerca de usted. ¿Le gustaría que un asesor le visite esta semana para conocer sus necesidades y mostrarle nuestras novedades?`,
        (n) => `🚗 Hola *${n}*, desde ONE4CARS valoramos su preferencia. Queremos coordinar una visita de cortesía para seguir brindándole la mejor atención. ¿Qué día le queda cómodo?`,
        (n) => `🛞 *${n}*, le saluda su asesor ONE4CARS. Estamos organizando las visitas de la semana y queremos incluirle. ¿Puede recibirnos estos días para conversar sobre cómo podemos servirle mejor?`,
        (n) => `⭐ Hola *${n}*, soy su enlace ONE4CARS. Nos gustaría pasar por su negocio para una visita de seguimiento y atención personalizada. ¿Estaría disponible esta semana?`,
        (n) => `🔧 *${n}*, reciba un cordial saludo de ONE4CARS. Queremos agendar una visita para conocer sus requerimientos actuales y ofrecerle lo mejor. ¿Cuándo le parece bien que pasemos?`
    ]
};
const pickTemplate = (arr) => arr[Math.floor(Math.random() * arr.length)];
const DIAS_ENVIADOS_HOY = new Set();
const MAX_ENVIOS_POR_DIA = 20;
let enviadosHoy = 0;
function chequearLimiteDiario() {
    const hoy = new Date().toDateString();
    if (DIAS_ENVIADOS_HOY.size === 0 || !DIAS_ENVIADOS_HOY.has(hoy)) {
        DIAS_ENVIADOS_HOY.clear();
        DIAS_ENVIADOS_HOY.add(hoy);
        enviadosHoy = 0;
        return true;
    }
    if (enviadosHoy >= MAX_ENVIOS_POR_DIA) return false;
    return true;
}
function contarEnvio() { enviadosHoy++; }

async function guardarMensaje(tel, rol, contenido) {
    try {
        await dualExecute("INSERT INTO historial_chat (telefono, rol, contenido) VALUES (?, ?, ?)", [tel, rol, contenido]);
    } catch (e) { console.log("Error guardando historial"); }
}

async function setModo(tel, modo) {
    await pool.execute("INSERT INTO control_chat (telefono, modo, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE modo = VALUES(modo), updated_at = NOW()", [tel, modo]);
}

// Silencia el bot para un chat (el vendedor lo atiende manualmente).
// Se reactiva automáticamente tras REACTIVAR_BOT_MS (10 min) sin intervención humana,
// o manualmente con el comando "!bot".
const REACTIVAR_BOT_MS = 10 * 60 * 1000; // 10 minutos sin que el vendedor intervenga → el bot se reactiva solo

async function silenciarChat(jid) {
    await setModo(jid, 'humano');
    console.log(`[SILENT] Bot silenciado para ${jid.split('@')[0]} (el vendedor atiende manualmente).`);
}

async function setSesionDatos(tel, datos) {
    try {
        await pool.execute("INSERT INTO control_chat (telefono, datos, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos), updated_at = NOW()", [tel, JSON.stringify(datos)]);
    } catch (e) { console.log("Error guardando datos sesión:", e.message); }
}

async function clearSesionDatos(tel) {
    try {
        await pool.execute("UPDATE control_chat SET datos = NULL WHERE telefono = ?", [tel]);
    } catch (e) {}
}

async function ensureTablaPedidos() {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS tab_pedidos (
            id_factura INT AUTO_INCREMENT PRIMARY KEY,
            nro_factura INT NOT NULL,
            fecha_reg DATE,
            nombres VARCHAR(150),
            celular VARCHAR(50),
            total DECIMAL(12,2) DEFAULT 0,
            id_vendedor INT DEFAULT 0,
            vendedor VARCHAR(100),
            sub_vendedor VARCHAR(100),
            celular_vendedor VARCHAR(50),
            pagada VARCHAR(2) DEFAULT 'NO',
            anulado VARCHAR(5) DEFAULT 'no'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
        try { await pool.execute("ALTER TABLE tab_pedidos ADD COLUMN sub_vendedor VARCHAR(100) AFTER vendedor"); } catch (e) {}
        try { await pool.execute("ALTER TABLE tab_pedidos ADD COLUMN celular_vendedor VARCHAR(50) AFTER sub_vendedor"); } catch (e) {}
    } catch (e) {
        console.log("[DB] ensureTablaPedidos: No se pudo crear tab_pedidos:", e.message);
        return false;
    }
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS tab_pedidos_reng (
            id_renglon INT AUTO_INCREMENT PRIMARY KEY,
            id_factura INT,
            nro_reglon INT,
            producto VARCHAR(50),
            cantidad INT,
            precio_unitario DECIMAL(12,2),
            precio_total DECIMAL(12,2),
            tipo VARCHAR(50),
            fecha_reg DATE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
    } catch (e) {
        console.log("[DB] ensureTablaPedidos: No se pudo crear tab_pedidos_reng:", e.message);
    }
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS orden (
            order_id INT AUTO_INCREMENT PRIMARY KEY,
            customer_id INT,
            cedula VARCHAR(20),
            nombres VARCHAR(150),
            direccion VARCHAR(200),
            celular VARCHAR(50),
            id_vendedor INT DEFAULT 0,
            vendedor VARCHAR(100),
            total_price DECIMAL(12,2) DEFAULT 0,
            created DATETIME,
            modified DATETIME,
            status VARCHAR(2) DEFAULT '1',
            facturado VARCHAR(5) DEFAULT 'NO',
            pendiente VARCHAR(5) DEFAULT 'NO',
            forma_de_pago VARCHAR(20) DEFAULT '',
            facturar VARCHAR(5) DEFAULT '',
            comentarios TEXT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
    } catch (e) {
        console.log("[DB] ensureTablaPedidos: No se pudo crear orden:", e.message);
    }
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS orden_articulos (
            id_articulo INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT,
            product_id INT DEFAULT 0,
            producto VARCHAR(50),
            descripcion VARCHAR(200),
            quantity INT,
            precio_unitario DECIMAL(12,2),
            almacen VARCHAR(50) DEFAULT ''
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
    } catch (e) {
        console.log("[DB] ensureTablaPedidos: No se pudo crear orden_articulos:", e.message);
    }
    return true;
}

async function restaurarSesiones() {
    try {
        const [rows] = await pool.execute("SELECT telefono, modo, datos FROM control_chat WHERE modo IN ('confirmando', 'visitando', 'esperando_cliente') AND datos IS NOT NULL");
        let cont = 0;
        for (const r of rows) {
            try {
                const datos = JSON.parse(r.datos);
                if (r.modo === 'confirmando') {
                    pendientesConfirmacion.set(r.telefono, datos);
                    cont++;
                } else if (r.modo === 'visitando') {
                    if (datos.esperando_fecha || datos.esperando_confirmacion) {
                        if (datos.acuerdo_visita) datos.acuerdo_visita = new Date(datos.acuerdo_visita);
                        agendaVisitas.set(r.telefono, datos);
                        cont++;
                    }
                } else if (r.modo === 'esperando_cliente') {
                    cont++;
                }
            } catch (e2) {}
        }
        console.log(`[SESIONES] ${cont} sesion(es) restaurada(s) de la BD.`);
    } catch (e) { console.log("[SESIONES] Error restaurando:", e.message); }
}

async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0].replace(/\D/g, ''); 
    const [r] = await pool.execute(
        "SELECT * FROM tab_vendedores WHERE REPLACE(REPLACE(celular_vendedor, ' ', ''), '+', '') LIKE ? OR REPLACE(REPLACE(telefono_vendedor, ' ', ''), '+', '') LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`]
    );
    if (r[0]) return r[0];
    
    const jidDomain = jid.split('@')[1];
    // Modificado para que exija coincidencia exacta o un pushName válido y largo
    if (jidDomain && jidDomain.includes('lid') && pushName && pushName.trim().length > 3) {
        const [r2] = await pool.execute(
            "SELECT * FROM tab_vendedores WHERE nombre = ? LIMIT 1",
            [pushName.trim()]
        );
        if (r2[0]) return r2[0];
    }
    return null;
}

function detectarIntencionMenu(texto) {
    if (!texto) return null;
    if (/^\d$/.test(texto)) {
        const num = texto.charAt(0);
        if (MENU_INTENTIONS[num]) return MENU_INTENTIONS[num].response;
    }
    for (const key in MENU_INTENTIONS) {
        const intention = MENU_INTENTIONS[key];
        if (intention.keywords.some(phrase => texto.includes(phrase))) {
            return intention.response;
        }
    }
    return null;
}

function detectarVisita(rawText, text) {
    if (!rawText) return false;
    const t = text || normalizar(rawText);
    for (const kw of VISIT_KEYWORDS) {
        if (t.includes(kw)) return true;
    }
    return false;
}

function parsearFechaVisita(texto) {
    const t = normalizar(texto);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    if (t === 'hoy' || t.includes('ahora') || t === 'ya' || t === 'hoy mismo') return { fecha: new Date(hoy), frecuencia: 0 };

    if (t.includes('manana') && !t.includes('pasado')) {
        const r = new Date(hoy);
        r.setDate(r.getDate() + 1);
        return { fecha: r, frecuencia: 0 };
    }
    if (t.includes('pasado manana') || t.includes('pasado mañana')) {
        const r = new Date(hoy);
        r.setDate(r.getDate() + 2);
        return { fecha: r, frecuencia: 0 };
    }

    const matchNumDias = t.match(/(\d+)\s*(?:dias|día|dia)/);
    if (matchNumDias) {
        const r = new Date(hoy);
        r.setDate(r.getDate() + parseInt(matchNumDias[1]));
        return { fecha: r, frecuencia: 0 };
    }

    const matchSemana = t.match(/(\d+)\s*(?:semanas|semana)/);
    if (matchSemana) {
        const r = new Date(hoy);
        r.setDate(r.getDate() + parseInt(matchSemana[1]) * 7);
        return { fecha: r, frecuencia: 0 };
    }

    const matchMes = t.match(/(\d+)\s*(?:meses|mes)/);
    if (matchMes) {
        const r = new Date(hoy);
        r.setMonth(r.getMonth() + parseInt(matchMes[1]));
        return { fecha: r, frecuencia: 0 };
    }

    const matchDiaSemana = t.match(/(?:este|esta|proximo|próximo|proxima|próxima|el|que viene|los|todos los|todos)\s*(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)/i);
    if (matchDiaSemana) {
        const diaNombre = matchDiaSemana[1].toLowerCase();
        const prefix = matchDiaSemana[0].toLowerCase().split(/\s+/)[0];
        const diaTarget = DIAS_SEMANA[diaNombre];
        if (diaTarget !== undefined) {
            const diff = (diaTarget - hoy.getDay() + 7) % 7;
            const r = new Date(hoy);
            if (diff === 0) {
                r.setDate(r.getDate() + 7);
            } else {
                r.setDate(r.getDate() + diff);
            }
            const frecuencia = (prefix === 'los' || prefix === 'todos') ? 7 : 0;
            return { fecha: r, frecuencia };
        }
    }

    const matchFechaNum = t.match(/(\d{1,2})\s*(?:\/|-)\s*(\d{1,2})(?:\s*(?:\/|-)\s*(\d{2,4}))?/);
    if (matchFechaNum) {
        const d = parseInt(matchFechaNum[1]);
        const m = parseInt(matchFechaNum[2]) - 1;
        let y = hoy.getFullYear();
        if (matchFechaNum[3]) {
            y = parseInt(matchFechaNum[3]);
            if (y < 100) y += 2000;
        }
        const r = new Date(y, m, d);
        if (!isNaN(r.getTime())) return { fecha: r, frecuencia: 0 };
    }

    if (t.includes('proxima semana') || t.includes('proxima semana')) {
        const r = new Date(hoy);
        r.setDate(r.getDate() + 7);
        return { fecha: r, frecuencia: 0 };
    }

    if (t === 'semana que viene' || t === 'la semana que viene') {
        const r = new Date(hoy);
        r.setDate(r.getDate() + 7);
        return { fecha: r, frecuencia: 0 };
    }

    return null;
}

async function guardarVisita(from, datos) {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const acuerdo = datos.acuerdo_visita ? datos.acuerdo_visita.toISOString().split('T')[0] : hoy;
        await pool.execute(
            `INSERT INTO tab_visitas 
             (fecha_reg, rif, id_cliente, nombres, direccion, telefono, celular, id_vendedor, nombre, 
              direcciongooglemap, zona, visita_realizada, contador_visitas, motivo, logro, acuerdo_visita, 
              dias_frecuencia, interes_producto) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NO', 1, ?, 'NO', ?, ?, 'SI')`,
            [
                hoy,
                datos.rif || '',
                datos.id_cliente || 0,
                datos.nombres || 'Cliente WhatsApp',
                datos.direccion || '',
                datos.telefono || '',
                datos.celular || from.split('@')[0],
                datos.id_vendedor || 0,
                datos.nombre_vendedor || '',
                '',
                datos.zona || '',
                datos.motivo || 'Solicitud de visita por WhatsApp',
                acuerdo,
                datos.dias_frecuencia || 0
            ]
        );
        console.log(`[VISITA] ✅ Visita agendada para ${from}`);
        return true;
    } catch (e) {
        console.log("[VISITA] Error al guardar:", e.message);
        return false;
    }
}

async function buscarClientePorTelefono(tel) {
    const telLimpio = tel.replace(/\D/g, '');
    try {
        const [r] = await pool.execute(
            "SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor FROM tab_clientes WHERE REPLACE(celular, ' ', '') LIKE ? OR REPLACE(telefono, ' ', '') LIKE ? LIMIT 1",
            [`%${telLimpio}%`, `%${telLimpio}%`]
        );
        return r[0] || null;
    } catch (e) { return null; }
}

// ===== VERIFICACIÓN DE CRÉDITO DEL CLIENTE =====

function extraerNombreCliente(rawText, itemsPedido) {
    if (!rawText) return null;
    let textoRestante = rawText;
    for (const item of itemsPedido) {
        const regexCodigo = new RegExp(`(?:^|\\n)\\s*(?:${item.cantidad}\\s*[-=]?\\s*${item.codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${item.codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-=]?\\s*${item.cantidad})\\s*(?:piezas?|und|unidad(?:es)?|uds?|unid\\.?)?\\s*$`, 'gim');
        textoRestante = textoRestante.replace(regexCodigo, '');
    }
    textoRestante = textoRestante
        .replace(/\b\d{1,4}\s*[-=]?\s*[A-Za-z0-9]{3,}\b/g, '')
        .replace(/\b[A-Za-z0-9]{3,}\s*[-=]?\s*\d{1,4}\b/g, '')
        .replace(/\b(piezas?|und|unidad(?:es)?|uds?|unid\.?|pedido|cotiza(?:r|me|íme)|orden|compra|necesito|quisiera|enviame|envíame|por favor|favor)\b/gi, '')
        .replace(/[,\-;:=]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const palabras = textoRestante.split(' ').filter(p => p.length >= 3);
    if (palabras.length === 0) return null;
    const nombre = palabras.join(' ');
    if (/^\d+$/.test(nombre)) return null;
    return nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();
}

async function buscarClientePorNombreYVendedor(nombreCliente, nombreVendedor) {
    if (!nombreCliente || !nombreVendedor) return null;
    try {
        const [r] = await pool.execute(
            "SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor FROM tab_clientes WHERE vendedor = ? AND nombres LIKE ? AND activo = 'si' LIMIT 1",
            [nombreVendedor, `%${nombreCliente}%`]
        );
        if (r[0]) return r[0];
        const [r2] = await pool.execute(
            "SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor FROM tab_clientes WHERE vendedor LIKE ? AND nombres LIKE ? AND activo = 'si' LIMIT 1",
            [`%${nombreVendedor}%`, `%${nombreCliente}%`]
        );
        if (r2[0]) return r2[0];
        // Fallback: buscar sin filtro activo
        const [r3] = await pool.execute(
            "SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor FROM tab_clientes WHERE vendedor = ? AND nombres LIKE ? LIMIT 1",
            [nombreVendedor, `%${nombreCliente}%`]
        );
        if (r3[0]) return r3[0];
        const [r4] = await pool.execute(
            "SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor FROM tab_clientes WHERE vendedor LIKE ? AND nombres LIKE ? LIMIT 1",
            [`%${nombreVendedor}%`, `%${nombreCliente}%`]
        );
        return r4[0] || null;
    } catch (e) { console.log("[BUSCAR_CLIENTE] Error en buscarClientePorNombreYVendedor:", e.sqlMessage || e.message); return null; }
}

async function buscarClientePorPalabras(palabras, nombreVendedor, textoOriginal) {
    if (!palabras || palabras.length === 0) return null;
    try {
        // Primero buscar por el texto completo original (respeta palabras cortas como "de", "la", "el")
        if (textoOriginal) {
            const [r0] = await pool.execute(
                `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
                 FROM tab_clientes WHERE nombres LIKE ? AND activo = 'si' LIMIT 1`,
                [`%${textoOriginal}%`]
            );
            if (r0[0]) return r0[0];
        }
        const conditions = palabras.map(() => 'nombres LIKE ?').join(' OR ');
        if (nombreVendedor) {
            const params = [nombreVendedor];
            for (const p of palabras) params.push(`%${p}%`);
            const [r] = await pool.execute(
                `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
                 FROM tab_clientes WHERE vendedor = ? AND (${conditions}) AND activo = 'si' LIMIT 1`,
                params
            );
            if (r[0]) return r[0];
            const params2 = [`%${nombreVendedor}%`];
            for (const p of palabras) params2.push(`%${p}%`);
            const [r2] = await pool.execute(
                `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
                 FROM tab_clientes WHERE vendedor LIKE ? AND (${conditions}) AND activo = 'si' LIMIT 1`,
                params2
            );
            if (r2[0]) return r2[0];
        }
        // Sin filtro de vendedor — primero intentar LIKE con el nombre completo
        const nombreCompleto = palabras.join(' ');
        const [r3] = await pool.execute(
            `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
             FROM tab_clientes WHERE nombres LIKE ? AND activo = 'si' LIMIT 1`,
            [`%${nombreCompleto}%`]
        );
        if (r3[0]) return r3[0];
        // Buscar por palabras individuales (AND — todas deben coincidir)
        const andConditions = palabras.map(() => 'nombres LIKE ?').join(' AND ');
        const params4 = palabras.map(p => `%${p}%`);
        const [r4] = await pool.execute(
            `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
             FROM tab_clientes WHERE (${andConditions}) AND activo = 'si' LIMIT 1`,
            params4
        );
        if (r4[0]) return r4[0];
        // Último recurso: OR, pero limitado
        const params5 = palabras.map(p => `%${p}%`);
        const [r5] = await pool.execute(
            `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
             FROM tab_clientes WHERE (${conditions}) AND activo = 'si' LIMIT 1`,
            params5
        );
        if (r5[0]) return r5[0];
        // Fallback final: buscar sin filtro activo
        const [r6] = await pool.execute(
            `SELECT id_cliente, nombres, cedula, celular, telefono, direccion, zona, clave as rif, vendedor
             FROM tab_clientes WHERE (${conditions}) LIMIT 1`,
            params5
        );
        return r6[0] || null;
    } catch (e) { console.log("[BUSCAR_CLIENTE] Error en buscarClientePorPalabras:", e.sqlMessage || e.message); return null; }
}

function extraerPalabrasClave(rawText, itemsPedido) {
    if (!rawText) return [];
    let texto = rawText;
    for (const item of itemsPedido) {
        const codEsc = item.codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        texto = texto.replace(new RegExp(`(?:^|\\n)\\s*(?:${item.cantidad}\\s*[-=]?\\s*${codEsc}|${codEsc}\\s*[-=]?\\s*${item.cantidad})`, 'gi'), '');
    }
    texto = texto
        .replace(/\b\d{1,4}\s*[-=]?\s*[A-Za-z0-9]{3,}\b/g, '')
        .replace(/\b[A-Za-z0-9]{3,}\s*[-=]?\s*\d{1,4}\b/g, '')
        .replace(/\b(piezas?|und|unidad(?:es)?|uds?|unid\.?|pedido|cotiza(?:r|me|íme)|orden|compra|necesito|quisiera|enviame|envíame|por favor|favor|buenos?|buenas?|dias?|tardes?|noches?|saludos?|hola|mi|nombre|soy|este|para|como|todo|puede|algo)\b/gi, '')
        .replace(/[,\-;:=]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const palabras = texto.split(' ')
        .filter(p => p.length >= 3)
        .filter(p => !/^\d+$/.test(p))
        .map(p => p.toUpperCase());
    return [...new Set(palabras)];
}

async function verificarCreditoCliente(id_cliente) {
    const resultado = { tieneVencidas: false, facturasVencidas: [], tieneRetrasos: false, mayorRetraso: 0, facturasRetraso: [] };
    try {
        const [vencidas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje,
                    DATEDIFF(CURDATE(), f.fecha_reg) as dias_vencida
             FROM tab_facturas f
             WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'
               AND DATEDIFF(CURDATE(), f.fecha_reg) > 30
             ORDER BY f.fecha_reg ASC`,
            [id_cliente]
        );
        if (vencidas.length > 0) {
            resultado.tieneVencidas = true;
            resultado.facturasVencidas = vencidas.map(f => ({
                nro_factura: f.nro_factura,
                saldo: (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1),
                dias_vencida: f.dias_vencida
            }));
        }
        const [retrasos] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.dias_pago
             FROM tab_facturas f
             WHERE f.id_cliente = ? AND f.pagada = 'SI' AND f.anulado = 'no'
               AND f.dias_pago > 60
             ORDER BY f.fecha_reg DESC
             LIMIT 4`,
            [id_cliente]
        );
        if (retrasos.length > 0) {
            resultado.tieneRetrasos = true;
            resultado.mayorRetraso = Math.max(...retrasos.map(f => parseInt(f.dias_pago) || 0));
            resultado.facturasRetraso = retrasos.map(f => ({
                nro_factura: f.nro_factura,
                dias_pago: parseInt(f.dias_pago) || 0
            }));
        }
    } catch (e) { console.log("[CREDITO] Error verificando:", e.message); }
    return resultado;
}

// ===== BASE DE DATOS =====
// ===== SINCRONIZACIÓN INTELIGENTE tab_facturas (LOCAL ↔ REMOTO) =====
// Preserva whatsapp_notificado y whatsapp_mora al sincronizar
async function syncFacturasLocalRemoto() {
    try {
        // 1. Asegurar que la BD local tenga las columnas necesarias
        try { await poolLocal.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_notificado VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await poolLocal.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_mora VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await pool.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_notificado VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await pool.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_mora VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}

        // 2. Obtener estados del remoto (valores que NO queremos perder)
        const [remotoStates] = await pool.execute(
            "SELECT id_factura, whatsapp_notificado, whatsapp_mora FROM tab_facturas WHERE whatsapp_notificado = 'SI' OR whatsapp_mora = 'SI'"
        );
        const remoteMap = {};
        for (const r of remotoStates) {
            remoteMap[r.id_factura] = { wn: r.whatsapp_notificado, wm: r.whatsapp_mora };
        }

        // 3. Obtener registros del local que no están en remoto (o están desactualizados)
        const [locales] = await poolLocal.execute("SELECT * FROM tab_facturas");
        let insertados = 0;
        let actualizados = 0;

        for (const f of locales) {
            const [existeRemoto] = await pool.execute("SELECT id_factura FROM tab_facturas WHERE id_factura = ?", [f.id_factura]);
            if (existeRemoto.length === 0) {
                // No existe en remoto: copiar con valores por defecto de whatsapp
                await pool.execute(
                    `INSERT INTO tab_facturas (id_factura, nro_factura, id_cliente, nombres, cedula, celular, telefono, direccion, zona,
                     id_vendedor, vendedor, total, abono_factura, porcentaje, fecha_reg, pagada, anulado, descuento, total_desc,
                     whatsapp_notificado, whatsapp_mora)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NO', 'NO')`,
                    [f.id_factura, f.nro_factura, f.id_cliente, f.nombres, f.cedula, f.celular, f.telefono, f.direccion, f.zona,
                     f.id_vendedor, f.vendedor, f.total, f.abono_factura, f.porcentaje, f.fecha_reg, f.pagada, f.anulado,
                     f.descuento || 0, f.total_desc || 0]
                );
                insertados++;
            } else {
                // Existe en remoto: actualizar datos de negocio pero PRESERVAR whatsapp_notificado y whatsapp_mora
                const rm = remoteMap[f.id_factura] || { wn: 'NO', wm: 'NO' };
                await pool.execute(
                    `UPDATE tab_facturas SET
                     nro_factura=?, id_cliente=?, nombres=?, cedula=?, celular=?, telefono=?, direccion=?, zona=?,
                     id_vendedor=?, vendedor=?, total=?, abono_factura=?, porcentaje=?, fecha_reg=?, pagada=?, anulado=?,
                     descuento=?, total_desc=?,
                     whatsapp_notificado=?, whatsapp_mora=?
                     WHERE id_factura=?`,
                    [f.nro_factura, f.id_cliente, f.nombres, f.cedula, f.celular, f.telefono, f.direccion, f.zona,
                     f.id_vendedor, f.vendedor, f.total, f.abono_factura, f.porcentaje, f.fecha_reg, f.pagada, f.anulado,
                     f.descuento || 0, f.total_desc || 0,
                     rm.wn, rm.wm,
                     f.id_factura]
                );
                actualizados++;
            }
        }

        // 4. Sincronizar estados de WhatsApp del remoto → local
        for (const [idFac, states] of Object.entries(remoteMap)) {
            await poolLocal.execute(
                "UPDATE tab_facturas SET whatsapp_notificado = ?, whatsapp_mora = ? WHERE id_factura = ?",
                [states.wn, states.wm, idFac]
            );
        }

        console.log(`[SYNC-FACTURAS] ✅ Insertados: ${insertados}, Actualizados: ${actualizados}, Preservados: ${Object.keys(remoteMap).length}`);
        return { insertados, actualizados, preservados: Object.keys(remoteMap).length };
    } catch (e) {
        console.log("[SYNC-FACTURAS] Error:", e.message);
        return { error: e.message };
    }
}

// Sync inverso: remoto → local (cuando el sistema remoto crea facturas)
async function syncFacturasRemotoALocal() {
    try {
        try { await poolLocal.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_notificado VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await poolLocal.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_mora VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}

        const [remotos] = await pool.execute("SELECT * FROM tab_facturas");
        let insertados = 0;
        let actualizados = 0;

        for (const f of remotos) {
            const [existeLocal] = await poolLocal.execute("SELECT id_factura FROM tab_facturas WHERE id_factura = ?", [f.id_factura]);
            if (existeLocal.length === 0) {
                await poolLocal.execute(
                    `INSERT INTO tab_facturas (id_factura, nro_factura, id_cliente, nombres, cedula, celular, telefono, direccion, zona,
                     id_vendedor, vendedor, total, abono_factura, porcentaje, fecha_reg, pagada, anulado, descuento, total_desc,
                     whatsapp_notificado, whatsapp_mora)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [f.id_factura, f.nro_factura, f.id_cliente, f.nombres, f.cedula, f.celular, f.telefono, f.direccion, f.zona,
                     f.id_vendedor, f.vendedor, f.total, f.abono_factura, f.porcentaje, f.fecha_reg, f.pagada, f.anulado,
                     f.descuento || 0, f.total_desc || 0, f.whatsapp_notificado || 'NO', f.whatsapp_mora || 'NO']
                );
                insertados++;
            } else {
                await poolLocal.execute(
                    `UPDATE tab_facturas SET
                     nro_factura=?, id_cliente=?, nombres=?, cedula=?, celular=?, telefono=?, direccion=?, zona=?,
                     id_vendedor=?, vendedor=?, total=?, abono_factura=?, porcentaje=?, fecha_reg=?, pagada=?, anulado=?,
                     descuento=?, total_desc=?,
                     whatsapp_notificado=?, whatsapp_mora=?
                     WHERE id_factura=?`,
                    [f.nro_factura, f.id_cliente, f.nombres, f.cedula, f.celular, f.telefono, f.direccion, f.zona,
                     f.id_vendedor, f.vendedor, f.total, f.abono_factura, f.porcentaje, f.fecha_reg, f.pagada, f.anulado,
                     f.descuento || 0, f.total_desc || 0, f.whatsapp_notificado || 'NO', f.whatsapp_mora || 'NO',
                     f.id_factura]
                );
                actualizados++;
            }
        }
        console.log(`[SYNC-R→L] ✅ Insertados: ${insertados}, Actualizados: ${actualizados}`);
        return { insertados, actualizados };
    } catch (e) {
        console.log("[SYNC-R→L] Error:", e.message);
        return { error: e.message };
    }
}

async function initDB() {
    try {
        // Migración: agregar columnas de WhatsApp a tab_facturas en ambas BD
        try { await pool.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_notificado VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await pool.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_mora VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await poolLocal.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_notificado VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}
        try { await poolLocal.execute("ALTER TABLE tab_facturas ADD COLUMN whatsapp_mora VARCHAR(2) DEFAULT 'NO'"); } catch (e) {}

        await pool.execute(`CREATE TABLE IF NOT EXISTS control_chat (
            telefono VARCHAR(100) PRIMARY KEY, 
            usuario VARCHAR(50), 
            id_cliente_int INT,
            modo VARCHAR(20) DEFAULT 'bot', 
            datos TEXT DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        try { await pool.execute("ALTER TABLE control_chat ADD COLUMN datos TEXT DEFAULT NULL AFTER modo"); } catch (e) {}
        
        await pool.execute(`CREATE TABLE IF NOT EXISTS historial_chat (
            id INT AUTO_INCREMENT PRIMARY KEY, 
            telefono VARCHAR(100), 
            rol ENUM('user', 'model'), 
            contenido TEXT, 
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS recordatorios_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_factura INT NOT NULL,
            nivel INT NOT NULL,
            fecha_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_recordatorio (id_factura, nivel)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS envio_vendedor_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha_envio DATE NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS envio_estadisticas_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha_envio DATE NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS recordatorio_visita_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_cliente INT NOT NULL,
            semana_inicio DATE NOT NULL,
            fecha_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_visita_cliente_semana (id_cliente, semana_inicio)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS bot_config (
            clave VARCHAR(80) PRIMARY KEY,
            valor MEDIUMTEXT,
            actualizado TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        try { await poolLocal.execute(`CREATE TABLE IF NOT EXISTS bot_config (
            clave VARCHAR(80) PRIMARY KEY,
            valor MEDIUMTEXT,
            actualizado TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`); } catch (e) {}

        await pool.execute(`CREATE TABLE IF NOT EXISTS tab_visitas (
            id_visita INT AUTO_INCREMENT PRIMARY KEY,
            fecha_reg DATE NOT NULL,
            rif VARCHAR(50) DEFAULT '',
            id_cliente INT DEFAULT 0,
            nombres VARCHAR(150) DEFAULT '',
            direccion VARCHAR(200) DEFAULT '',
            telefono VARCHAR(50) DEFAULT '',
            celular VARCHAR(50) DEFAULT '',
            id_vendedor INT DEFAULT 0,
            nombre VARCHAR(100) DEFAULT '',
            direcciongooglemap VARCHAR(150) DEFAULT '',
            zona VARCHAR(150) DEFAULT '',
            visita_realizada VARCHAR(10) DEFAULT 'NO',
            contador_visitas INT DEFAULT 1,
            motivo VARCHAR(100) DEFAULT '',
            logro VARCHAR(10) DEFAULT 'NO',
            acuerdo_visita DATE DEFAULT NULL,
            dias_frecuencia INT DEFAULT 0,
            interes_producto VARCHAR(10) DEFAULT 'SI'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        // Migración: eliminar duplicados en tab_agenda_visitas y agregar UNIQUE(id_cliente, fecha)
        try {
            await pool.execute(`
                DELETE a FROM tab_agenda_visitas a
                INNER JOIN tab_agenda_visitas b
                ON a.id_cliente = b.id_cliente AND a.fecha = b.fecha AND a.id_agenda > b.id_agenda
            `);
            try { await pool.execute("ALTER TABLE tab_agenda_visitas ADD UNIQUE INDEX uq_cliente_fecha (id_cliente, fecha)"); } catch (e) {}
        } catch (e) { console.log("[DB] Migración agenda remota:", e.message); }
        try {
            await poolLocal.execute(`
                DELETE a FROM tab_agenda_visitas a
                INNER JOIN tab_agenda_visitas b
                ON a.id_cliente = b.id_cliente AND a.fecha = b.fecha AND a.id_agenda > b.id_agenda
            `);
            try { await poolLocal.execute("ALTER TABLE tab_agenda_visitas ADD UNIQUE INDEX uq_cliente_fecha (id_cliente, fecha)"); } catch (e) {}
        } catch (e) { console.log("[DB] Migración agenda local:", e.message); }

        // TABLAS PARA PEDIDOS — con try/catch por si no hay permisos CREATE
        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS tab_pedidos (
                id_factura INT AUTO_INCREMENT PRIMARY KEY,
                nro_factura INT NOT NULL,
                fecha_reg DATE,
                nombres VARCHAR(150),
                celular VARCHAR(50),
                total DECIMAL(12,2) DEFAULT 0,
                id_vendedor INT DEFAULT 0,
                vendedor VARCHAR(100),
                sub_vendedor VARCHAR(100),
                celular_vendedor VARCHAR(50),
                pagada VARCHAR(2) DEFAULT 'NO',
                anulado VARCHAR(5) DEFAULT 'no'
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
            console.log("[DB] ✅ tab_pedidos OK");
        } catch (e) { console.log("[DB] tab_pedidos CREATE falló:", e.message); }

        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS tab_pedidos_reng (
                id_renglon INT AUTO_INCREMENT PRIMARY KEY,
                id_factura INT,
                nro_reglon INT,
                producto VARCHAR(50),
                cantidad INT,
                precio_unitario DECIMAL(12,2),
                precio_total DECIMAL(12,2),
                tipo VARCHAR(50),
                fecha_reg DATE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
            console.log("[DB] ✅ tab_pedidos_reng OK");
        } catch (e) { console.log("[DB] tab_pedidos_reng CREATE falló:", e.message); }

        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS orden (
                order_id INT AUTO_INCREMENT PRIMARY KEY,
                customer_id INT,
                cedula VARCHAR(20),
                nombres VARCHAR(150),
                direccion VARCHAR(200),
                celular VARCHAR(50),
                id_vendedor INT DEFAULT 0,
                vendedor VARCHAR(100),
                total_price DECIMAL(12,2) DEFAULT 0,
                created DATETIME,
                modified DATETIME,
                status VARCHAR(2) DEFAULT '1',
                facturado VARCHAR(5) DEFAULT 'NO',
                pendiente VARCHAR(5) DEFAULT 'NO',
                forma_de_pago VARCHAR(20) DEFAULT '',
                facturar VARCHAR(5) DEFAULT '',
                comentarios TEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
            console.log("[DB] ✅ orden OK");
        } catch (e) { console.log("[DB] orden CREATE falló:", e.message); }

        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS orden_articulos (
                id_articulo INT AUTO_INCREMENT PRIMARY KEY,
                order_id INT,
                product_id INT DEFAULT 0,
                producto VARCHAR(50),
                descripcion VARCHAR(200),
                quantity INT,
                precio_unitario DECIMAL(12,2),
                almacen VARCHAR(50) DEFAULT ''
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`);
            console.log("[DB] ✅ orden_articulos OK");
        } catch (e) { console.log("[DB] orden_articulos CREATE falló:", e.message); }

        // Migración: agregar columnas faltantes en tab_pedidos
        try { await pool.execute("ALTER TABLE tab_pedidos ADD COLUMN sub_vendedor VARCHAR(100) AFTER vendedor"); } catch (e) {}
        try { await pool.execute("ALTER TABLE tab_pedidos ADD COLUMN celular_vendedor VARCHAR(50) AFTER sub_vendedor"); } catch (e) {}

        console.log("✅ Base de Datos vinculada.");
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
}

async function getSesion(jid) {
    const [r] = await pool.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
    return r[0] || null;
}

async function guardarUsuario(jid, usuario, id_int) {
    await pool.execute(`
        INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) 
        VALUES (?, ?, ?, 'bot') 
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'
    `, [jid, usuario, id_int]);
}

async function buscarCliente(rifLimpio) {
    const soloNum = soloNumerosRIF(rifLimpio);
    if (!soloNum) return null;
    const numEntero = parseInt(soloNum, 10) || 0;
    const [r] = await pool.execute(
        `SELECT id_cliente, nombres, celular, cedula, direccion, zona, TRIM(clave) as rif FROM tab_clientes
         WHERE TRIM(clave) = ?
            OR CAST(REPLACE(TRIM(clave), ' ', '') AS UNSIGNED) = ?
            OR REPLACE(TRIM(clave), ' ', '') LIKE ?
         ORDER BY (TRIM(clave) = ?) DESC
         LIMIT 1`,
        [soloNum, numEntero, `%${soloNum}%`, soloNum]
    );
    return r[0] || null;
}

async function obtenerPorcentaje() {
    try {
        const [r] = await pool.execute("SELECT porcentaje FROM tab_porcentaje LIMIT 1");
        if (r.length > 0) return parseFloat(r[0].porcentaje) || 1;
    } catch (e) {}
    return 1;
}

async function buscarProductoPorCodigo(codigo) {
    const codLimpio = codigo.trim();
    const candidatos = [codLimpio, ...variantesCodigoOcr(codLimpio)];
    try {
        const sql = `SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE producto = ? LIMIT 1`;
        for (const cand of candidatos) {
            const [rows] = await pool.execute(sql, [cand]);
            if (rows.length > 0) return rows;
        }
        if (/^\d+$/.test(codLimpio)) {
            const [rows2] = await pool.execute(`SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE producto LIKE ? LIMIT 1`, [`%${codLimpio}%`]);
            if (rows2.length > 0) return rows2;
        }
        for (const cand of candidatos.slice(1)) {
            const [rows3] = await pool.execute(`SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE producto LIKE ? LIMIT 1`, [`%${cand}%`]);
            if (rows3.length > 0) return rows3;
        }
    } catch (e) {
        console.log("Error buscando por código exacto:", e.message);
    }
    return null;
}

async function obtenerTop10() {
    try {
        const sql = `SELECT r.producto, p.descripcion, p.precio_minimo, SUM(r.cantidad) as total_vendido FROM tab_facturas_reng r JOIN tab_facturas f ON f.nro_factura = r.id_factura JOIN tab_productos p ON p.producto = r.producto WHERE f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND f.anulado = 'no' GROUP BY r.producto ORDER BY total_vendido DESC LIMIT 10`;
        const [rows] = await pool.execute(sql);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("Error Top10 id_factura:", e.message); }
    try {
        const sql = `SELECT r.producto, p.descripcion, p.precio_minimo, SUM(r.cantidad) as total_vendido FROM tab_facturas_reng r JOIN tab_facturas f ON f.nro_factura = r.id_facturas JOIN tab_productos p ON p.producto = r.producto WHERE f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND f.anulado = 'no' GROUP BY r.producto ORDER BY total_vendido DESC LIMIT 10`;
        const [rows] = await pool.execute(sql);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("Error Top10 id_facturas:", e.message); }
    return null;
}

async function buscarProductoPorTexto(texto) {
    // === REEMPLAZO DE MODELOS ESPECÍFICOS SOLICITADOS ===
    let textoBuscado = texto;
    textoBuscado = textoBuscado.replace(/ECOSPORT/gi, "ECO EXPORT");
    textoBuscado = textoBuscado.replace(/GRANCHEROKEE|GRANDCHEROKEE/gi, "GRAND CHEROKEE");
    textoBuscado = textoBuscado.replace(/GRANBLAZER|GRANDVLAZER/gi, "GRAND BLAZER");
    textoBuscado = textoBuscado.replace(/GRANVITARA|GRANDVITARA/gi, "GRAND VITARA");
        textoBuscado = textoBuscado.replace(/SUPER\s*CARRY/gi, "SUPER CARRY");
    const txtNormal = normalizar(textoBuscado);
    // ====================================================

    const stopWords = [
        'tienes', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde',
        'precio', 'tienen', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para',
        'busco', 'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'como', 'estas',
        'esta', 'familia', 'espero', 'encuentres', 'encuenters', 'bien', 'queria',
        'preguntarte', 'gracias', 'por', 'favor', 'ayuda', 'puedes', 'podrias',
        'quisiera', 'necesito', 'saludos', 'cordial', 'muchas', 'todo', 'bienvenidos',
        'bendiciones', 'exito', 'exitos', 'dia', 'tarde', 'noche', 'pregunta', 'consulta',
        'atento', 'atenta', 'saludo', 'estimados', 'estimado', 'buen', 'buena', 'bueno',
        'se', 'me', 'le', 'te', 'lo', 'los', 'las', 'les', 'su', 'sus', 'mi', 'mis',
        'tu', 'tus', 'nos', 'os', 'que', 'cual', 'cuales', 'quien', 'quienes',
        'cuando', 'porque', 'pues', 'pero', 'mas', 'muy', 'asi', 'aun', 'entre', 'sin',
        'sobre', 'tras', 'durante', 'mediante', 'excepto', 'segun', 'puede', 'puedo',
        'pueden', 'podemos', 'podria', 'hacer', 'hace', 'hacen', 'ser', 'estar', 'tener',
        'tengo', 'tenemos', 'tiene', 'decir', 'dice', 'dicen', 'digo', 'ver', 'veo',
        'ven', 'vez', 'veces', 'quiero', 'quiere', 'quieren', 'queremos', 'gustaria',
        'gusta', 'gustan', 'gusto', 'necesita', 'necesitan', 'necesitamos', 'pueda','UNID.','unid.','unidades','unidad','UNIDADES','unidades',
        'puedas', 'pudiera', 'pudieras', 'listo', 'claro', 'ok', 'okey', 'vale', 'va',
        'vamos', 'vaya', 'algun', 'alguna', 'algunos', 'algunas', 'ningun', 'ninguna',
        'tipo', 'tipos', 'preguntar', 'disculpa', 'disculpe', 'permiso', 'ayudar',
        'apoyo', 'consulta', 'consultar', 'info', 'informacion', 'decirme', 'dime',
        'avísame', 'avisa', 'saber', 'sabes', 'saben', 'sabemos',
        'pana', 'panas', 'brother', 'bro', 'amigo', 'amigos', 'compa', 'compadre',
        'ando', 'andas', 'andan', 'andaba', 'andabas', 'andabamos', 'andaban',
        'estoy', 'estas', 'esta', 'estaba', 'estabas', 'estabamos', 'estaban',
        'vengo', 'vienes', 'viene', 'vienen', 'venia', 'venias', 'veniamos', 'venian',
        'voy', 'vas', 'va', 'vamos', 'van', 'iba', 'ibas', 'ibamos', 'iban',
        'llegando', 'pais', 'país', 'atento',
        'enviaras', 'existencia', 'existencias', 'enviar', 'enviame', 'mandame', 'mándame', 
        'envíame', 'disponibilidad', 'ver', 'buscar', 'repuesto', 'repuestos', 'catalogo', 'catálogo',
        'tendra', 'tendras', 'tendran', 'tendria', 'tendrias', 'tendrian', 'tendriamos','tendremos'
    ];

    const palabrasBase = txtNormal.split(' ')
        .filter(p => p.length > 2 && !stopWords.includes(p));

    if (palabrasBase.length === 0) return null;

    const positionalWords = ['superior', 'sup', 'inferior', 'inf', 'interno', 'int', 'externo', 'ext', 'derecha', 'der', 'izquierda', 'izq'];
    const isOnlyPositional = palabrasBase.every(p => positionalWords.includes(p));
    if (isOnlyPositional) return null;

    const expandirFormas = (pal) => {
        const f = [pal];
        if (pal.endsWith('es') && pal.length > 4) f.push(pal.slice(0, -2));
        if (pal.endsWith('s') && pal.length > 3 && !pal.endsWith('es')) f.push(pal.slice(0, -1));
        if (!pal.endsWith('s')) {
            f.push(pal + 's');
            if (pal.endsWith('z')) f.push(pal.slice(0, -1) + 'ces');
        }
        if (pal.endsWith('a') && pal.length > 4) f.push(pal.slice(0, -1) + 'o');
        if (pal.endsWith('o') && pal.length > 4) f.push(pal.slice(0, -1) + 'a');
        return [...new Set(f)];
    };
    
    let whereClause = "";
    let queryParams = [];

    palabrasBase.forEach((pal, index) => {
        const formas = expandirFormas(pal);
        const conditions = formas.map(() => "descripcion LIKE ?");
        whereClause += `(${conditions.join(" OR ")})`;
        if (index < palabrasBase.length - 1) whereClause += " AND ";
        formas.forEach(f => queryParams.push(`%${f}%`));
    });

    try {
        const sql = `SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE activo = 'si' AND (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0) > 0 OR COALESCE(cantidad_fabricando,0) > 0) AND (${whereClause}) LIMIT 8`;
        const [rows] = await pool.execute(sql, queryParams);
        if (rows.length > 0) return rows;
    } catch (e) {
        console.log("Error Intento 1:", e.message);
    }

    let minRelevance = palabrasBase.length;
    if (palabrasBase.length >= 2) {
        minRelevance = Math.max(1, palabrasBase.length - 1);
    }

    const expandedTerms = [...new Set(palabrasBase.flatMap(expandirFormas))];
    const orConditions = expandedTerms.map(() => "descripcion LIKE ?");
    const orParams = expandedTerms.map(p => `%${p}%`);

    const relevanceParts = palabrasBase.map(p => {
        const formas = expandirFormas(p);
        const cases = formas.map(f => `descripcion LIKE '%${f.replace(/[^a-z]/g, '')}%'`);
        return `(CASE WHEN ${cases.join(' OR ')} THEN 1 ELSE 0 END)`;
    });
    const relevanceSQL = relevanceParts.join(' + ');

    try {
        const sqlRelevancia = `
            SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando
            FROM tab_productos 
            WHERE activo = 'si' AND (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0) > 0 OR COALESCE(cantidad_fabricando,0) > 0) AND (${orConditions.join(" OR ")})
            HAVING (${relevanceSQL}) >= ? 
            ORDER BY ${relevanceSQL} DESC 
            LIMIT 8`;
            
        const [rows] = await pool.execute(sqlRelevancia, [...orParams, minRelevance]);
        if (rows.length > 0) return rows;
    } catch (e) {
        console.log("Error Intento 2:", e.message);
    }

    if (minRelevance > 1 && palabrasBase.length > 1) {
        try {
            const sqlCatchall = `SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE activo = 'si' AND (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0) > 0 OR COALESCE(cantidad_fabricando,0) > 0) AND (${orConditions.join(" OR ")}) HAVING (${relevanceSQL}) >= 1 ORDER BY ${relevanceSQL} DESC LIMIT 8`;
            const [rows] = await pool.execute(sqlCatchall, [...orParams]);
            if (rows.length > 0) return rows;
        } catch (e) {
            console.log("Error Intento 3:", e.message);
        }
    }

    return null;
}

// ===== MULTI-ITEM ORDER FUNCTIONS =====

function parseMultiItemMessage(rawText) {
    if (!rawText || rawText.length < 10 || rawText.length > 1000) return null;
    let text = rawText.replace(/\s+y\s+/gi, ',').trim();
    const items = [];
    const parts = text.split(/(?=\b\d{1,4}\s+[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ])/);
    for (const part of parts) {
        const m = part.match(/^\s*(\d{1,4})\s+(.+)/);
        if (m) {
            let desc = m[2].trim().replace(/[,\s]+$/g, '').replace(/\s+y\s*$/i, '').trim();
            if (desc.length > 2) {
                items.push({ cantidad: parseInt(m[1]), descripcion: desc });
            }
        }
    }
    const txtNormal = normalizar(rawText);
    const tieneKeyword = PRODUCT_KEYWORDS.some(kw => txtNormal.includes(kw));
    return items.length >= 2 && tieneKeyword ? items : null;
}

async function processMultiItemProduct(from, item, multiOrder) {
    const pct = await obtenerPorcentaje();
    multiOrder.pct = pct;
    let prods = null;
    const codCand = (item.descripcion || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (codCand.length >= 3) prods = await buscarProductoPorCodigo(codCand);
    if (!prods || prods.length === 0) prods = await buscarProductoPorTexto(item.descripcion);
    if (!prods || prods.length === 0) {
        multiOrder.resolvedItems.push({ descripcion: item.descripcion, cantidad: item.cantidad, error: true, producto: null });
        multiOrder.currentIndex++;
        await processNextMultiItem(from, multiOrder);
        return;
    }
    if (prods.length === 1) {
        const p = prods[0];
        const stock = parseFloat(p.stock_total || 0);
        const fabricando = parseFloat(p.cantidad_fabricando || 0);
        if (stock <= 0) {
            // Sin stock: agregar como error indicando fabricación o agotado
            const motivo = fabricando > 0 ? `🚚 En fabricación/tránsito` : `❌ Agotado`;
            multiOrder.resolvedItems.push({ descripcion: item.descripcion, cantidad: item.cantidad, codigo: p.producto, error: true, motivo });
            multiOrder.currentIndex++;
            await processNextMultiItem(from, multiOrder);
            return;
        }
        const precio = parseFloat(p.precio_minimo || 0) / pct;
        multiOrder.resolvedItems.push({ descripcion: item.descripcion, cantidad: item.cantidad, codigo: p.producto, tipo: p.tipo, precio: precio, producto: p, error: false });
        multiOrder.currentIndex++;
        await processNextMultiItem(from, multiOrder);
        return;
    }
    let msg = `🔍 *Producto ${multiOrder.currentIndex + 1} de ${multiOrder.items.length}:* "${item.descripcion}"\n(Cantidad: ${item.cantidad})\n\n`;
    prods.slice(0, 8).forEach((p, i) => {
        const precio = parseFloat(p.precio_minimo || 0) / pct;
        const stock = parseFloat(p.stock_total || 0);
        let estado = stock > 0 ? "✅" : (parseFloat(p.cantidad_fabricando || 0) > 0 ? "🚚" : "❌");
        msg += `*${i+1}.* ${p.producto} — *$${precio.toFixed(2)}* ${estado}\n   ${p.descripcion.substring(0, 55)}${p.descripcion.length > 55 ? '...' : ''}\n`;
    });
    msg += `\n📌 Responde el *número* del producto para este ítem.\n_O responde 0 para omitir_`;
    pendingProductSelection.set(from, { productos: prods.slice(0, 8), pct, multiItem: true });
    await safeSendMessage(from, { text: msg });
}

async function processNextMultiItem(from, multiOrder) {
    if (multiOrder.currentIndex >= multiOrder.items.length) {
        await showMultiItemQuotation(from, multiOrder);
        return;
    }
    const item = multiOrder.items[multiOrder.currentIndex];
    await processMultiItemProduct(from, item, multiOrder);
}

async function showMultiItemQuotation(from, multiOrder) {
    const okItems = multiOrder.resolvedItems.filter(it => !it.error);
    const errorItems = multiOrder.resolvedItems.filter(it => it.error);
    if (okItems.length === 0) {
        await safeSendMessage(from, { text: "❌ No se pudo identificar ningún producto de tu pedido. Intenta con descripciones más detalladas." });
        multiItemOrders.delete(from);
        return;
    }
    await setSesionDatos(from, { tipo: 'esperando_cliente_multi', okItems, errorItems, vendedor: multiOrder.vendedor, pushName: multiOrder.pushName, pct: multiOrder.pct });
    await setModo(from, 'esperando_cliente_multi');
    multiItemOrders.delete(from);
    await safeSendMessage(from, { text: `🔍 *Productos identificados.*\n\n❓ *¿Para qué cliente es este pedido?*\nEscriba el nombre o razón social del cliente.` });
}

async function obtenerDetalleFacturas(id_cliente, id_vendedor = null) {
    let query = `
        SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.descuento, f.total_desc,
                c.nombres, c.direccion, c.cedula, c.celular, c.telefono, c.id_cliente, c.zona, c.vendedor as nombre_vendedor
         FROM tab_facturas f
         JOIN tab_clientes c ON f.id_cliente = c.id_cliente
         WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'`;
    let params = [id_cliente];
    if (id_vendedor) { query += ` AND f.id_vendedor = ?`; params.push(id_vendedor); }
    const [facturas] = await pool.execute(query, params);
    return facturas;
}

// Pide el RIF del cliente (con o sin letra) y guarda el estado de la consulta.
async function iniciarConsultaFactura(from, pushName) {
    pendienteFactura.set(from, { paso: 'rif' });
    const nombre = pushName || 'Estimado/a';
    return await safeSendMessage(from, { text: `🔎 *${nombre}*, para mostrarle el *monto a pagar* de las facturas de un cliente necesito su *RIF*.\n\n📌 Puede enviarlo con o sin la letra, por ejemplo: *J-123456789* o simplemente *123456789*.\n\n_Escriba *cancelar* para salir._` });
}

// Procesa la respuesta del RIF y lista las facturas pendientes numeradas.
async function procesarRIFConsulta(from, rawText, text) {
    const estado = pendienteFactura.get(from);
    if (!estado) return null;
    const cancelWords = ['cancelar', 'cancela', 'salir', 'no', 'nada'];
    if (cancelWords.includes(text)) {
        pendienteFactura.delete(from);
        await safeSendMessage(from, { text: "❌ Consulta de facturas cancelada." });
        return true;
    }
    if (estado.paso === 'rif') {
        const rifLimpio = limpiarRIF(rawText);
        if (!rifLimpio || rifLimpio.length < 6) {
            await safeSendMessage(from, { text: "❌ Ese RIF no parece válido. Envíe el RIF del cliente (ej: *J-123456789*) o *cancelar*." });
            return true;
        }
        const c = await buscarCliente(rifLimpio);
        if (!c) {
            await safeSendMessage(from, { text: `❌ No encontré ningún cliente con el RIF *${rifLimpio}*.\n\nVerifique e intente de nuevo, o escriba *cancelar*.` });
            return true;
        }
        const facturas = await obtenerDetalleFacturas(c.id_cliente);
        if (facturas.length === 0) {
            pendienteFactura.delete(from);
            await safeSendMessage(from, { text: `✅ El cliente *${c.nombres}* no tiene facturas pendientes por pagar.` });
            return true;
        }
        let listado = `⭐ *FACTURAS PENDIENTES*\nCliente: *${c.nombres}*\nRIF: ${rifLimpio}\n\n`;
        facturas.forEach((f, i) => {
            const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
            listado += `*${i + 1}.* *#${f.nro_factura}* | *$${monto.toFixed(2)}*\n`;
        });
        listado += `\n📌 Responda el *número* de la factura para ver el monto a pagar y la factura firmada.`;
        pendienteFactura.set(from, { paso: 'elegir', cliente: c, facturas });
        await safeSendMessage(from, { text: listado });
        return true;
    }
    if (estado.paso === 'elegir') {
        if (!/^\d+$/.test(text)) {
            await safeSendMessage(from, { text: "❌ Responda el *número* de la factura o escriba *cancelar*." });
            return true;
        }
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= estado.facturas.length) {
            await safeSendMessage(from, { text: "❌ Número inválido. Elija un número de la lista o escriba *cancelar*." });
            return true;
        }
        const f = estado.facturas[idx];
        const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
        const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
        const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent((f.nombres||'').trim())}&nombre=${encodeURIComponent((f.nombre_vendedor||'').trim())}&direccion=${encodeURIComponent((f.direccion||'').trim())}&cedula=${(f.cedula||'').trim()}&celular=${encodeURIComponent((f.celular||'').trim())}&telefono=${encodeURIComponent((f.telefono||'').trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent((f.zona||'').trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
        pendienteFactura.delete(from);
        await safeSendMessage(from, { text: `📄 *Factura #${f.nro_factura}*\n\n💰 *Monto a pagar: $${monto.toFixed(2)}*\n📅 Fecha: ${fReg}\n\n✍️ *Factura firmada:*\nhttps://www.one4cars.com/uploads/notas/${f.nro_factura}.jpg\n\n📄 *Reporte completo:*\nhttps://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}` });
        return true;
    }
    return null;
}

async function actualizarDolar() {
    if (!proceActivo('dolar')) return;
    try {
        const resOficial = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 7000 });
        if (resOficial.data) dolarInfo.bcv = parseFloat(resOficial.data.promedio).toFixed(2);
        const resParalelo = await axios.get('https://ve.dolarapi.com/v1/dolares/paralelo', { timeout: 7000 });
        if (resParalelo.data) dolarInfo.paralelo = parseFloat(resParalelo.data.promedio).toFixed(2);
    } catch (e) { console.log("Error Dolar API"); }
    try {
        const binanceResp = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
            { asset: 'USDT', fiat: 'VES', tradeType: 'BUY', page: 1, rows: 3, payTypes: [] },
            { headers: { 'Content-Type': 'application/json;charset=utf-8', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 7000 });
        const ads = binanceResp.data && binanceResp.data.data;
        if (Array.isArray(ads) && ads.length > 0) {
            let mejor = Infinity;
            for (const a of ads) { const p = parseFloat(a.adv && a.adv.price); if (!isNaN(p) && p < mejor) mejor = p; }
            if (mejor < Infinity) dolarInfo.binance = mejor.toFixed(2);
        }
    } catch (e) { console.log("Error Dolar Binance P2P"); }
}

// ===== NOTIFICADOR DE FACTURAS NUEVAS =====
let notificadorEjecutando = false;
const MAX_FACTURAS_POR_CICLO = 5; // Máximo de facturas nuevas por cada ciclo de 45 seg
const DELAY_ENTRE_FACTURAS_MS = 8000; // 8 segundos entre cada factura para parecer humano

// Marca como notificadas todas las facturas viejas al iniciar el bot para evitar envíos masivos
async function marcarFacturasViejasComoNotificadas() {
    try {
        const [result] = await dualExecute(
            `UPDATE tab_facturas SET whatsapp_notificado = 'SI'
             WHERE whatsapp_notificado = 'NO' AND anulado = 'no' AND pagada = 'NO'
               AND fecha_reg < DATE_SUB(CURDATE(), INTERVAL 2 DAY)`
        );
        if (result.affectedRows > 0) {
            console.log(`[STARTUP] ⚠️ ${result.affectedRows} factura(s) antigua(s) marcada(s) como notificada(s) para evitar reenvío masivo.`);
        }
    } catch (e) {
        console.log("[STARTUP] Error marcando facturas viejas:", e.message);
    }
}

async function checkNuevasFacturas() {
    if (!isBotReady() || notificadorEjecutando) return;
    if (!proceActivo('notificador')) {
        notificadorEjecutando = false;
        return;
    }
    notificadorEjecutando = true;
    try {
        const [facturas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular, f.total, f.abono_factura, f.porcentaje, f.fecha_reg, f.id_cliente, f.id_vendedor,
                    v.celular_vendedor, v.nombre as vendedor_nombre
             FROM tab_facturas f
             LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
             WHERE f.whatsapp_notificado = 'NO' AND f.anulado = 'no' AND f.pagada = 'NO'
               AND f.fecha_reg >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
             ORDER BY f.id_factura ASC
             LIMIT ?`,
            [MAX_FACTURAS_POR_CICLO]
        );
        let enviados = 0;
        for (const f of facturas) {
            const jid = formatWhatsApp(f.celular);
            if (!jid) {
                await dualExecute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [f.id_factura]);
                continue;
            }
            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            let montoNotif = parseFloat(f.total) / (parseFloat(f.porcentaje) || 1);
            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                montoNotif = montoNotif / 0.80;
            }
            const msg = `🧾 *NUEVA FACTURA REGISTRADA*\n\nHola *${f.nombres}*, se ha registrado una nueva factura en nuestro sistema:\n\n🔹 *N°:* ${f.nro_factura}\n🔹 *Monto:* $${montoNotif.toFixed(2)}\n🔹 *Fecha:* ${fecha}\n\nPuede consultar su estado de cuenta en:\nhttps://www.one4cars.com/estado_de_cuenta.php/`;
            await safeSendMessage(jid, { text: msg });
            enviados++;

            if (f.celular_vendedor) {
                const jidV = formatWhatsApp(f.celular_vendedor);
                if (jidV) {
                    const msgV = `📢 *NUEVA FACTURA DE SU CLIENTE*\n\nVendedor: *${f.vendedor_nombre || 'N/A'}*\nCliente: *${f.nombres}*\n\n🔹 *N° Factura:* ${f.nro_factura}\n🔹 *Monto:* $${montoNotif.toFixed(2)}\n🔹 *Fecha:* ${fecha}`;
                    await safeSendMessage(jidV, { text: msgV });
                }
            }

            await dualExecute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [f.id_factura]);
            await humanDelay(6, 12); // Delay humano entre cada factura
        }
        if (enviados > 0) {
            console.log(`[NOTIFICADOR] ${enviados} factura(s) notificada(s).`);
        }
    } catch (e) {
        console.log("[NOTIFICADOR] Error:", e.message);
    } finally {
        notificadorEjecutando = false;
    }
}

// ===== RECORDATORIOS DE FACTURAS VENCIDAS =====
let recordatorioEjecutando = false;
let primerEjecucionRecordatorio = true; // Evita disparar recordatorios al arrancar
const MAX_RECORDATORIOS_POR_CICLO = 10; // Máximo recordatorios por cada ejecución diaria

function obtenerNivelRecordatorio(dias) {
    if (dias >= 60) return 60;
    if (dias >= 50) return 50;
    if (dias >= 40) return 40;
    if (dias >= 30) return 30;
    return null;
}

function obtenerTonoMensaje(nivel, f, monto, fecha, dias) {
    const saldoDivisas = parseFloat(f.total) - parseFloat(f.abono_factura || 0);
    const bcv = monto;
    if (nivel >= 60) {
        return pickTemplate(MESSAGE_TEMPLATES.cobranza60)(f.nombres, f.nro_factura, saldoDivisas.toFixed(2), dias, bcv.toFixed(2));
    }
    return `🧾 *RECORDATORIO DE PAGO*\n\nHola *${f.nombres}*, le recordamos amablemente que la factura *N° ${f.nro_factura}* con fecha *${fecha}* presenta un saldo pendiente de *$${saldoDivisas.toFixed(2)}* en divisas (*Bs. ${bcv.toFixed(2)}* a tasa BCV).\n\nLe agradecemos gestionar el pago para mantener su cuenta al día. Estamos a su disposición para cualquier consulta. 🚗`;
}

async function checkFacturasVencidas() {
    if (!isBotReady() || recordatorioEjecutando) return;
    if (!proceActivo('recordatorio')) return;
    if (primerEjecucionRecordatorio) {
        primerEjecucionRecordatorio = false;
        console.log("[RECORDATORIO] Primera ejecución omitida (startup guard).");
        return;
    }
    recordatorioEjecutando = true;
    try {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();
        let cont = 0;

        for (const f of facturas) {
            if (cont >= MAX_RECORDATORIOS_POR_CICLO) {
                console.log(`[RECORDATORIO] Límite de ${MAX_RECORDATORIOS_POR_CICLO} alcanzado, el resto se enviará mañana.`);
                break;
            }
            const dias = f.dias_vencida;
            const nivel = obtenerNivelRecordatorio(dias);
            if (!nivel) continue;

            let monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                monto = monto / 0.80;
            }
            if (monto <= 0) continue;

            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            const yaEnviado = enviados[f.id_factura] && enviados[f.id_factura].includes(nivel);
            if (!yaEnviado) {
                const jid = formatWhatsApp(f.celular);
                if (jid) {
                    const msg = obtenerTonoMensaje(nivel, f, monto, fecha, dias);
                    await safeSendMessage(jid, { text: msg });
                }
                await notificador.marcarRecordatorio(f.id_factura, nivel);
                cont++;
                await humanDelay(25, 50); // Delay más largo entre recordatorios
            }
        }

        if (cont > 0) {
            console.log(`[RECORDATORIO] ${cont} cliente(s) notificado(s).`);
        }
    } catch (e) {
        console.log("[RECORDATORIO] Error:", e.message);
    } finally {
        recordatorioEjecutando = false;
    }
}

// ===== RECORDATORIO A VENDEDORES (COBRANZAS) =====
let vendedorEjecutando = false;
let primerEjecucionVendedor = true;

async function checkVendedoresRecordatorio(force = false) {
    if (!isBotReady() || vendedorEjecutando) return;
    if (!proceActivo('cobranza') && !force) return;
    if (!force && primerEjecucionVendedor) {
        primerEjecucionVendedor = false;
        console.log("[VENDEDORES] Primera ejecución omitida (startup guard).");
        return;
    }
    primerEjecucionVendedor = false;
    vendedorEjecutando = true;
    try {
        const hoy = new Date().getDay();
        
        if (!force && (hoy === 0 || hoy === 6)) {
            vendedorEjecutando = false;
            return;
        }

        const ultimo = await notificador.obtenerUltimoEnvioVendedor();
        if (!force && ultimo) {
            const diff = Math.floor((new Date() - new Date(ultimo)) / 86400000);
            if (diff < 3) {
                vendedorEjecutando = false;
                return;
            }
        }

        const facturas = await notificador.obtenerFacturasVencidasAll();
        const vendedoresMap = {};

        for (const f of facturas) {
            const dias = f.dias_vencida;
            if (dias < 30) continue;

            let monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0 || !f.celular_vendedor) continue;

            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                monto = monto / 0.80;
            }

            const key = f.celular_vendedor.toString().replace(/\D/g, '');
            if (!vendedoresMap[key]) {
                vendedoresMap[key] = {
                    nombre: f.vendedor_nombre || 'Vendedor',
                    jid: formatWhatsApp(f.celular_vendedor),
                    facturas: []
                };
            }
            vendedoresMap[key].facturas.push(`🔹 *N° ${f.nro_factura}* - ${f.nombres} - $${monto.toFixed(2)} (${dias} días)`);
        }

        for (const key of Object.keys(vendedoresMap)) {
            const v = vendedoresMap[key];
            if (!v.jid || v.facturas.length === 0) continue;
            const msg = `📢 *RESUMEN DE CLIENTES VENCIDOS*\n\nVendedor: *${v.nombre}*\n\n${v.facturas.join('\n')}\n\nLe recordamos la importancia de gestionar estos cobros para mantener la rotación de productos.`;
            await safeSendMessage(v.jid, { text: msg });
            await humanDelay(15, 30);
        }

        if (!force) {
            await notificador.marcarEnvioVendedor();
        }
        console.log(`[VENDEDORES] ${Object.keys(vendedoresMap).length} vendedor(es) notificado(s) por cobranzas.`);
    } catch (e) {
        console.log("[VENDEDORES] Error:", e.message);
    } finally {
        vendedorEjecutando = false;
    }
}

// ===== ENVIO DE ESTADISTICAS A CADA VENDEDOR =====
let estadisticasEjecutando = false;
let primerEjecucionEstadisticas = true;

async function checkEstadisticasVendedores(force = false) {
    if (!isBotReady()) {
        console.log("[ESTADISTICAS] Bot no está listo para enviar estadísticas.");
        return;
    }
    if (!proceActivo('estadisticas') && !force) {
        estadisticasEjecutando = false;
        return;
    }
    if (!force && primerEjecucionEstadisticas) {
        primerEjecucionEstadisticas = false;
        console.log("[ESTADISTICAS] Primera ejecución omitida (startup guard).");
        return;
    }
    primerEjecucionEstadisticas = false;
    // Si se fuerza, ignoramos completamente si está bloqueado
    if (estadisticasEjecutando && !force) {
        console.log("[ESTADISTICAS] Omitido porque ya se encuentra en ejecución.");
        return;
    }
    
    estadisticasEjecutando = true;
    console.log(`[ESTADISTICAS] Iniciando proceso de envío (Force manual: ${force})...`);

    try {
        const hoyDate = new Date();
        const hoyDay = hoyDate.getDay(); 
        const hoyStr = hoyDate.toISOString().split('T')[0];
        
        if (!force) {
            if (hoyDay !== 1) {
                estadisticasEjecutando = false;
                return;
            }
            const [log] = await pool.execute("SELECT id FROM envio_estadisticas_log WHERE fecha_envio = ?", [hoyStr]);
            if (log.length > 0) {
                estadisticasEjecutando = false;
                return;
            }
        }

        // Filtra solo a los vendedores donde el campo 'activo' dice 'SI'
        const [vendedores] = await pool.execute("SELECT id_vendedor, nombre, celular_vendedor, meta_ventas FROM tab_vendedores WHERE activo = 'SI'");

        for (const v of vendedores) {
            if (!v.celular_vendedor) continue;
            const jid = formatWhatsApp(v.celular_vendedor);
            if (!jid) continue;

            let ventaSemana = 0;
            let ventaMes = 0;
            let porcMeta = "0.00";
            const meta = parseFloat(v.meta_ventas || 0);

            try {
                // 1. Venta última semana (7 días)
                const [rSemana] = await pool.execute(
                    "SELECT SUM(total) as total FROM tab_facturas WHERE id_vendedor = ? AND anulado = 'no' AND fecha_reg >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
                    [v.id_vendedor]
                );
                ventaSemana = parseFloat(rSemana[0]?.total || 0);

                // 2. Venta mes en curso
                const [rMes] = await pool.execute(
                    "SELECT SUM(total) as total FROM tab_facturas WHERE id_vendedor = ? AND anulado = 'no' AND fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
                    [v.id_vendedor]
                );
                ventaMes = parseFloat(rMes[0]?.total || 0);

                // 3. Porcentaje de meta
                porcMeta = meta > 0 ? ((ventaMes / meta) * 100).toFixed(2) : "0.00";
            } catch (errDB) {
                console.log(`[ESTADISTICAS] Error calculando totales para ${v.nombre}: ${errDB.message}`);
            }

            // 4. Porcentaje por tipo de producto (Mes en curso)
            let breakdownTexto = "";
            try {
                const [rTipos] = await pool.execute(
                    `SELECT r.tipo, SUM(r.precio_total) as total_tipo 
                     FROM tab_facturas_reng r 
                     JOIN tab_facturas f ON f.nro_factura = r.id_factura
                     WHERE f.id_vendedor = ? AND f.anulado = 'no' AND f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                     GROUP BY r.tipo`,
                    [v.id_vendedor]
                );

                let totalItemsMes = 0;
                rTipos.forEach(row => { totalItemsMes += parseFloat(row.total_tipo || 0); });

                if (rTipos.length === 0) {
                    breakdownTexto = "🔸 _Sin renglones registrados este mes._\n";
                } else {
                    rTipos.forEach(row => {
                        const tTotal = parseFloat(row.total_tipo || 0);
                        const pct = totalItemsMes > 0 ? ((tTotal / totalItemsMes) * 100).toFixed(2) : "0.00";
                        breakdownTexto += `🔸 *${row.tipo || 'General'}:* ${pct}% _($${tTotal.toFixed(2)})_\n`;
                    });
                }
            } catch (errTipos) {
                try {
                    const [rTipos2] = await pool.execute(
                        `SELECT r.tipo, SUM(r.precio_total) as total_tipo 
                         FROM tab_facturas_reng r 
                         JOIN tab_facturas f ON f.nro_factura = r.id_facturas
                         WHERE f.id_vendedor = ? AND f.anulado = 'no' AND f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                         GROUP BY r.tipo`,
                        [v.id_vendedor]
                    );

                    let totalItemsMes2 = 0;
                    rTipos2.forEach(row => { totalItemsMes2 += parseFloat(row.total_tipo || 0); });

                    if (rTipos2.length === 0) {
                        breakdownTexto = "🔸 _Sin renglones registrados este mes._\n";
                    } else {
                        rTipos2.forEach(row => {
                            const tTotal = parseFloat(row.total_tipo || 0);
                            const pct = totalItemsMes2 > 0 ? ((tTotal / totalItemsMes2) * 100).toFixed(2) : "0.00";
                            breakdownTexto += `🔸 *${row.tipo || 'General'}:* ${pct}% _($${tTotal.toFixed(2)})_\n`;
                        });
                    }
                } catch (e2) {
                    console.log(`[ESTADISTICAS] Error desglose productos para ${v.nombre}`);
                    breakdownTexto = "🔸 _Desglose no disponible._\n";
                }
            }

            // 5. TOP MEJORES CLIENTES DEL VENDEDOR (Mes en curso)
            let clientesTexto = "";
            try {
                const [rClientes] = await pool.execute(
                    `SELECT c.nombres, SUM(f.total) as total_cliente 
                     FROM tab_facturas f 
                     JOIN tab_clientes c ON f.id_cliente = c.id_cliente
                     WHERE f.id_vendedor = ? AND f.anulado = 'no' AND f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                     GROUP BY f.id_cliente, c.nombres 
                     ORDER BY total_cliente DESC 
                     LIMIT 3`,
                    [v.id_vendedor]
                );

                if (rClientes.length === 0) {
                    clientesTexto = "🔹 _Sin transacciones registradas este mes._\n";
                } else {
                    rClientes.forEach((row, index) => {
                        clientesTexto += `👑 *${index + 1}. ${row.nombres.trim()}:* $${parseFloat(row.total_cliente).toFixed(2)}\n`;
                    });
                }
            } catch (errClientes) {
                console.log(`[ESTADISTICAS] Error Top Clientes para ${v.nombre}`);
                clientesTexto = "🔹 _Top clientes no disponible._\n";
            }

            // LÓGICA DE MENSAJE MOTIVACIONAL PERSONALIZADO
            let mensajeMotivacional = "";
            const pctNumerico = parseFloat(porcMeta);

            if (ventaMes === 0) {
                const mensajesCero = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\nCada gran logro comienza con un primer paso. Sabemos que el mercado tiene retos, pero tu capacidad es mayor. ¡Esta semana sal a buscar ese primer cierre que cambie la racha! 💪`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nLas oportunidades están ahí afuera esperando a quien tenga la determinación de tomarlas. Revisa tu estrategia, contacta a tus prospectos y haz que las cosas sucedan. ¡Tú puedes! 🚀`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nUn arranque lento solo significa que estás tomando impulso. No te desanimes, cada "no" te acerca más a un "sí". ¡A romper el hielo esta semana! 🔥`
                ];
                mensajeMotivacional = mensajesCero[Math.floor(Math.random() * mensajesCero.length)];
            } else if (pctNumerico < 50) {
                const mensajesBajo = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\nVas avanzando, pero sabemos que tu potencial es para mucho más. Concéntrate en visitar a esos clientes indecisos y cerrar las ventas pendientes. ¡Sube el ritmo, la meta te espera! 🏃‍♂️💨`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nEl éxito es la suma de pequeños esfuerzos repetidos día tras día. Estás en el camino, ahora toca acelerar. ¡Haz que cada visita cuente y mejora esos números! 📈`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nPara alcanzar metas grandes se requiere un esfuerzo extraordinario. Revisa tus prioridades esta semana y enfócate en los cierres de mayor impacto. ¡Vamos con todo! 💥`
                ];
                mensajeMotivacional = mensajesBajo[Math.floor(Math.random() * mensajesBajo.length)];
            } else if (pctNumerico >= 50 && pctNumerico < 100) {
                const mensajesMedio = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Excelente trabajo! Ya superaste la mitad del camino. Mantén la disciplina y la energía, estás a un paso de alcanzar tu meta. ¡No bajes el ritmo ahora! 🎯👏`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nEl esfuerzo está dando frutos y los números lo demuestran. Ahora es el momento del sprint final. ¡Asegura esos cierres y conquista tu objetivo del mes! 🚀🏆`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Qué buen ritmo llevas! Estás demostrando tu capacidad en el mercado. Mantén el enfoque en tus mejores clientes y asegura llegar al 100%. ¡Tú puedes! 💪✨`
                ];
                mensajeMotivacional = mensajesMedio[Math.floor(Math.random() * mensajesMedio.length)];
            } else {
                const mensajesAlto = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Felicidades! Has superado tu meta. Tu compromiso y habilidad para cerrar ventas son de otro nivel. Ahora el reto es contigo mismo: ¿qué tan lejos puedes llegar? 🥇🔥`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Trabajo sobresaliente! Alcanzar el 100% no es fácil, pero tú lo lograste con excelencia. Sigue brillando y demostrando por qué eres uno de los mejores. ¡A romper récords! 🌟🏆`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Meta superada! Tu dedicación se refleja en estos increíbles números. Disfruta el logro, pero no te detengas, ¡el cielo es el límite para tu talento! 🚀👑`
                ];
                mensajeMotivacional = mensajesAlto[Math.floor(Math.random() * mensajesAlto.length)];
            }

            const msgEstadisticas = `📊 *REPORTE DE ESTADÍSTICAS DE VENTAS*\n\n` +
                `Hola *${v.nombre}*, aquí tienes el resumen de tu rendimiento:\n\n` +
                `📅 *Venta última semana:* $${ventaSemana.toFixed(2)}\n` +
                `📈 *Venta mes en curso:* $${ventaMes.toFixed(2)}\n` +
                `🎯 *Meta asignada:* $${meta.toFixed(2)}\n` +
                `🏁 *Cumplimiento de Meta:* ${porcMeta}%\n\n` +
                `📦 *Ventas por Tipo de Producto (Mes):*\n${breakdownTexto}\n` +
                `🔝 *Tus 3 Mejores Clientes (Mes):*\n${clientesTexto}\n` +
                `${mensajeMotivacional}`;

            await safeSendMessage(jid, { text: msgEstadisticas });
            await sleep(1500); 
        }

        if (!force) {
            await dualExecute("INSERT INTO envio_estadisticas_log (fecha_envio) VALUES (?)", [hoyStr]);
        }
        
        console.log(`[ESTADISTICAS] Reportes individuales enviados correctamente.`);
    } catch (e) {
        console.log("[ESTADISTICAS] Error general:", e.message);
    } finally {
        estadisticasEjecutando = false;
    }
}

// ===== CONFIGURACIÓN DE ENVÍOS =====
const SEND_DEFAULTS = { batchSize: 10, pauseSend: 30000, pauseBatch: 600000 };
let sendConfig = { ...SEND_DEFAULTS };

// ===== ENTRENAMIENTO DEL BOT Y CONTROL DE PROCESOS (persistente en BD) =====
const PROCESOS_DISPO = [
    { id: 'ia',            icono: '🤖', nombre: 'IA DeepSeek (RODI)', desc: 'Responde consultas con IA cuando no hay intención clásica.' },
    { id: 'notificador',   icono: '🧾', nombre: 'Notificador de facturas', desc: 'Envía aviso de nueva factura a clientes y vendedores (c/3 min).' },
    { id: 'recordatorio',  icono: '⏰', nombre: 'Recordatorio deudas', desc: 'Recordatorios de facturas vencidas a clientes (c/24 h).' },
    { id: 'cobranza',      icono: '💰', nombre: 'Cobranza vendedores', desc: 'Recordatorio de cobranza a vendedores (c/24 h).' },
    { id: 'estadisticas',  icono: '📊', nombre: 'Estadísticas de ventas', desc: 'Reporte semanal de ventas a cada vendedor.' },
    { id: 'dolar',         icono: '🪙', nombre: 'Actualización del dólar', desc: 'Refresca tasas BCV, paralelo y Binance P2P (c/1 h).' }
];
let procesosEstado = {};
async function cargarConfigBD() {
    try {
        const [rows] = await pool.execute("SELECT clave, valor FROM bot_config");
        for (const r of rows) {
            if (r.clave === 'procesos' && r.valor) {
                try { procesosEstado = JSON.parse(r.valor); } catch (e) {}
            } else if ((r.clave === 'instrucciones' || r.clave === 'instrucciones.txt') && r.valor) {
                ia.guardarInstrucciones(r.valor, false);
            }
        }
        for (const p of PROCESOS_DISPO) {
            if (typeof procesosEstado[p.id] !== 'boolean') procesosEstado[p.id] = true;
        }
        console.log("[CONFIG] Procesos cargados desde BD:", JSON.stringify(procesosEstado));
    } catch (e) {
        console.log("[CONFIG] Error cargando config BD:", e.message);
        for (const p of PROCESOS_DISPO) procesosEstado[p.id] = true;
    }
}
function proceActivo(id) {
    return procesosEstado[id] !== false;
}
async function guardarConfigBD() {
    try {
        const valor = JSON.stringify(procesosEstado);
        await pool.execute(
            "INSERT INTO bot_config (clave, valor) VALUES ('procesos', ?) ON DUPLICATE KEY UPDATE valor = ?",
            [valor, valor]
        );
    } catch (e) { console.log("[CONFIG] Error guardando procesos en BD:", e.message); }
}
async function guardarInstruccionesBD(texto) {
    try {
        await pool.execute(
            "INSERT INTO bot_config (clave, valor) VALUES ('instrucciones', ?) ON DUPLICATE KEY UPDATE valor = ?",
            [texto, texto]
        );
    } catch (e) { console.log("[CONFIG] Error guardando instrucciones en BD:", e.message); }
}

// ===== BOT WHATSAPP =====
async function startBot() {
    if (botStarting) {
        console.log("[BOT] ⏳ Ya hay un intento de conexión en curso, omitiendo...");
        return;
    }
    botStarting = true;

    if (socketBot) {
        try {
            socketBot.removeAllListeners();
            socketBot.end(undefined);
        } catch (e) {}
        socketBot = null;
    }

    try {
        // Asegurar que el directorio auth_info exista antes de intentar leer
        const authDir = path.join(process.cwd(), 'auth_info');
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
            console.log("[BOT] 📁 Directorio auth_info creado.");
        }
    } catch (e) {
        console.log("[BOT] Error creando auth_info:", e.message);
    }

    let state, saveCreds;
    try {
        const auth = await useMultiFileAuthState('auth_info');
        state = auth.state;
        saveCreds = auth.saveCreds;
    } catch (e) {
        console.log("[BOT] ❌ Error cargando sesión (auth_info corrupta?):", e.message);
        console.log("[BOT] 🔄 Limpiando auth_info y reiniciando...");
        botStarting = false;
        try {
            const authDir = path.join(process.cwd(), 'auth_info');
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true });
            }
        } catch (e) {}
        setTimeout(() => startBot(), 5000);
        return;
    }

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: getBrowser()
    });

    socketBot = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
        if (connection === 'open') { 
            botStarting = false;
            qrCodeData = "ONLINE ✅"; 
            console.log("🚀 BOT MASTER ONLINE");
            if (!notificadorInterval) {
                // MARCAR FACTURAS VIEJAS ANTES DE ACTIVAR NOTIFICADORES
                await marcarFacturasViejasComoNotificadas();
                // Esperar 30 segundos después de conectar antes de iniciar notificadores
                // Esto evita que al reconectar se envíen todos los mensajes pendientes de golpe
                console.log("[BOT] Esperando 30 segundos antes de activar notificadores...");
                setTimeout(() => {
                    console.log("[BOT] Notificadores activados.");
                    notificadorInterval = setInterval(checkNuevasFacturas, 180000); // Cada 3 minutos en vez de 45 seg
                    setInterval(checkFacturasVencidas, 86400000);
                    setInterval(checkVendedoresRecordatorio, 86400000);
                    
                    // Temporizador automático de Estadísticas activado (revisa cada 30 min)
                    setInterval(checkEstadisticasVendedores, 1800000);
                }, 30000);
                
                setInterval(() => {
                    if (!isBotReady() && socketBot && !botStarting) startBot();
                }, 300000);
            }
        }
        if (connection === 'close') {
            botStarting = false;
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || '';
            const esLoggedOut = statusCode === DisconnectReason.loggedOut;
            const esBadSession = errorMsg.includes('Bad MAC') || errorMsg.includes('Unsupported state') || errorMsg.includes('unable to authenticate');
            if (esBadSession) {
                console.log("[BOT] Sesión corrupta, limpiando auth_info y generando nuevo QR...");
                try {
                    const authDir = path.join(process.cwd(), 'auth_info');
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                    }
                } catch (e) {}
                qrCodeData = "Iniciando...";
            }
            if (!esLoggedOut) {
                const delay = esBadSession ? 10000 : 5000;
                setTimeout(() => startBot(), delay);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            const msg = messages[0];
            if (!msg || !msg.message) return;

            const from = msg.key.remoteJid;
            if (from === 'status@broadcast' || from.includes('@g.us')) return;

            // ===== INTERVENCIÓN HUMANA (mensajes salientes del vendedor) =====
            // Se procesa ANTES del filtro de tipo porque los mensajes que el vendedor
            // envía desde WhatsApp Web / teléfono pueden llegar con type 'append' (no 'notify').
            if (msg.key.fromMe) {
                const textMe = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();
                if (textMe === '!bot') {
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "🤖 Bot reactivado para este chat." });
                    return;
                }
                if (textMe === '!off' || textMe === '!callar' || textMe === '!silencio' || textMe === '!mute' || textMe === '!humano') {
                    await silenciarChat(from);
                    return;
                }
                // Si es un mensaje que el propio bot acaba de enviar automáticamente, NO silenciar.
                const textoSaliente = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
                if (esEnvioBotReciente(from, textoSaliente)) {
                    return;
                }
                // Cualquier otro mensaje saliente = el vendedor está escribiendo manualmente al cliente → silenciar el bot.
                await silenciarChat(from);
                return;
            }

            if (type !== 'notify') return;

            const isAdmin = ADMIN_IDS.some(id => from.includes(id));
            const vendedor = await buscarVendedor(from, msg.pushName || "Vendedor");

            const pushName = msg.pushName || "Usuario";
            let rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();

            // ===== LECTURA DE PEDIDOS POR IMAGEN (OCR GRATUITO) =====
            if (!rawText && msg.message.imageMessage) {
                console.log(`[IMG] Imagen recibida de ${from.split('@')[0]}, extrayendo pedido con OCR...`);
                const textoOcr = await extraerTextoDeImagen(msg);
                if (textoOcr && textoOcr.length > 0) {
                    rawText = textoOcr;
                    console.log(`[IMG] Texto OCR detectado: ${rawText.substring(0, 250)}`);
                }
            }
            if (!rawText) return;

            const text = normalizar(rawText);

            // Extraer nombre del cliente si se presenta (ej: "Hola Juan", "soy Pedro", "me llamo Carlos")
            let nombreExtraido = null;
            const nameMatch = rawText.match(/(?:hola|buenas|buen[ao]s?|soy|me llamo|mi nombre es|saludos?)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]{3,})/i);
            if (nameMatch) {
                const rawName = nameMatch[1].toLowerCase();
                const skipWords = ['dias', 'día', 'días', 'tardes', 'noches', 'saludos', 'saludo', 'buenos', 'buenas', 'buen', 'como', 'que', 'tal'];
                if (!skipWords.includes(rawName.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) {
                    nombreExtraido = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1).toLowerCase();
                }
            }
            
            const textoLimpioParaRif = rawText.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
            const esRIFPuro = /^[VJGE]\d{8,9}$/.test(textoLimpioParaRif);

            await guardarMensaje(from, 'user', rawText);

            // Evitar respuestas duplicadas (mismo texto, mismo remitente, en menos de 10 segundos)
            const msgKey = `${from}:${rawText}`;
            const ahoraMs = Date.now();
            const ultimoMsg = lastMessageTimes.get(msgKey) || 0;
            if (ahoraMs - ultimoMsg < DUPLICATE_COOLDOWN_MS) {
                console.log(`[DEDUP] Ignorando mensaje duplicado de ${from.split('@')[0]}`);
                return;
            }
            lastMessageTimes.set(msgKey, ahoraMs);
            // Limpiar entradas viejas del mapa
            if (lastMessageTimes.size > 1000) {
                const exp = ahoraMs - 60000;
                for (const [k, v] of lastMessageTimes) { if (v < exp) lastMessageTimes.delete(k); }
            }

            // Ignorar auto-reply de clientes (mensajes automáticos de bienvenida)
            const rawLower = rawText.toLowerCase();
            const esAutoReplyCliente = AUTO_REPLY_CLIENTE.some(f => rawLower.includes(f));
            if (esAutoReplyCliente) {
                console.log(`[AUTO_REPLY] Ignorando auto-respuesta de ${from.split('@')[0]}`);
                return;
            }

            const sesion = await getSesion(from);
            let nombreAlmacenado = null;
            if (sesion && sesion.datos) {
                try { const d = JSON.parse(sesion.datos); nombreAlmacenado = d.nombre_cliente || null; } catch(e) {}
            }

            // Guardar nombre extraído para futuras conversaciones
            if (nombreExtraido && !nombreAlmacenado) {
                let datosActuales = {};
                try { if (sesion?.datos) datosActuales = JSON.parse(sesion.datos); } catch(e) {}
                if (!datosActuales.nombre_cliente) {
                    datosActuales.nombre_cliente = nombreExtraido;
                    await pool.execute(
                        "INSERT INTO control_chat (telefono, datos, modo) VALUES (?, ?, 'bot') ON DUPLICATE KEY UPDATE datos = ?",
                        [from, JSON.stringify(datosActuales), JSON.stringify(datosActuales)]
                    );
                    nombreAlmacenado = nombreExtraido;
                }
            }

            if (sesion && sesion.modo === 'humano' && !isAdmin) {
                // El vendedor atiende este chat manualmente: el bot se mantiene en silencio.
                // Se reactiva solo tras 10 minutos sin intervención humana, o con "!bot".
                if (sesion.updated_at && (Date.now() - new Date(sesion.updated_at).getTime()) > REACTIVAR_BOT_MS) {
                    await setModo(from, 'bot');
                    console.log(`[AUTO-REACT] ${from.split('@')[0]} reactivado tras ${REACTIVAR_BOT_MS/60000} min sin intervención del vendedor.`);
                } else {
                    return;
                }
            }

            // --- 0a. COMANDOS DE IA (ADMIN) — se procesan primero para que no se confundan con productos/menú ---
            if (isAdmin && (text === 'ia' || text === 'estado ia' || text === 'ia on' || text === 'ia off' || text.startsWith('ia key ') || text === 'saldo' || text === 'saldo ia' || text === 'saldo deeepseek' || text === 'ia saldo')) {
                if (text === 'ia' || text === 'estado ia') {
                    return await safeSendMessage(from, { text: `🤖 *Estado de la IA DeepSeek*\n\n${ia.estaHabilitada() ? '🟢 Activa (respondiendo con deepseek-chat)' : '🔴 Desactivada o en espera (bot clásico)'}` });
                }
                if (text === 'ia on') {
                    ia.forzarEstado(true);
                    return await safeSendMessage(from, { text: "🤖 IA DeepSeek *activada*. Responderá con deepseek-chat mientras haya saldo." });
                }
                if (text === 'ia off') {
                    ia.forzarEstado(false);
                    return await safeSendMessage(from, { text: "🤖 IA DeepSeek *desactivada*. El bot vuelve al modo clásico." });
                }
                if (text.startsWith('ia key ')) {
                    const matchKey = rawText.match(/ia\s*key\s+([^\s]+)/i);
                    const nuevaKey = matchKey ? matchKey[1] : '';
                    if (nuevaKey.length < 10) {
                        return await safeSendMessage(from, { text: "❌ La key parece inválida. Envíe: ia key sk-..." });
                    }
                    ia.setKey(nuevaKey);
                    return await safeSendMessage(from, { text: "🔑 *Key de DeepSeek actualizada y guardada.*\n\nEl bot responderá con IA ahora. Envíe *ia* para confirmar el estado o *saldo* para ver el saldo." });
                }
                if (text === 'saldo' || text === 'saldo ia' || text === 'saldo deeepseek' || text === 'ia saldo') {
                    const saldo = await ia.verificarSaldo();
                    if (saldo === null) {
                        return await safeSendMessage(from, { text: `🤖 IA DeepSeek: ${ia.estaHabilitada() ? '🟢 Activa' : '🔴 Desactivada'}.\n\nNo pude consultar el saldo. Verifique que DEEPSEEK_API_KEY esté configurada en Render.` });
                    }
                    return await safeSendMessage(from, { text: `🤖 *Estado de la IA DeepSeek*\n\n💵 Saldo disponible: *$${saldo.saldo.toFixed(2)} USD*\n${saldo.disponible ? '🟢 La IA puede responder.' : '🔴 Saldo agotado: el bot responde en modo clásico.'}` });
                }
            }

            // --- 0. BIENVENIDA PRIMERA VEZ + SALUDO ---
            if (!sesion) {
                // Si es lista de precios/catálogo, agradecer en lugar de bienvenida
                if (/\b(lista\s*de\s*precios|catalogo|catálogo|listado)\b/i.test(rawText)) {
                    const nomProv = nombreExtraido || pushName || "Proveedor";
                    await safeSendMessage(from, { text: `📥 *${nomProv}*, hemos recibido su lista de precios. Agradecemos su comunicación y la estaremos revisando. ¡Gracias por contactarnos! 🙏` });
                    return;
                }
                await guardarUsuario(from, pushName, 0);
                const msg = `🎉 *¡Bienvenido a ONE4CARS, ${pushName}!* 🎉\n\nSomos *Juan* y *José*, sus asesores de confianza en autopartes. Estamos aquí para ayudarlo con todo lo que necesite, desde filtros y frenos hasta piezas especializadas.\n\n¿En qué podemos servirle el día de hoy? _Escriba la palabra *Menú* para más opciones e información._`;
                await safeSendMessage(from, { text: msg });
                return;
            }

            const esSaludo = text === 'menu' || text.startsWith('menu ') ||
                             text === 'hola' || text.startsWith('hola ') || text.startsWith('hola,') ||
                             text === 'saludo' || text.startsWith('saludo ') ||
                             text === 'saludos' || text.startsWith('saludos ') ||
                             text === 'buen dia' || text.startsWith('buen dia ') ||
                             text === 'buenos dias' || text.startsWith('buenos dias ') ||
                             text === 'buenas tardes' || text.startsWith('buenas tardes ') ||
                             text === 'buenas noches' || text.startsWith('buenas noches ') ||
                             text === 'buenas' || text.startsWith('buenas ') ||
                             text === 'que tal' || text.startsWith('que tal ') ||
                             text === 'qué tal' || text.startsWith('qué tal ');

            // Si el mensaje contiene pedido/cotización, no tratarlo como saludo
            const esCotizar = /\bcotiza(?:r|me|íme)\b/i.test(rawText);
            const tieneCodigosProducto = (rawText.match(/[A-Za-z]{2,}\d{2,}/g) || []).length > 0;
            const tieneCantidadDescripcion = /\b\d{1,4}\s+[A-Za-zÁÉÍÓÚáéíóúñÑ]{4,}/.test(rawText);
            const esOtraIntencion = esCotizar || tieneCodigosProducto || tieneCantidadDescripcion ||
                /\b(pago|pagos|factura|abono|deuda|saldo|cobro|cobranza|vendedor|lista\s*de\s*precios|catalogo|catálogo)\b/i.test(rawText) ||
                detectarVisita(rawText, text);

            // Si es saludo con otra intención, dar bienvenida a cotizaciones antes de procesar
            if (esSaludo && esOtraIntencion) {
                const nombreUsuario = nombreAlmacenado || nombreExtraido || (vendedor ? vendedor.nombre : null) || pushName || "Usuario";
                await safeSendMessage(from, { text: `👋 ¡Bienvenido al sistema de cotizaciones de ONE4CARS, *${nombreUsuario}*! Estamos procesando su solicitud...` });
            }

            if (esSaludo && !esOtraIntencion) {
                const nombreUsuario = nombreAlmacenado || nombreExtraido || (vendedor ? vendedor.nombre : null) || pushName || "Usuario";
                const mencionaJuan = text.includes('juan');
                const mencionaJose = text.includes('jos');
                const saludoBase = text.startsWith('buenas tardes') ? 'tarde' :
                                   text.startsWith('buenas noches') ? 'noche' : 'dia';

                if (text.startsWith('menu')) {
                    await safeSendMessage(from, { text: `📋 *MENÚ PRINCIPAL ONE4CARS*\n\n${MENU_TEXT}` });
                } else if (mencionaJuan) {
                    await safeSendMessage(from, { text: `¡Buen${saludoBase === 'dia' ? 'os' : 'as'} ${saludoBase}, *${nombreUsuario}*! 🙌\n\n*Juan* no está disponible en este momento, pero yo puedo atenderle con todo gusto. Somos el mismo equipo ONE4CARS y estamos para servirle.\n\n_Escriba la palabra *Menú* para más opciones e información._` });
                } else if (mencionaJose) {
                    await safeSendMessage(from, { text: `¡Buen${saludoBase === 'dia' ? 'os' : 'as'} ${saludoBase}, *${nombreUsuario}*! 🙌\n\n*José* no está disponible en este momento, pero yo puedo atenderle con todo gusto. Somos el mismo equipo ONE4CARS y estamos para servirle.\n\n_Escriba la palabra *Menú* para más opciones e información._` });
                } else {
                    const respuestas = {
                        'dia': `¡Buenos días, *${nombreUsuario}*! Dios le bendiga. Es un gusto tenerle por aquí. 🙏\n\n¿En qué podemos servirle el día de hoy? _Escriba la palabra *Menú* para más opciones e información._`,
                        'tarde': `¡Buenas tardes, *${nombreUsuario}*! Un placer saludarle. Que tenga una bendecida tarde. 😊\n\n¿Cómo podemos ayudarle? _Escriba la palabra *Menú* para más opciones e información._`,
                        'noche': `¡Buenas noches, *${nombreUsuario}*! Dios le bendiga. Que descanse. 🌙\n\n¿En qué podemos ayudarle? _Escriba la palabra *Menú* para más opciones e información._`
                    };
                    await safeSendMessage(from, { text: respuestas[saludoBase] });
                }

                // Guardar nombre del cliente si fue extraído del saludo
                if (nombreExtraido && !nombreAlmacenado) {
                    let datosActuales = {};
                    try { if (sesion?.datos) datosActuales = JSON.parse(sesion.datos); } catch(e) {}
                    if (!datosActuales.nombre_cliente) {
                        datosActuales.nombre_cliente = nombreExtraido;
                        await pool.execute(
                            "INSERT INTO control_chat (telefono, datos, modo) VALUES (?, ?, 'bot') ON DUPLICATE KEY UPDATE datos = ?",
                            [from, JSON.stringify(datosActuales), JSON.stringify(datosActuales)]
                        );
                    }
                }
                return;
            }

            // --- 1. FLUJO PENDIENTE DE CONSULTA DE FACTURAS POR RIF (vendedores/usuarios) ---
            if (pendienteFactura.has(from)) {
                const manejado = await procesarRIFConsulta(from, rawText, text);
                if (manejado) return;
            }

            // --- 1. LÓGICA DE RIF (ADMINISTRADORES) ---
            if (esRIFPuro) {
                if (isAdmin) {
                    const rifLimpio = limpiarRIF(rawText);
                    const c = await buscarCliente(rifLimpio);
                    if (c) {
                        await guardarUsuario(from, rifLimpio, c.id_cliente);
                        const facturas = await obtenerDetalleFacturas(c.id_cliente);
                        let totalP = 0; 
                        let list = `⭐ *CONSULTA DE ESTADO DE CUENTA (ADMIN)*\nCliente: ${c.nombres}\nRIF: ${rifLimpio}\n\n`;
                        if (facturas.length === 0) {
                            list += `✅ Sin facturas pendientes.`;
                        } else {
                            facturas.forEach(f => {
                                const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                                totalP += monto;
                                list += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n`;
                                list += `✍️ Firmada: https://www.one4cars.com/uploads/notas/${f.nro_factura}.jpg\n\n`;
                            });
                            list += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                        }
                        return await safeSendMessage(from, { text: list });
                    } else {
                        return await safeSendMessage(from, { text: "❌ No se encontró ningún cliente con ese RIF." });
                    }
                } else {
                    return await safeSendMessage(from, { text: "❌ La consulta de estado de cuenta mediante RIF es una función exclusiva para administradores." });
                }
            }

            // --- 1b. SELECCIÓN DE PRODUCTO (antes del menú para evitar conflicto con números) ---
            const pendingSel = pendingProductSelection.get(from);
            if (pendingSel && /^\d{1,2}$/.test(text)) {
                const idx = parseInt(text) - 1;
                // Multi-item selection handling
                if (pendingSel.multiItem) {
                    const multiOrder = multiItemOrders.get(from);
                    if (multiOrder) {
                        if (idx >= 0 && idx < pendingSel.productos.length) {
                            const p = pendingSel.productos[idx];
                            const pct = pendingSel.pct;
                            pendingProductSelection.delete(from);
                            const precio = parseFloat(p.precio_minimo || 0) / pct;
                            multiOrder.resolvedItems.push({ descripcion: multiOrder.items[multiOrder.currentIndex].descripcion, cantidad: multiOrder.items[multiOrder.currentIndex].cantidad, codigo: p.producto, tipo: p.tipo, precio: precio, error: false });
                            multiOrder.currentIndex++;
                            await processNextMultiItem(from, multiOrder);
                        } else {
                            pendingProductSelection.delete(from);
                            multiOrder.resolvedItems.push({ descripcion: multiOrder.items[multiOrder.currentIndex].descripcion, cantidad: multiOrder.items[multiOrder.currentIndex].cantidad, error: true });
                            multiOrder.currentIndex++;
                            await processNextMultiItem(from, multiOrder);
                        }
                        return;
                    }
                }
                // Original single-product selection
                if (idx >= 0 && idx < pendingSel.productos.length) {
                    const p = pendingSel.productos[idx];
                    const pct = pendingSel.pct;
                    pendingProductSelection.delete(from);
                    const precio = parseFloat(p.precio_minimo || 0) / pct;
                    let infoStock = "";
                    if (parseFloat(p.stock_total || 0) <= 0) {
                        const fab = parseFloat(p.cantidad_fabricando || 0);
                        infoStock = fab > 0 ? "\n🚚 *Sin existencia, en tránsito desde fábrica*" : "";
                    } else { infoStock = "\n✅ *Disponible*"; }
                    const caption = `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio: $${precio.toFixed(2)} (Pagadero a tasa BCV)*${infoStock}\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}`;
                    const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                    try {
                        registrarEnvioBot(from, caption); await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption });
                    } catch (imgErr) {
                        await safeSendMessage(from, { text: caption });
                    }
                    return;
                }
            }
            
            // --- 1c. REMINDER/CANCEL FOR PENDING MULTI-ITEM ---
            if (multiItemOrders.has(from)) {
                if (text === 'cancelar') {
                    multiItemOrders.delete(from);
                    const psel = pendingProductSelection.get(from);
                    if (psel && psel.multiItem) pendingProductSelection.delete(from);
                    await safeSendMessage(from, { text: "❌ Pedido cancelado." });
                    return;
                }
                if (!/^\d{1,2}$/.test(text)) {
                    await safeSendMessage(from, { text: "⚠️ Tienes un pedido pendiente. Responde el *número* del producto, o escribe *cancelar*." });
                    return;
                }
            }

            // --- 2. DETECCIÓN INTELIGENTE DEL MENÚ ---
            const menuOption = detectarIntencionMenu(text);
            if (menuOption) {
                if (menuOption.includes('Estado de cuenta')) {
                    const targetID = sesion?.id_cliente_int;
                    if (!targetID) {
                        // Sin cliente identificado: pedir RIF (vendedor consultando un cliente, o cliente sin sesión)
                        return await iniciarConsultaFactura(from, pushName);
                    }
                    const facturas = await obtenerDetalleFacturas(targetID);
                    if (facturas.length === 0) return await safeSendMessage(from, { text: "✅ No posee facturas pendientes." });
                    let totalP = 0; let listado = "*📄 FACTURAS PENDIENTES:*\n\n";
                    facturas.forEach(f => {
                        const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                        totalP += monto;
                        const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
                        const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent(f.nombres.trim())}&nombre=${encodeURIComponent(f.nombre_vendedor.trim())}&direccion=${encodeURIComponent(f.direccion.trim())}&cedula=${f.cedula.trim()}&celular=${encodeURIComponent(f.celular.trim())}&telefono=${encodeURIComponent(f.telefono.trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent(f.zona.trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
                        listado += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}\n\n`;
                    });
                    listado += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                    return await safeSendMessage(from, { text: listado });
                }
                if (menuOption.includes('Asesor Humano') && detectarVisita(rawText, text)) {
                    let infoCliente = { nombres: pushName, celular: from.split('@')[0] };
                    if (sesion?.id_cliente_int) {
                        const c = await pool.execute("SELECT * FROM tab_clientes WHERE id_cliente = ?", [sesion.id_cliente_int]);
                        if (c[0] && c[0][0]) infoCliente = c[0][0];
                    } else {
                        const c = await buscarClientePorTelefono(from.split('@')[0]);
                        if (c) infoCliente = c;
                    }
                    await guardarVisita(from, {
                        id_cliente: sesion?.id_cliente_int || infoCliente.id_cliente || 0,
                        nombres: infoCliente.nombres || pushName,
                        celular: infoCliente.celular || from.split('@')[0],
                        telefono: infoCliente.telefono || '',
                        direccion: infoCliente.direccion || '',
                        zona: infoCliente.zona || '',
                        rif: infoCliente.rif || '',
                        id_vendedor: vendedor?.id_vendedor || 0,
                        nombre_vendedor: vendedor?.nombre || '',
                        motivo: 'Solicitud de visita: ' + rawText.substring(0, 100),
                        acuerdo_visita: new Date()
                    });
                    const adminJids = ADMIN_IDS.map(id => formatWhatsApp(id)).filter(Boolean);
                    for (const aj of adminJids) {
                        await safeSendMessage(aj, { text: `📢 *VISITA SOLICITADA DESDE MENSAJE*\nCliente: ${infoCliente.nombres || pushName}\nTel: ${from.split('@')[0]}\nMensaje: ${rawText.substring(0, 200)}` });
                    }
                    const respExtendida = `${menuOption}\n\n📅 *Nota:* Hemos detectado que solicitas una visita. La hemos agendado automáticamente para que un operador te contacte pronto.`;
                    return await safeSendMessage(from, { text: respExtendida });
                }
                if (menuOption === 'VISITAS_HOY') {
                    const hoyStr = new Date().toISOString().split('T')[0];
                    try {
                        const [vis] = await pool.execute("SELECT a.id_agenda, a.hora, c.nombres, c.celular, c.zona, c.direccion FROM tab_agenda_visitas a JOIN tab_clientes c ON a.id_cliente = c.id_cliente WHERE a.fecha = ? AND (a.estado IN ('pendiente','no_contesto','ausente','pospuso') OR a.estado IS NULL) ORDER BY c.zona, c.nombres", [hoyStr]);
                        if (vis.length === 0) return await safeSendMessage(from, { text: `📅 *Visitas de Hoy (${hoyStr})*\n\n✅ No hay visitas pendientes para hoy.` });
                        const zonas = [...new Set(vis.map(v => v.zona))];
                        let reporte = `📅 *Visitas de Hoy (${hoyStr})*\nTotal: *${vis.length}* | Zonas: *${zonas.length}*\n\n`;
                        let zonaAct = '';
                        vis.forEach((v, i) => {
                            if (v.zona !== zonaAct) { zonaAct = v.zona; reporte += `\n📍 *${zonaAct || 'Sin zona'}*\n`; }
                            reporte += `  ${i+1}. ${v.nombres} ${v.hora ? '🕐'+v.hora.substring(0,5) : ''}\n     📞 ${v.celular || '—'}\n`;
                        });
                        reporte += `\n🔗 ${process.env.BASE_URL || 'https://bot-whatsapp-gratis-mq8u.onrender.com'}/visitas?fecha=${hoyStr}`;
                        return await safeSendMessage(from, { text: reporte });
                    } catch (e) {
                        console.log("[VISITAS HOY] Error:", e.message);
                        return await safeSendMessage(from, { text: "❌ Error al obtener el reporte de visitas." });
                    }
                }
                return await safeSendMessage(from, { text: menuOption });
            }

            // --- 3. LÓGICA DE PAGOS ---
            const MEDIOS_PAGO_KEYWORDS = ['envieme la cuenta', 'envíeme la cuenta', 'envieme el pago movil', 'envíeme el pago móvil', 'cual es su cuenta', 'cuál es su cuenta', 'cual es su pago movil', 'cuál es su pago móvil', 'numero de cuenta', 'número de cuenta', 'pago movil', 'pago móvil', 'medios de pago', 'cuenta para pagar', 'como puedo pagar', 'cómo puedo pagar', 'datos bancarios', 'datos de pago'];
            const PAGAR_KEYWORDS = ['como hago para pagar', 'cómo hago para pagar', 'quiero pagar', 'envieme el vendedor por el pago', 'envíeme el vendedor por el pago', 'aca tengo el dinero', 'acá tengo el dinero', 'pago fact', 'abono', 'al señor oscar', 'envié el pago', 'adjunto pago'];
            const esMediosPago = MEDIOS_PAGO_KEYWORDS.some(k => rawText.toLowerCase().includes(k) || text.includes(k));
            const esPagarAhora = PAGAR_KEYWORDS.some(k => rawText.toLowerCase().includes(k) || text.includes(k)) || (text.includes('pago') && !esMediosPago);
            let nombreCliente = vendedor ? vendedor.nombre : null;
            if (!nombreCliente) {
                const cliente = await buscarClientePorTelefono(from.split('@')[0]);
                if (cliente) nombreCliente = cliente.nombres;
            }
            if (!nombreCliente) nombreCliente = pushName;
            if (esMediosPago) {
                const msg = `¡Hola *${nombreCliente}*! 😊

Aquí tiene nuestros datos de pago:

1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/`;
                return await safeSendMessage(from, { text: msg });
            }
            if (esPagarAhora) {
                const msg = `¡Hola *${nombreCliente}*! 😊

Hemos recibido su notificación de pago, administración lo validará a la brevedad.

Mientras tanto, puede consultar el detalle de sus facturas pendientes aquí:

2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/`;
                return await safeSendMessage(from, { text: msg });
            }

            if (text === 'factura fiscal'  || text.includes('factura con iva')  ) {
                const nombreUsuario = vendedor ? vendedor.nombre : pushName;
                const saludoCordial = `¡Hola *${nombreUsuario}*! Gracias por su mensaje. 😊\n\nLa Factura Fiscal será realizada de acuerdo con su solicitud el día que tenga disponibilidad de hacer el pago.\n\n_Escriba la palabra *Menú* para más opciones e información._`;
                return await safeSendMessage(from, { text: saludoCordial });
            }

            // --- 4. COTIZACIÓN AUTOMÁTICA (MULTILÍNEA) ---
            const lineas = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const itemsPedido = [];
            for (const linea of lineas) {
                let match = linea.match(/^\s*([A-Za-z0-9]{3,})(?:\s+[-=./]?\s*|[-=./]\s*)(\d{1,4})(?:\s+(?:piezas?|und|unidad(?:es)?|uds?|unid\.?))?\s*$/i);
                if (match) {
                    itemsPedido.push({ codigo: match[1].toUpperCase(), cantidad: parseInt(match[2]) });
                    continue;
                }
                match = linea.match(/^\s*(\d{1,4})(?:\s+[-=./]?\s*|[-=./]\s*)([A-Za-z0-9]{3,})(?:\s+(?:piezas?|und|unidad(?:es)?|uds?|unid\.?))?\s*$/i);
                if (match) {
                    itemsPedido.push({ codigo: match[2].toUpperCase(), cantidad: parseInt(match[1]) });
                    continue;
                }
                match = linea.match(/^\s*([A-Za-z0-9]{3,})(?:\s+(?:piezas?|und|unidad(?:es)?|uds?|unid\.?))?\s*$/i);
                if (match) {
                    const cod = match[1].toUpperCase();
                    if (/[A-Z]/.test(cod) && /[0-9]/.test(cod)) {
                        itemsPedido.push({ codigo: cod, cantidad: 1 });
                    }
                    continue;
                }
                match = linea.match(/^\s*(?:.+?\s+)?(\d{1,4})\s+(?:del|de|lote|piezas?\s+del?)\s+([A-Za-z0-9]{3,})(?:\s+.+)?\s*$/i);
                if (match) {
                    itemsPedido.push({ codigo: match[2].toUpperCase(), cantidad: parseInt(match[1]) });
                    continue;
                }
                match = linea.match(/^\s*(?:.+?\s+)?([A-Za-z0-9]{3,})\s+(?:del|de)\s+(\d{1,4})(?:\s+.+)?\s*$/i);
                if (match) {
                    itemsPedido.push({ codigo: match[1].toUpperCase(), cantidad: parseInt(match[2]) });
                    continue;
                }
                match = linea.match(/^\s*(.+?)\s+[-=./]?\s*(\d{1,4})(?:\s+(?:piezas?|und|unidad(?:es)?|uds?|unid\.?))?\s*$/i);
                if (match && match[1].length >= 4) {
                    const txtDesc = match[1].trim();
                    const qty = parseInt(match[2]);
                    let foundByCode = null;
                    const palabrasDesc = txtDesc.split(/\s+/);
                    for (const pd of palabrasDesc) {
                        const codCandidato = pd.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                        if (codCandidato.length >= 4 && /[A-Z]/.test(codCandidato) && /[0-9]/.test(codCandidato)) {
                            foundByCode = await buscarProductoPorCodigo(codCandidato);
                            if (foundByCode) break;
                        }
                    }
                    if (foundByCode) {
                        itemsPedido.push({ codigo: foundByCode[0].producto, cantidad: qty });
                    } else {
                        const prodDesc = await buscarProductoPorTexto(txtDesc);
                        if (prodDesc && prodDesc.length > 0) {
                            itemsPedido.push({ codigo: prodDesc[0].producto, cantidad: qty });
                        }
                    }
                }
            }
            // Fallback: escanear patrones cantidad+código en todo el texto (ignorando palabras extra)
            if (itemsPedido.length === 0) {
                const codePat1 = /(\d{1,4})\s+([A-Za-z]{2,}\d{2,})/g;
                let match;
                while ((match = codePat1.exec(rawText)) !== null) {
                    const cod = match[2].toUpperCase();
                    if (!itemsPedido.some(it => it.codigo === cod)) {
                        itemsPedido.push({ codigo: cod, cantidad: parseInt(match[1]) });
                    }
                }
                if (itemsPedido.length === 0) {
                    const codePat2 = /([A-Za-z]{2,}\d{2,})\s+(\d{1,4})/g;
                    while ((match = codePat2.exec(rawText)) !== null) {
                        const cod = match[1].toUpperCase();
                        if (!itemsPedido.some(it => it.codigo === cod)) {
                            itemsPedido.push({ codigo: cod, cantidad: parseInt(match[2]) });
                        }
                    }
                }
            }
            const tieneMultiplesItems = itemsPedido.length >= 2;
            const tieneCantidadExplicita = itemsPedido.length === 1 && itemsPedido[0].cantidad !== 1;
            if (tieneMultiplesItems || tieneCantidadExplicita) {
                console.log(`[COTIZACION] Detectado pedido de ${itemsPedido.length} items de ${from}`);
                if (!vendedor) {
                    await setSesionDatos(from, { tipo: 'single', itemsPedido: itemsPedido, pushName: pushName });
                    await setModo(from, 'esperando_vendedor');
                    await safeSendMessage(from, { text: `🔍 *Detecté un pedido de ${itemsPedido.length} producto(s)*, pero no tengo identificado al vendedor.\n\n❓ *¿Cuál es su nombre como vendedor?*\n\n_Escriba el nombre exacto o *cancelar* para cancelar._` });
                    return;
                }
                const itemsTemp = itemsPedido.map(it => `${it.codigo} ${it.cantidad}`).join(', ');
                let vendedorSingle = vendedor ? { id_vendedor: vendedor.id_vendedor, nombre: vendedor.nombre, celular_vendedor: vendedor.celular_vendedor } : null;
                if (vendedor && vendedor.nombre.trim().toUpperCase() === 'OFICINA' && pushName) {
                    const pn = normalizar(pushName);
                    const nombresOf = ['juan', 'juan trujillo', 'jose cabral'];
                    if (nombresOf.some(n => pn === n || pn.startsWith(n))) {
                        vendedorSingle.subVendedor = pushName;
                    }
                }
                await setSesionDatos(from, { tipo: 'esperando_cliente', itemsPedido: itemsPedido, pushName: pushName, vendedor: vendedorSingle });
                await setModo(from, 'esperando_cliente');
                await safeSendMessage(from, { text: `🔍 *Detecté un pedido de ${itemsPedido.length} producto(s):*\n${itemsTemp}\n\n❓ *¿Para qué cliente es este pedido?*\nEscriba el nombre o razón social del cliente.` });
                return;
            }

            // --- ESPERANDO NOMBRE DE VENDEDOR ---
            if (sesion && sesion.modo === 'esperando_vendedor' && sesion.datos) {
                let datosSesion = {};
                try { datosSesion = JSON.parse(sesion.datos); } catch(e) {}
                const tipo = datosSesion.tipo;
                const cancelWords = ['no', 'nop', 'cancelar', 'cancela', 'ninguno', 'nunca', 'ningun'];
                if (cancelWords.includes(text)) {
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "❌ Pedido cancelado." });
                    return;
                }
                const nombreVendedor = rawText.trim();
                if (nombreVendedor.length < 3) {
                    await safeSendMessage(from, { text: "❌ Por favor escriba un nombre de vendedor válido (mínimo 3 caracteres)." });
                    return;
                }
                // Detectar vendedores de oficina (Juan, Juan Trujillo, Jose Cabral)
                const nombreNorm = normalizar(nombreVendedor);
                const nombresOficina = ['juan', 'juan trujillo', 'jose cabral'];
                const esOficina = nombresOficina.some(n => nombreNorm === n || nombreNorm.startsWith(n));
                let vendedorEncontrado = null;
                let subVendedor = null;
                if (esOficina) {
                    const [rowOf] = await pool.execute(
                        "SELECT id_vendedor, nombre, celular_vendedor FROM tab_vendedores WHERE activo = 'SI' AND nombre = 'OFICINA' LIMIT 1"
                    );
                    if (rowOf.length > 0) {
                        vendedorEncontrado = rowOf[0];
                        subVendedor = nombreVendedor;
                    }
                }
                if (!vendedorEncontrado) {
                    const [rows] = await pool.execute(
                        "SELECT id_vendedor, nombre, celular_vendedor FROM tab_vendedores WHERE activo = 'SI' AND nombre LIKE ? LIMIT 1",
                        [`%${nombreVendedor}%`]
                    );
                    if (rows.length === 0) {
                        await safeSendMessage(from, { text: `❌ No encontré un vendedor llamado "*${nombreVendedor}*" en la base de datos.\n\nPuede que no esté registrado como activo. Contacte a un administrador o escriba otro nombre.\n\nEscriba *cancelar* para cancelar el pedido.` });
                        return;
                    }
                    vendedorEncontrado = rows[0];
                }
                if (tipo === 'multi') {
                    const multiOrder = {
                        items: datosSesion.items,
                        currentIndex: 0,
                        resolvedItems: [],
                        pct: null,
                        vendedor: { ...vendedorEncontrado, subVendedor },
                        pushName: datosSesion.pushName || pushName
                    };
                    multiItemOrders.set(from, multiOrder);
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    const nombreV = subVendedor || vendedorEncontrado.nombre;
                    await safeSendMessage(from, { text: `✅ Vendedor identificado: *${nombreV}*. Procesando su pedido...` });
                    await processNextMultiItem(from, multiOrder);
                    return;
                } else {
                    const nombreVend = subVendedor || vendedorEncontrado.nombre;
                    await setSesionDatos(from, {
                        tipo: 'esperando_cliente',
                        itemsPedido: datosSesion.itemsPedido,
                        pushName: datosSesion.pushName,
                        vendedor: { id_vendedor: vendedorEncontrado.id_vendedor, nombre: vendedorEncontrado.nombre, celular_vendedor: vendedorEncontrado.celular_vendedor, subVendedor }
                    });
                    await setModo(from, 'esperando_cliente');
                    const itemsTemp = datosSesion.itemsPedido.map(it => `${it.codigo} ${it.cantidad}`).join(', ');
                    const nombreVendDisplay = subVendedor || vendedorEncontrado.nombre;
                    await safeSendMessage(from, { text: `✅ Vendedor: *${nombreVendDisplay}*\n\n🔍 *Pedido de ${datosSesion.itemsPedido.length} producto(s):*\n${itemsTemp}\n\n❓ *¿Para qué cliente es este pedido?*\nEscriba el nombre o razón social del cliente.` });
                    return;
                }
            }

            // --- ESPERANDO NOMBRE DE CLIENTE (después de detectar pedido sin nombre) ---
            if (sesion && sesion.modo === 'esperando_cliente' && sesion.datos) {
                let datosSesion = {};
                try { datosSesion = JSON.parse(sesion.datos); } catch(e) {}
                const itemsPendientes = datosSesion.itemsPedido;
                const vendedorSesion = datosSesion.vendedor;
                if (!itemsPendientes || itemsPendientes.length === 0) {
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    return;
                }
                if (!vendedorSesion) {
                    const nuevosDatos = { tipo: 'single', itemsPedido: itemsPendientes, pushName: datosSesion.pushName };
                    await setSesionDatos(from, nuevosDatos);
                    await setModo(from, 'esperando_vendedor');
                    await safeSendMessage(from, { text: "⚠️ No tengo el vendedor identificado. Por favor escriba su nombre como vendedor." });
                    return;
                }
                const cancelWords = ['no', 'nop', 'cancelar', 'cancela', 'ninguno'];
                if (cancelWords.includes(text)) {
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "❌ Pedido cancelado." });
                    return;
                }
                const nombreClienteBusqueda = rawText.trim();
                let clienteEncontrado = null;
                if (vendedorSesion) {
                    clienteEncontrado = await buscarClientePorNombreYVendedor(nombreClienteBusqueda, vendedorSesion.nombre);
                }
                if (!clienteEncontrado) {
                    const palabras = nombreClienteBusqueda.toUpperCase().split(/\s+/).filter(p => p.length >= 3);
                    if (palabras.length > 0) {
                        clienteEncontrado = await buscarClientePorPalabras(palabras, vendedorSesion?.nombre, nombreClienteBusqueda);
                    }
                }
                if (!clienteEncontrado) {
                    const palabras = nombreClienteBusqueda.toUpperCase().split(/\s+/).filter(p => p.length >= 3);
                    if (palabras.length > 0) {
                        clienteEncontrado = await buscarClientePorPalabras(palabras, undefined, nombreClienteBusqueda);
                    }
                }
                if (!clienteEncontrado) {
                    try {
                        const [debugRows] = await pool.execute("SELECT id_cliente, nombres, vendedor, activo FROM tab_clientes WHERE nombres LIKE ? LIMIT 5", [`%${nombreClienteBusqueda}%`]);
                        console.log("[DEBUG_CLIENTE] Búsqueda falló para:", nombreClienteBusqueda, "Resultados LIKE:", JSON.stringify(debugRows));
                        if (debugRows.length === 0) {
                            const [allRows] = await pool.execute("SELECT id_cliente, nombres, vendedor, activo FROM tab_clientes WHERE vendedor = ? LIMIT 5", [vendedorSesion?.nombre || '']);
                            console.log("[DEBUG_CLIENTE] Clientes del vendedor:", JSON.stringify(allRows));
                        }
                    } catch (de) { console.log("[DEBUG_CLIENTE] Error debug:", de.message); }
                    await safeSendMessage(from, { text: `❌ No encontré un cliente llamado "*${nombreClienteBusqueda}*".\n\nEscriba el nombre exacto o *cancelar* para cancelar el pedido.` });
                    return;
                }
                const credito = await verificarCreditoCliente(clienteEncontrado.id_cliente);
                if (credito.tieneVencidas || credito.tieneRetrasos) {
                    let msgAviso = `⚠️ *AVISO DE CRÉDITO — CLIENTE: ${clienteEncontrado.nombres}*\n\n`;
                    if (credito.tieneVencidas) {
                        msgAviso += `🚨 *Facturas vencidas (${credito.facturasVencidas.length}):*\n`;
                        credito.facturasVencidas.forEach(f => {
                            msgAviso += `🔹 Factura #${f.nro_factura} — $${f.saldo.toFixed(2)} — ${f.dias_vencida} días de vencida\n`;
                        });
                        msgAviso += `\n`;
                    }
                    if (credito.tieneRetrasos) {
                        msgAviso += `⏰ *Retraso en pagos anteriores:*\n`;
                        credito.facturasRetraso.forEach(f => {
                            msgAviso += `🔹 Factura #${f.nro_factura} — Plazo de pago: ${f.dias_pago} días\n`;
                        });
                        msgAviso += `\n_El cliente presentó un plazo de pago de ${credito.mayorRetraso} días, eso limita su capacidad de crédito._\n\n`;
                    }
                    msgAviso += `_Esto requiere que usted lo converse con la gerencia para autorizar este despacho._`;
                    await safeSendMessage(from, { text: msgAviso });
                    await sleep(1000);
                }
                let itemsOk = [];
                let errores = [];
                const pct = await obtenerPorcentaje();
                for (const item of itemsPendientes) {
                    const prods = await buscarProductoPorCodigo(item.codigo);
                    if (!prods || prods.length === 0) {
                        errores.push(`❌ *${item.codigo}*: Código no encontrado`);
                        continue;
                    }
                    const p = prods[0];
                    const stock = parseFloat(p.stock_total || 0);
                    const fabricando = parseFloat(p.cantidad_fabricando || 0);
                    if (stock <= 0) {
                        if (fabricando > 0) {
                            errores.push(`🚚 *${p.producto}*: En fabricación/tránsito`);
                        } else {
                            errores.push(`❌ *${p.producto}*: Agotado`);
                        }
                        continue;
                    }
                    itemsOk.push({ codigo: p.producto, tipo: p.tipo, cantidad: item.cantidad, precio: parseFloat(p.precio_minimo || 0) / pct });
                }
                if (itemsOk.length > 0) {
                    let gt = 0;
                    let msgCot = `📋 *COTIZACIÓN*\n`;
                    if (vendedorSesion) msgCot += `👤 Vendedor: *${vendedorSesion.nombre}*\n`;
                    msgCot += `🏢 Cliente: *${clienteEncontrado.nombres}*\n\n`;
                    msgCot += `💰 *Precios pagaderos a tasa BCV*\n\n`;
                    itemsOk.forEach(it => { const t = it.precio * it.cantidad; gt += t; msgCot += `*${it.codigo}* - ${it.tipo || ''}\n   ${it.cantidad} und x $${it.precio.toFixed(2)} = *$${t.toFixed(2)}*\n`; });
                    msgCot += `\n*TOTAL GENERAL: $${gt.toFixed(2)}*`;
                    if (errores.length > 0) msgCot += `\n\n⚠️ Productos no incluidos:\n${errores.join('\n')}`;
                    await safeSendMessage(from, { text: msgCot });
                    const dataConfirm = { items: itemsOk, vendedor: vendedorSesion || null, pushName: datosSesion.pushName || pushName, cliente: clienteEncontrado };
                    pendientesConfirmacion.set(from, dataConfirm);
                    await setSesionDatos(from, { tipo: 'confirmando', items: dataConfirm.items, vendedor: dataConfirm.vendedor, pushName: dataConfirm.pushName, cliente: dataConfirm.cliente });
                    await setModo(from, 'confirmando');
                    await sleep(500);
                    await safeSendMessage(from, { text: `✅ *¿Desea confirmar este pedido?*\n\nResponda *SI* para confirmar o *NO* para cancelar.` });
                } else {
                    let msg = `⚠️ *No se pudo generar la cotización*\n\n${errores.join('\n')}`;
                    await safeSendMessage(from, { text: msg });
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                }
                return;
            }

            // --- ESPERANDO NOMBRE DE CLIENTE (para multi-item) ---
            if (sesion && sesion.modo === 'esperando_cliente_multi' && sesion.datos) {
                let datosSesion = {};
                try { datosSesion = JSON.parse(sesion.datos); } catch(e) { console.log("[CLIENTE_MULTI] Error parseando datos:", e.message); }
                console.log("[CLIENTE_MULTI] Handler alcanzado. modo:", sesion.modo, "texto:", rawText, "pushName:", pushName, "tiene okItems:", Array.isArray(datosSesion.okItems), "tiene itemsPedido:", Array.isArray(datosSesion.itemsPedido));
                const { okItems, errorItems, vendedor, pushName } = datosSesion;
                const cancelWords = ['no', 'nop', 'cancelar', 'cancela', 'ninguno', 'nunca'];
                if (cancelWords.includes(text)) {
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "❌ Pedido cancelado." });
                    return;
                }
                const nombreCliente = rawText.trim();
                if (nombreCliente.length < 3) {
                    await safeSendMessage(from, { text: "❌ Por favor escriba un nombre válido." });
                    return;
                }
                let clienteEncontrado = null;
                if (vendedor) {
                    clienteEncontrado = await buscarClientePorNombreYVendedor(nombreCliente, vendedor.nombre);
                }
                if (!clienteEncontrado && vendedor) {
                    const palabras = nombreCliente.toUpperCase().split(/\s+/).filter(p => p.length >= 3);
                    if (palabras.length > 0) {
                        clienteEncontrado = await buscarClientePorPalabras(palabras, vendedor.nombre, nombreCliente);
                    }
                }
                if (!clienteEncontrado) {
                    const palabras = nombreCliente.toUpperCase().split(/\s+/).filter(p => p.length >= 3);
                    if (palabras.length > 0) {
                        clienteEncontrado = await buscarClientePorPalabras(palabras, undefined, nombreCliente);
                    }
                }
                if (!clienteEncontrado) {
                    try {
                        const [debugRows] = await pool.execute("SELECT id_cliente, nombres, vendedor, activo FROM tab_clientes WHERE nombres LIKE ? LIMIT 5", [`%${nombreCliente}%`]);
                        console.log("[DEBUG_CLIENTE_MULTI] Búsqueda falló para:", nombreCliente, "Resultados LIKE:", JSON.stringify(debugRows));
                    } catch (de) { console.log("[DEBUG_CLIENTE] Error debug:", de.message); }
                    await safeSendMessage(from, { text: `❌ No encontré un cliente llamado "*${nombreCliente}*".\n\nEscriba el nombre exacto o *cancelar* para cancelar el pedido.` });
                    return;
                }
                let gt = 0;
                let msg = `📋 *COTIZACIÓN*\n`;
                if (vendedor) msg += `👤 Vendedor: *${vendedor.nombre}*\n`;
                msg += `🏢 Cliente: *${clienteEncontrado.nombres}*\n\n`;
                msg += `💰 *Precios pagaderos a tasa BCV*\n\n`;
                okItems.forEach(it => {
                    const t = it.precio * it.cantidad;
                    gt += t;
                    msg += `*${it.codigo}* - ${it.tipo || ''}\n   ${it.cantidad} und x $${it.precio.toFixed(2)} = *$${t.toFixed(2)}*\n\n`;
                });
                msg += `\n*TOTAL GENERAL: $${gt.toFixed(2)}*`;
                if (errorItems && errorItems.length > 0) {
                    msg += `\n\n⚠️ Productos no disponibles:\n`;
                    errorItems.forEach(it => {
                        if (it.motivo) msg += `🚚 ${it.motivo} — "${it.descripcion}" (${it.cantidad} und)\n`;
                        else msg += `❌ "${it.descripcion}" (${it.cantidad} und)\n`;
                    });
                }
                await safeSendMessage(from, { text: msg });
                const dataConfirm = { items: okItems, vendedor, pushName, cliente: clienteEncontrado };
                pendientesConfirmacion.set(from, dataConfirm);
                await setSesionDatos(from, { tipo: 'confirmando', items: dataConfirm.items, vendedor: dataConfirm.vendedor, pushName: dataConfirm.pushName, cliente: dataConfirm.cliente });
                await setModo(from, 'confirmando');
                await sleep(500);
                await safeSendMessage(from, { text: `✅ *¿Desea confirmar este pedido?*\n\nResponda *SI* para confirmar o *NO* para cancelar.` });
                return;
            }

            // --- CONFIRMACIÓN DE PEDIDO ---
            if (pendientesConfirmacion.has(from) && sesion && sesion.modo === 'confirmando') {
                const confWords = ['si', 'sí', 'confirmo', 'confirmar', 'dale', 'ok', 'okey', 'claro', 'simon', 'confirmado', 'yes'];
                const cancelWords = ['no', 'nop', 'cancelar', 'cancela', 'ninguno', 'nunca'];
                if (confWords.includes(text)) {
                    const data = pendientesConfirmacion.get(from);
                    if (!data.vendedor) {
                        await safeSendMessage(from, { text: "❌ No se identificó al vendedor. Por favor inicie el pedido nuevamente desde cero." });
                        pendientesConfirmacion.delete(from);
                        await clearSesionDatos(from);
                        await setModo(from, 'bot');
                        return;
                    }
                    // Asegurar que las tablas existan ANTES de intentar insertar
                    await ensureTablaPedidos();
                    try {
                        const hoy = new Date().toISOString().split('T')[0];
                        let nro;
                        try {
                            const [maxNro] = await pool.execute("SELECT COALESCE(MAX(nro_factura),0)+1 as next FROM tab_pedidos");
                            nro = maxNro[0].next;
                        } catch (eTab) {
                            console.log("[PEDIDO] tab_pedidos no existe, creando...");
                            await ensureTablaPedidos();
                            const [maxNro] = await pool.execute("SELECT COALESCE(MAX(nro_factura),0)+1 as next FROM tab_pedidos");
                            nro = maxNro[0].next;
                        }
                        const jidParts = from.split('@');
                        const rawTel = jidParts[0].replace(/\D/g, '');
                        const isLid = jidParts[1] && jidParts[1].includes('lid');
                        const tel = (isLid || rawTel.length > 13)
                            ? (data.vendedor?.celular_vendedor || `LID:${rawTel}`)
                            : rawTel;
                        const tot = data.items.reduce((s, it) => s + it.precio * it.cantidad, 0);
                        const nombreVendedorFinal = data.vendedor?.nombre || '';
                        const subVendedorFinal = data.vendedor?.subVendedor || null;
                        await pool.execute("INSERT INTO tab_pedidos (nro_factura, fecha_reg, nombres, celular, total, id_vendedor, vendedor, sub_vendedor, celular_vendedor, pagada, anulado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NO', 'no')",
                            [nro, hoy, data.cliente?.nombres || data.pushName || 'Cliente', tel, tot, data.vendedor?.id_vendedor || 0, nombreVendedorFinal, subVendedorFinal, data.vendedor?.celular_vendedor || '']);
                        const [pedido] = await pool.execute("SELECT MAX(id_factura) as id FROM tab_pedidos");
                        const idPed = pedido[0].id;
                        const ahora = new Date().toISOString().slice(0, 19).replace('T', ' ');
                        console.log("[ORDEN] Insertando orden, cliente:", data.cliente?.nombres || data.pushName, "total:", tot, "vendedor:", data.vendedor?.nombre);
                        try {
                            const comentariosOrden = subVendedorFinal ? `Vendedor real: ${subVendedorFinal}` : '';
                            const [ordenResult] = await pool.execute(
                                "INSERT INTO orden (customer_id, cedula, nombres, direccion, celular, id_vendedor, vendedor, total_price, created, modified, status, facturado, pendiente, forma_de_pago, facturar, comentarios) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', 'NO', 'NO', '', '', ?)",
                                [data.cliente?.id_cliente || 0, data.cliente?.cedula || '', data.cliente?.nombres || data.pushName || 'Cliente', data.cliente?.direccion || '', tel, data.vendedor?.id_vendedor || 0, nombreVendedorFinal, tot, ahora, ahora, comentariosOrden]
                            );
                            const ordenId = ordenResult.insertId;
                            console.log("[ORDEN] OK, insertId:", ordenId);
                            for (let i = 0; i < data.items.length; i++) {
                                const it = data.items[i];
                                await pool.execute("INSERT INTO tab_pedidos_reng (id_factura, nro_reglon, producto, cantidad, precio_unitario, precio_total, tipo, fecha_reg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    [idPed, i + 1, it.codigo, it.cantidad, it.precio, it.precio * it.cantidad, it.tipo || '', hoy]);
                                let idProducto = 0;
                                let descripcion = '';
                                try {
                                    const [prods] = await pool.execute("SELECT id_producto, descripcion FROM tab_productos WHERE producto = ? LIMIT 1", [it.codigo]);
                                    if (prods.length > 0) {
                                        idProducto = prods[0].id_producto || 0;
                                        descripcion = prods[0].descripcion || '';
                                    }
                                } catch (e) { console.log("[ORDEN_ART] Error consultando producto:", e.message); }
                                try {
                                    await pool.execute(
                                        "INSERT INTO orden_articulos (order_id, product_id, producto, descripcion, quantity, precio_unitario, almacen) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                        [ordenId, idProducto, it.codigo, descripcion, it.cantidad, it.precio, '']
                                    );
                                } catch (e) { console.log("[ORDEN_ART] Error insertando:", e.message); }
                            }
                        } catch (e) { console.log("[ORDEN] Error:", e.message, e.sqlMessage || ''); }
                        const adminJids = ADMIN_IDS.map(id => formatWhatsApp(id)).filter(Boolean);
                        for (const aj of adminJids) {
                            await safeSendMessage(aj, { text: `📦 *NUEVO PEDIDO CONFIRMADO #${nro}*\nCliente: ${data.pushName || tel}\nTotal: $${tot.toFixed(2)}\nVendedor: ${data.vendedor?.nombre || 'N/A'}\n\n_Ver pedido en el sistema_` });
                        }
                        await safeSendMessage(from, { text: `✅ *Pedido #${nro} confirmado con éxito!*\n\nUn administrador lo revisará pronto. ¡Gracias por su preferencia! 🙏` });
                    } catch (e) {
                        console.log("[PEDIDO] Error al guardar:", e.message, e.sqlMessage || '');
                        console.log("[PEDIDO] STACK:", e.stack);
                        await safeSendMessage(from, { text: "❌ Ocurrió un error al confirmar el pedido. Intente nuevamente." });
                    }
                    pendientesConfirmacion.delete(from);
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    return;
                } else if (cancelWords.includes(text)) {
                    pendientesConfirmacion.delete(from);
                    await clearSesionDatos(from);
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "❌ Pedido cancelado." });
                    return;
                }
            }

            // --- CONFIRMACIÓN DE VISITA ---
            if (agendaVisitas.has(from) && sesion && sesion.modo === 'visitando') {
                const dataVisita = agendaVisitas.get(from);
                const confWords = ['si', 'sí', 'confirmo', 'confirmar', 'dale', 'ok', 'okey', 'claro', 'simon', 'confirmado', 'yes', 'adelante'];
                const cancelWords = ['no', 'nop', 'cancelar', 'cancela', 'ninguno', 'nunca'];

                if (dataVisita.esperando_fecha) {
                    const fechaParseada = parsearFechaVisita(rawText);
                    if (fechaParseada) {
                        dataVisita.acuerdo_visita = fechaParseada.fecha;
                        dataVisita.dias_frecuencia = fechaParseada.frecuencia || 0;
                        dataVisita.esperando_fecha = false;
                        dataVisita.esperando_confirmacion = true;
                        const fechaStr = fechaParseada.fecha.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                        let msgFecha = `📅 Entendido, agendaremos la visita para el *${fechaStr}*.`;
                        if (fechaParseada.frecuencia === 7) msgFecha += `\n🔄 La visita será *semanal* (todos los ${fechaParseada.fecha.toLocaleDateString('es-ES', { weekday: 'long' })}).`;
                        msgFecha += `\n\n¿Confirmas que deseas agendar esta visita? Responde *SI* para confirmar o *NO* para cancelar.`;
                        await safeSendMessage(from, { text: msgFecha });
                    } else if (confWords.includes(text) || cancelWords.includes(text)) {
                        if (cancelWords.includes(text)) {
                            agendaVisitas.delete(from);
                            await clearSesionDatos(from);
                            await setModo(from, 'bot');
                            await safeSendMessage(from, { text: "❌ Solicitud de visita cancelada. Si en otro momento necesitas asistencia, aquí estamos." });
                            return;
                        }
                        await safeSendMessage(from, { text: "Por favor, indícame una fecha válida. Ejemplos: *hoy*, *mañana*, *el jueves*, *en 15 días*, *el próximo lunes*." });
                    } else {
                        await safeSendMessage(from, { text: "No entendí la fecha. Por favor indícame un día. Ej: *hoy*, *mañana*, *el jueves*, *en 15 días*." });
                    }
                    await setSesionDatos(from, { tipo: 'visitando', esperando_fecha: dataVisita.esperando_fecha, esperando_confirmacion: dataVisita.esperando_confirmacion, acuerdo_visita: dataVisita.acuerdo_visita ? dataVisita.acuerdo_visita.toISOString() : null, dias_frecuencia: dataVisita.dias_frecuencia || 0, motivo: dataVisita.motivo, nombres: dataVisita.nombres });
                    return;
                }

                if (dataVisita.esperando_confirmacion) {
                    if (confWords.includes(text)) {
                        const fechaStr = dataVisita.acuerdo_visita ? dataVisita.acuerdo_visita.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Pendiente';
                        let infoCliente = { nombres: dataVisita.nombres || pushName, celular: from.split('@')[0] };
                        if (sesion?.id_cliente_int) {
                            const c = await pool.execute("SELECT * FROM tab_clientes WHERE id_cliente = ?", [sesion.id_cliente_int]);
                            if (c[0] && c[0][0]) {
                                infoCliente = c[0][0];
                            }
                        } else {
                            const c = await buscarClientePorTelefono(from.split('@')[0]);
                            if (c) infoCliente = c;
                        }
                        const frecuencia = dataVisita.dias_frecuencia || 0;
                        const exito = await guardarVisita(from, {
                            id_cliente: sesion?.id_cliente_int || infoCliente.id_cliente || 0,
                            nombres: infoCliente.nombres || pushName,
                            celular: infoCliente.celular || from.split('@')[0],
                            telefono: infoCliente.telefono || '',
                            direccion: infoCliente.direccion || '',
                            zona: infoCliente.zona || '',
                            rif: infoCliente.rif || '',
                            id_vendedor: vendedor?.id_vendedor || 0,
                            nombre_vendedor: vendedor?.nombre || '',
                            motivo: dataVisita.motivo || 'Solicitud de visita por WhatsApp',
                            acuerdo_visita: dataVisita.acuerdo_visita || new Date(),
                            dias_frecuencia: frecuencia
                        });
                        if (exito) {
                            let msgExito = `✅ *Visita agendada con éxito!*\n\n📅 Fecha: *${fechaStr}*`;
                            if (frecuencia === 7) msgExito += `\n🔄 Frecuencia: *Semanal*`;
                            msgExito += `\n\nUn vendedor lo visitará en la fecha indicada. ¡Gracias por confiar en ONE4CARS! 🙏`;
                            await safeSendMessage(from, { text: msgExito });
                            const adminJids = ADMIN_IDS.map(id => formatWhatsApp(id)).filter(Boolean);
                            for (const aj of adminJids) {
                                await safeSendMessage(aj, { text: `📢 *NUEVA VISITA AGENDADA*\nCliente: ${infoCliente.nombres || pushName}\nTel: ${from.split('@')[0]}\nFecha: ${fechaStr}\nVendedor: ${vendedor?.nombre || 'Sin asignar'}\nMotivo: ${dataVisita.motivo || 'Solicitud de visita'}` });
                            }
                        } else {
                            await safeSendMessage(from, { text: "❌ Ocurrió un error al agendar la visita. Por favor intenta de nuevo o contacta a un administrador." });
                        }
                        agendaVisitas.delete(from);
                        await clearSesionDatos(from);
                        await setModo(from, 'bot');
                    } else if (cancelWords.includes(text)) {
                        agendaVisitas.delete(from);
                        await clearSesionDatos(from);
                        await setModo(from, 'bot');
                        await safeSendMessage(from, { text: "❌ Solicitud de visita cancelada." });
                    }
                    return;
                }
            }

            // --- DETECCIÓN DE INTENCIÓN DE VISITA ---
            if (!esRIFPuro && !menuOption) {
                const esIntencionVisita = detectarVisita(rawText, text);
                if (esIntencionVisita) {
                    const fechaYaParseada = parsearFechaVisita(rawText);
                    if (fechaYaParseada) {
                        const dataVisitaDetect = {
                            esperando_fecha: false,
                            esperando_confirmacion: true,
                            acuerdo_visita: fechaYaParseada.fecha,
                            dias_frecuencia: fechaYaParseada.frecuencia || 0,
                            motivo: rawText,
                            nombres: vendedor ? vendedor.nombre : pushName
                        };
                        agendaVisitas.set(from, dataVisitaDetect);
                        await setSesionDatos(from, { tipo: 'visitando', esperando_fecha: false, esperando_confirmacion: true, acuerdo_visita: fechaYaParseada.fecha.toISOString(), dias_frecuencia: fechaYaParseada.frecuencia || 0, motivo: rawText, nombres: dataVisitaDetect.nombres });
                        await setModo(from, 'visitando');
                        const fechaStr = fechaYaParseada.fecha.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                        let msgFecha = `Entiendo que deseas agendar una visita. 🚗\n\n📅 Propongo agendar para el *${fechaStr}*.`;
                        if (fechaYaParseada.frecuencia === 7) msgFecha += `\n🔄 Será una visita *semanal* (todos los ${fechaYaParseada.fecha.toLocaleDateString('es-ES', { weekday: 'long' })}).`;
                        msgFecha += `\n\n¿Confirmas? Responde *SI* para confirmar o *NO* para cancelar.`;
                        await safeSendMessage(from, { text: msgFecha });
                        return;
                    }
                    if (sesion && sesion.modo === 'visitando') {
                        const dataVisitaDetect = {
                            esperando_fecha: true,
                            esperando_confirmacion: false,
                            motivo: rawText,
                            nombres: vendedor ? vendedor.nombre : pushName
                        };
                        agendaVisitas.set(from, dataVisitaDetect);
                        await setSesionDatos(from, { tipo: 'visitando', esperando_fecha: true, esperando_confirmacion: false, motivo: rawText, nombres: dataVisitaDetect.nombres });
                        await setModo(from, 'visitando');
                        await safeSendMessage(from, { text: `Entiendo que deseas agendar una visita. 🚗\n\n¿Para qué día te gustaría que pasemos? Puedes decirme: *hoy*, *mañana*, *el jueves*, *en 15 días*, o la fecha que prefieras.` });
                        return;
                    }
                    const dataVisitaDetect = {
                        esperando_fecha: true,
                        esperando_confirmacion: false,
                        motivo: rawText,
                        nombres: vendedor ? vendedor.nombre : pushName
                    };
                    agendaVisitas.set(from, dataVisitaDetect);
                    await setSesionDatos(from, { tipo: 'visitando', esperando_fecha: true, esperando_confirmacion: false, motivo: rawText, nombres: dataVisitaDetect.nombres });
                    await setModo(from, 'visitando');
                    await safeSendMessage(from, { text: `Entiendo que deseas agendar una visita. 🚗\n\n¿Para qué día te gustaría que pasemos? Puedes decirme: *hoy*, *mañana*, *el jueves*, *en 15 días*, o la fecha que prefieras.` });
                    return;
                }
            }

            // --- 5. LÓGICA DE PRODUCTOS MEJORADA ---
            const autoReplyFrasi = ['gracias por comunicarte', 'mensaje automático', 'auto-reply', 'automatic reply', 'soy un bot', 'soy el asistente', 'comunicarte con', 'en breve te atenderemo'];
            const esAutoReply = autoReplyFrasi.some(f => rawText.toLowerCase().includes(f));
            if (!esAutoReply && !text.startsWith('menu')) {
                // Multi-item detection
                if (!multiItemOrders.has(from)) {
                    const multiItems = parseMultiItemMessage(rawText);
                    if (multiItems) {
                        console.log(`[MULTI] Pedido de ${multiItems.length} items de ${from}`);
                        if (!vendedor) {
                            await setSesionDatos(from, { tipo: 'multi', items: multiItems, pushName: pushName });
                            await setModo(from, 'esperando_vendedor');
                            await safeSendMessage(from, { text: `🔍 *Detecté un pedido de ${multiItems.length} producto(s)*, pero no tengo identificado al vendedor.\n\n❓ *¿Cuál es su nombre como vendedor?*\n\n_Escriba el nombre exacto o *cancelar* para cancelar._` });
                            return;
                        }
                        // Si el vendedor es OFICINA, detectar sub-vendedor desde pushName
                        let vendedorMulti = { ...vendedor };
                        if (vendedor.nombre.trim().toUpperCase() === 'OFICINA' && pushName) {
                            const pn = normalizar(pushName);
                            const nombresOf = ['juan', 'juan trujillo', 'jose cabral'];
                            if (nombresOf.some(n => pn === n || pn.startsWith(n))) {
                                vendedorMulti.subVendedor = pushName;
                            }
                        }
                        const multiOrder = { items: multiItems, currentIndex: 0, resolvedItems: [], pct: null, vendedor: vendedorMulti, pushName: pushName };
                        multiItemOrders.set(from, multiOrder);
                        await processNextMultiItem(from, multiOrder);
                        return;
                    }
                }
                try {
                    const palabrasEnMensaje = rawText.split(/\s+/);
                    const txtNormal = normalizar(rawText);
                    const contieneKeyword = PRODUCT_KEYWORDS.some(kw => txtNormal.includes(kw));
                    const tieneCodigo = palabrasEnMensaje.some(p => {
                        const c = p.replace(/[^a-zA-Z0-9]/g, '');
                        return c.length >= 4 && ((/[A-Za-z]/.test(c) && /[0-9]/.test(c)) || /^\d{4,}$/.test(c));
                    });

                    let prods = null;
                    
                    // Buscar por código primero
                    for (const p of palabrasEnMensaje) {
                        const codCandidato = p.replace(/[^a-zA-Z0-9]/g, '');
                        if ((codCandidato.length >= 4 && /[A-Za-z]/.test(codCandidato) && /[0-9]/.test(codCandidato)) || /^\d{4,}$/.test(codCandidato)) {
                            prods = await buscarProductoPorCodigo(codCandidato);
                            if (prods) break;
                        }
                    }

                    // Si no hay código y hay keyword de producto, buscar por texto
                    if (!prods && contieneKeyword) {
                        // Extraer cantidad del inicio si existe: "20 Rolineras delanteras de corolla"
                        let textoBusqueda = rawText;
                        let cantidadPedido = 0;
                        const qtyMatch = rawText.match(/^\s*(\d{1,4})\s+(.+)/);
                        if (qtyMatch) {
                            cantidadPedido = parseInt(qtyMatch[1]);
                            textoBusqueda = qtyMatch[2];
                        }
                        prods = await buscarProductoPorTexto(textoBusqueda);
                        
                        // Si múltiples resultados, presentar opciones
                        if (prods && prods.length > 1) {
                            const pct = await obtenerPorcentaje();
                            let msg = `🔍 *${prods.length} productos encontrados para:* "${textoBusqueda}"\n`;
                            prods.slice(0, 8).forEach((p, i) => {
                                const precio = parseFloat(p.precio_minimo || 0) / pct;
                                msg += `\n*${i+1}.* ${p.producto} — *$${precio.toFixed(2)}*\n   ${p.descripcion.substring(0, 60)}${p.descripcion.length > 60 ? '...' : ''}`;
                            });
                            msg += `\n\n📌 Responde el *número* del producto que necesitas.`;
                            pendingProductSelection.set(from, { productos: prods.slice(0, 8), pct });
                            return await safeSendMessage(from, { text: msg });
                        }
                    }

                    if (prods) {
                        const pct = await obtenerPorcentaje();
                        const saludoExacto = `¡Hola! He buscado en nuestro inventario y encontré esto:\n`;
                        await safeSendMessage(from, { text: saludoExacto });
                        await sleep(1000);

                        for (const p of prods.slice(0, 5)) {
                            if (!isBotReady()) break;
                            const precio = parseFloat(p.precio_minimo || 0) / pct;
                            
                            let infoStock = "";
                            if (parseFloat(p.stock_total || 0) <= 0) {
                                const fab = parseFloat(p.cantidad_fabricando || 0);
                                if (fab > 0) {
                                    infoStock = "\n🚚 *Sin existencia, en tránsito desde fábrica*";
                                } else {
                                    infoStock = "";
                                }
                            } else {
                                infoStock = "\n✅ *Disponible*";
                            }
                            
                            const caption = `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio: $${precio.toFixed(2)} (Pagadero a tasa BCV)*${infoStock}\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}`;
                            const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                            try {
                                registrarEnvioBot(from, caption); await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption });
                            } catch (imgErr) {
                                await safeSendMessage(from, { text: caption });
                            }
                            await sleep(10000);
                        }
                        return;
                    }
                } catch (e) { console.log("Error en flujo de productos:", e); }
            }

            // --- 6. COMANDOS DE ADMINISTRADOR ---
            if (isAdmin) {
                const notaMatch = text.match(/nota\s+(\d+)/);
                if (notaMatch) {
                    const numNota = notaMatch[1];
                    const linkNota = `https://www.one4cars.com/uploads/notas/${numNota}.jpg`;
                    return await safeSendMessage(from, { text: `✍️ *Factura Firmada #${numNota}*\n\nPuede ver la imagen aquí:\n${linkNota}` });
                }

                if (text === 'dolar' || text === 'bcv' || text === 'paralelo' || text === 'binance' ) {
                    await actualizarDolar();
                    return await safeSendMessage(from, { text: `💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}\n🪙 Binance (P2P): ${dolarInfo.binance}` });
                }
            }

            // --- TOP 10 MÁS VENDIDOS ---
            if (text === 'top10' || text === 'top 10' || text === 'mas vendidos' || text === 'top10productos' || text === 'top') {
                const top10 = await obtenerTop10();
                if (!top10 || top10.length === 0) {
                    return await safeSendMessage(from, { text: "No hay datos de ventas este mes aún." });
                }
                const pct = await obtenerPorcentaje();
                let msg = `🏆 *TOP 10 MÁS VENDIDOS (MES)*\n💰 *Precios pagaderos a tasa BCV*\n\n`;
                top10.forEach((p, i) => {
                    const precio = parseFloat(p.precio_minimo || 0) / pct;
                    msg += `${i + 1}. *${p.producto}* - ${p.descripcion}\n`;
                    msg += `   ${p.total_vendido} und | $${precio.toFixed(2)} c/u\n`;
                });
                return await safeSendMessage(from, { text: msg });
            }

            // --- 8. AGRADECIMIENTO ---
            const gratitudeWords = ['gracias', 'agradecid', 'agardecid', 'agradecimient'];
            if (gratitudeWords.some(w => text.includes(w))) {
                const nombre = nombreAlmacenado || nombreExtraido || (vendedor ? vendedor.nombre : null) || pushName || "Usuario";
                const respGrat = [
                    `¡Ha sido un placer atenderle, *${nombre}*! Que Dios le bendiga y quede muy pendiente cualquier cosita que necesite. Aquí estamos para servirle. 🙏`,
                    `Un honor poder ayudarle, *${nombre}*. Que tenga un excelente día y cualquier cosita no dude en escribirnos. ¡Estamos a la orden! 🙌`,
                    `Con mucho gusto, *${nombre}*, para eso estamos. Que Dios le bendiga grandemente y quede muy pendiente. ¡Aquí tiene su casa! 🏠`,
                    `Gracias a usted, *${nombre}*, por su confianza. Es un privilegio poder atenderle. Que pase un bendecido día. 😊🙏`,
                    `¡De nada, *${nombre}*! Con todo el gusto del mundo. Recuerde que estamos para servirle en lo que necesite. ¡Dios le bendiga! 🌟`
                ];
                return await safeSendMessage(from, { text: respGrat[Math.floor(Math.random() * respGrat.length)] });
            }

            // --- 9. FALLBACK (respuesta para mensajes no reconocidos) ---
            const conversationalShorts = ['si', 'no', 'ok', 'vale', 'ya', 'entendido', 'bueno', 'dale', 'claro', 'estoy atento', 'estoy atenta', 'estoy pendiente', 'okey', 'te aviso', 'te estoy avisando', 'no mi pana', 'mi pana', 'mi amigo', 'estamos en contacto'];
            if (conversationalShorts.includes(text)) return; 
            if (rawText.length > 500) return;

            const ahora = Date.now();

            // --- 9.1 INTENTAR RESPUESTA CON DEEPSEEK (deepseek-chat) ---
            // Usa la IA con el saldo de DeepSeek. Si el saldo se agota o la key falla,
            // ia.preguntar devuelve null y el bot cae automáticamente al modo clásico.
            const nombreIA = nombreAlmacenado || nombreExtraido || (vendedor ? vendedor.nombre : null) || pushName || "Usuario";
            let respIA = null;
            // 9.1a DETECCIÓN DE INTENCIÓN: primero con IA (si está activa). Si devuelve 'otro' o la IA
            // está desactivada/sin saldo, se usa un respaldo local de palabras clave para que el flujo
            // de "monto a pagar / estado de cuenta por RIF" siga funcionando siempre.
            let intentoIA = 'otro';
            if (proceActivo('ia')) {
                try { intentoIA = await ia.clasificar(rawText); } catch (e) { intentoIA = 'otro'; }
            }
            const regexIntencionMonto = /(monto\s+a\s+pagar|monto\s+de\s+la\s+factura|saldo\s+de\s+la\s+factura|cuanto\s+(pagar|debo|debe)|cuanto\s+(le|me)\s+(debo|toca|corresponde|queda)|cuanto\s+es\s+el\s+monto|deuda|deudo|adeudo|pagar\s+factura|estado\s+de\s+cuenta|estados?\s+de\s+cuenta|facturas?\s+pendientes|cuentas?\s+pendientes|balance\s+de\s+cuenta|me\s+toca\s+pagar|tengo\s+que\s+pagar|tengo\s+pendiente|saldar\s+factura)/i;
            const esIntencionPago = intentoIA === 'monto_pagar' || intentoIA === 'estado_cuenta' || regexIntencionMonto.test(rawText) || (/(rif|cliente)\s*[jvegJ VEG]?\s*\d{6,}/i.test(rawText) && /(monto|pagar|deud|factura|cuent|saldo|pendiente|estado)/i.test(rawText));
            if (esIntencionPago) {
                // No delegar si el mensaje es un número (selección en curso) o ya está en otro flujo.
                if (!pendienteFactura.has(from) && !/^\d+$/.test(text)) {
                    return await iniciarConsultaFactura(from, pushName);
                }
            }
            if (proceActivo('ia')) {
                respIA = await ia.preguntar(rawText, dolarInfo);
            }
            if (respIA) {
                await guardarMensaje(from, 'model', respIA);
                lastFallbackSent.set(from, ahora);
                return await safeSendMessage(from, { text: respIA });
            }

            // --- 9.2 RESPALDO CLÁSICO (si no hay saldo de DeepSeek o hubo error) ---
            const ultimoFallback = lastFallbackSent.get(from) || 0;
            if (ahora - ultimoFallback < FALLBACK_COOLDOWN_MS) return;

            const nombreFb = nombreAlmacenado || nombreExtraido || (vendedor ? vendedor.nombre : null) || pushName || "Usuario";
            const fallbacks = [
                `Disculpa, *${nombreFb}*, no logré entender tu consulta. 🙏\n\nRecuerde que cualquier información adicional la puede obtener escribiendo la palabra *Menu*.`,
                `*${nombreFb}*, no tengo una respuesta para eso. Recuerde que cualquier información adicional la puede obtener escribiendo la palabra *Menu*. 👇`,
                `Hola *${nombreFb}*, no pude procesar tu mensaje. 😊\n\nRecuerde que cualquier información adicional la puede obtener escribiendo la palabra *Menu*.`
            ];
            lastFallbackSent.set(from, ahora);
            return await safeSendMessage(from, { text: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
        } catch (e) { console.log("[MSG] Error en handler de mensajes:", e.message); }
    });
}

// ===== SERVIDOR HTTP =====
const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const header = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><nav class="navbar navbar-dark mb-4 shadow" style="background:linear-gradient(135deg,#0f0c29,#302b63);border-bottom:1px solid rgba(255,255,255,0.08)"><div class="container"><a class="navbar-brand fw-bold" href="/" style="letter-spacing:-0.3px"><i class="bi bi-speedometer2 me-2"></i>ONE4CARS</a></div></nav>`;
    const routename = parsedUrl.pathname;

    if (routename === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(query);
        res.end(await cobranza.generarHTML(v, z, d, header, query));
    } else if (routename === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, query));
    } else if (routename === '/marketing-preview') {
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
        const params = [];
        if (query.vendedor) { sql += " AND vendedor = ?"; params.push(query.vendedor); }
        if (query.zona) { sql += " AND zona = ?"; params.push(query.zona); }
        const [clientes] = await pool.execute(sql, params);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(clientes));
    } else if (routename === '/enviar-marketing' && req.method === 'POST') {
        if (!isBotReady()) return res.end("Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id of data.clientes) {
                const [rows] = await pool.execute("SELECT * FROM tab_clientes WHERE id_cliente=?", [id]);
                if (rows[0]) {
                    const c = rows[0];
                    const jid = formatWhatsApp(c.celular);
                    try {
                        if (data.tipo === 'precios') {
                            await safeSendMessage(jid, { document: { url: PDF_URL_CATALOGO }, fileName: 'Catalogo-ONE4CARS.pdf', mimetype: 'application/pdf', caption: `¡Hola *${c.nombres}*! Catálogo actualizado.` });
                        } else if (data.tipo === 'promo') {
                            await safeSendMessage(jid, { text: data.mensaje });
                        }
                        await randomDelay();
                    } catch (e) {}
                }
            }
            res.end("OK");
        });
    } else if (routename === '/enviar-cobranza' && req.method === 'POST') {
        if (!isBotReady()) return res.end("Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
                for (const id_cliente of data.facturas) {
                const [facturas] = await pool.execute(
                    `SELECT f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje,
                            DATEDIFF(CURDATE(), f.fecha_reg) as dias, c.nombres, c.celular,
                            v.nombre as vendedor_nombre
                     FROM tab_facturas f
                     JOIN tab_clientes c ON f.id_cliente = c.id_cliente
                     LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
                     WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'`,
                    [id_cliente]
                );
                for (const f of facturas) {
                    const jid = formatWhatsApp(f.celular);
                    let divisas = parseFloat(f.total) - parseFloat(f.abono_factura || 0);
                    let bcv = divisas / (parseFloat(f.porcentaje) || 1);
                    if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                        divisas = divisas / 0.80;
                        bcv = bcv / 0.80;
                    }
                    const dias = Math.floor((new Date() - new Date(f.fecha_reg)) / 86400000);
                    const tpl = pickTemplate(MESSAGE_TEMPLATES.cobranza60);
                    const msg = tpl(f.nombres, f.nro_factura, divisas.toFixed(2), dias, bcv.toFixed(2));
                    await safeSendMessage(jid, { text: msg });
                    await humanDelay(25, 55);
                }
            }
            res.end("OK");
        });
    } else if (routename === '/reset-sesion') {
        try {
            if (fs.existsSync('auth_info')) {
                fs.rmSync('auth_info', { recursive: true, force: true });
            }
            res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sesión borrada</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><meta http-equiv="refresh" content="5;url=/"> </head><body class="bg-light"><div class="container mt-5 text-center"><div class="card shadow p-5 mx-auto" style="max-width:500px;border-radius:15px;"><h3>✅ Sesión borrada</h3><p class="mt-3">La carpeta <strong>auth_info</strong> se eliminó correctamente.</p><p>El bot mostrará un nuevo código QR en <strong>5 segundos</strong>.</p><a href="/" class="btn btn-primary mt-3">Ir al inicio</a></div></div></body></html>`);
        } catch (e) { res.end("Error al borrar sesión: " + e.message); }
    } else if (routename === '/notificador-estado') {

        const filtroVendedorNotif = query.vendedor || '';

        if (query.action === 'force_cobranza') {
            if (isBotReady()) {
                checkVendedoresRecordatorio(true).catch(e => console.log(e));
            }
            res.writeHead(302, { 'Location': '/notificador-estado' + (filtroVendedorNotif ? '?vendedor='+encodeURIComponent(filtroVendedorNotif) : '') });
            return res.end();
        }

        if (query.action === 'force_stats') {
            if (isBotReady()) {
                // DESTRABAR MANUALMENTE LA VARIABLE PARA QUE ENTRE SÍ O SÍ
                estadisticasEjecutando = false; 
                checkEstadisticasVendedores(true).catch(e => console.log(e));
            }
            res.writeHead(302, { 'Location': '/notificador-estado' + (filtroVendedorNotif ? '?vendedor='+encodeURIComponent(filtroVendedorNotif) : '') });
            return res.end();
        }

        const total = await notificador.obtenerFacturasNoNotificadasCount();
        const [vendedoresNotif] = await pool.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != '' AND vendedor IS NOT NULL ORDER BY vendedor");
        const vendOptsNotif = vendedoresNotif.map(v => `<option value="${v.vendedor}"${filtroVendedorNotif===v.vendedor?' selected':''}>${v.vendedor}</option>`).join('');

        res.end(`<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <title>Notificador</title>
        </head>
        <body class="bg-light">
            ${header}
            <div class="container mt-5">
                <div class="card shadow-lg p-4 mx-auto" style="max-width: 600px; border-radius: 15px;">
                    <h3>📬 Notificador</h3>
                    <hr>
                    <form class="row g-2 mb-2 align-items-end" method="GET" action="/notificador-estado">
                        <div class="col-auto">
                            <label class="small fw-bold">Vendedor</label>
                            <select name="vendedor" class="form-select form-select-sm" onchange="this.form.submit()">
                                <option value="">Todos</option>${vendOptsNotif}
                            </select>
                        </div>
                    </form>
                    <p>Facturas pendientes por notificar a clientes: <strong>${total}</strong></p>
                    <p>Estado del Bot: ${isBotReady() ? '<span class="text-success">🟢 Online</span>' : '<span class="text-danger">🔴 Offline</span>'}</p>
                    <hr>
                    <h5>📊 Control Manual de Vendedores</h5>
                    <p class="text-muted small">Selecciona la notificación que deseas enviar en este momento (Saltará restricciones de fecha).</p>
                    <div class="d-grid gap-2 mt-3">
                        <a href="/notificador-estado?action=force_cobranza${filtroVendedorNotif ? '&vendedor='+encodeURIComponent(filtroVendedorNotif) : ''}" class="btn btn-warning text-dark">⚠️ Forzar Notificación de Cuentas por Cobrar</a>
                        <a href="/notificador-estado?action=force_stats${filtroVendedorNotif ? '&vendedor='+encodeURIComponent(filtroVendedorNotif) : ''}" class="btn btn-primary">📊 Forzar Envío de Estadísticas de Ventas</a>
                        <a href="/" class="btn btn-outline-secondary mt-2">Volver al Menú Principal</a>
                    </div>
                </div>
            </div>
        </body>
        </html>`);
    } else if (routename === '/historial') {
        const [msgs] = await pool.execute("SELECT h.id, h.telefono, h.rol, h.contenido, h.fecha FROM historial_chat h ORDER BY h.fecha DESC LIMIT 200");
        const rows = msgs.map(m => `<tr><td>${m.telefono}</td><td class="${m.rol === 'user' ? 'text-primary' : 'text-success'}">${m.rol}</td><td style="max-width:400px;word-break:break-word">${m.contenido}</td><td>${new Date(m.fecha).toLocaleString()}</td></tr>`).join('');
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>Historial Chat</title></head><body class="bg-light">${header}<div class="container mt-3"><h3>💬 Historial de Conversaciones</h3><div class="table-responsive"><table class="table table-sm table-striped"><thead><tr><th>Teléfono</th><th>Rol</th><th>Mensaje</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table></div><a href="/" class="btn btn-outline-secondary">Volver</a></div></body></html>`);
    } else if (routename === '/set-send-config' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(b);
                if (data.batchSize) sendConfig.batchSize = parseInt(data.batchSize) || SEND_DEFAULTS.batchSize;
                if (data.pauseSend) sendConfig.pauseSend = parseInt(data.pauseSend) || SEND_DEFAULTS.pauseSend;
                if (data.pauseBatch) sendConfig.pauseBatch = parseInt(data.pauseBatch) || SEND_DEFAULTS.pauseBatch;
                res.end("OK");
            } catch (e) { res.end("Error"); }
        });
    } else if (routename === '/recordatorio-visita') {
        if (query.action === 'force' || query.success || query.error) {
            res.writeHead(302, { Location: '/recordatorio-visita' });
            res.end();
            return;
        }

        const lunes = new Date();
        lunes.setDate(lunes.getDate() - ((lunes.getDay() + 6) % 7));
        const semanaInicio = lunes.toISOString().split('T')[0];
        const filtroZonaRV = query.zona || '';
        const filtroVendedorRV = query.vendedor || '';

        const [zonasRV] = await pool.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' AND zona IS NOT NULL ORDER BY zona");
        const [vendedoresRV] = await pool.execute("SELECT DISTINCT v.nombre FROM tab_vendedores v JOIN tab_clientes c ON c.vendedor = v.nombre WHERE v.nombre != '' ORDER BY v.nombre");

        let sqlRV = `
            SELECT DISTINCT c.id_cliente, c.nombres, c.celular, c.direccion, c.zona,
                   COALESCE(v.nombre, 'Sin asignar') as vendedor_nombre,
                   v.celular_vendedor
            FROM tab_clientes c
            LEFT JOIN tab_vendedores v ON c.vendedor = v.nombre
            WHERE c.activo = 'si'
              AND EXISTS (
                SELECT 1 FROM tab_facturas f
                WHERE f.id_cliente = c.id_cliente
                  AND f.anulado = 'no'
                  AND DATEDIFF(CURDATE(), f.fecha_reg) >= 45
              )
              AND NOT EXISTS (
                SELECT 1 FROM tab_facturas f
                WHERE f.id_cliente = c.id_cliente
                  AND f.anulado = 'no'
                  AND f.pagada = 'NO'
              )`;
        const paramsRV = [];
        if (filtroZonaRV) { sqlRV += " AND c.zona = ?"; paramsRV.push(filtroZonaRV); }
        if (filtroVendedorRV) { sqlRV += " AND v.nombre = ?"; paramsRV.push(filtroVendedorRV); }
        sqlRV += " ORDER BY c.nombres";
        const [clientesElegibles] = await pool.execute(sqlRV, paramsRV);

        const [yaEnviados] = await pool.execute(
            "SELECT id_cliente FROM recordatorio_visita_log WHERE semana_inicio = ?",
            [semanaInicio]
        );
        const setYaEnviados = new Set(yaEnviados.map(r => r.id_cliente));

        const [log] = await pool.execute(
            "SELECT rv.*, c.nombres FROM recordatorio_visita_log rv LEFT JOIN tab_clientes c ON rv.id_cliente = c.id_cliente ORDER BY rv.fecha_envio DESC LIMIT 100"
        );

        const filasElegibles = clientesElegibles.map(c => {
            const yaEnviado = setYaEnviados.has(c.id_cliente);
            const checked = yaEnviado ? 'checked disabled' : '';
            const badge = yaEnviado ? '<span class="badge bg-success">Enviado</span>' : '<span class="badge bg-warning text-dark">Pendiente</span>';
            return `<tr class="${yaEnviado ? 'table-success' : ''}">
                <td><input type="checkbox" class="cliente-check" value="${c.id_cliente}" ${checked}></td>
                <td>${c.id_cliente}</td>
                <td>${c.nombres}</td>
                <td>${c.celular || ''}</td>
                <td>${c.vendedor_nombre}</td>
                <td>${c.zona || ''}</td>
                <td>${badge}</td>
            </tr>`;
        }).join('');

        const filasLog = log.map(r => `<tr><td>${r.id}</td><td>${r.id_cliente}</td><td>${r.nombres || ''}</td><td>${r.semana_inicio}</td><td>${new Date(r.fecha_envio).toLocaleString()}</td></tr>`).join('');
        const zonaOptsRV = zonasRV.map(z => `<option value="${z.zona}"${filtroZonaRV===z.zona?' selected':''}>${z.zona}</option>`).join('');
        const vendOptsRV = vendedoresRV.map(v => `<option value="${v.nombre}"${filtroVendedorRV===v.nombre?' selected':''}>${v.nombre}</option>`).join('');

        res.end(`<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <title>Recordatorio Visitas</title>
        </head>
        <body class="bg-light">
            ${header}
            <div class="container mt-3">
                ${query.error ? `<div class="alert alert-danger">❌ ${query.error}</div>` : ''}
                ${query.success ? `<div class="alert alert-success">✅ ${query.success}</div>` : ''}
                <h3>📬 Recordatorio Semanal de Visitas</h3>
                <p class="text-muted">Semana: <strong>${semanaInicio}</strong></p>

                <form class="row g-2 mb-2 p-2 bg-white rounded shadow-sm align-items-end" method="GET" action="/recordatorio-visita">
                    <div class="col-auto">
                        <label class="small fw-bold">Zona</label>
                        <select name="zona" class="form-select form-select-sm" onchange="this.form.submit()">
                            <option value="">Todas</option>${zonaOptsRV}
                        </select>
                    </div>
                    <div class="col-auto">
                        <label class="small fw-bold">Vendedor</label>
                        <select name="vendedor" class="form-select form-select-sm" onchange="this.form.submit()">
                            <option value="">Todos</option>${vendOptsRV}
                        </select>
                    </div>
                </form>

                <details class="mb-2">
                <summary style="cursor:pointer;font-size:0.9rem">⚙️ Configurar envíos</summary>
                <div class="card card-body p-2 mb-2">
                <div class="row g-2 align-items-end">
                    <div class="col-auto"><label class="small">Bloque</label><input type="number" id="cfgBatch" class="form-control form-control-sm" value="${sendConfig.batchSize}" style="width:80px"></div>
                    <div class="col-auto"><label class="small">Pausa/msg (seg)</label><input type="number" id="cfgPauseSend" class="form-control form-control-sm" value="${sendConfig.pauseSend/1000}" style="width:90px"></div>
                    <div class="col-auto"><label class="small">Pausa/lote (min)</label><input type="number" id="cfgPauseBatch" class="form-control form-control-sm" value="${sendConfig.pauseBatch/60000}" style="width:90px"></div>
                    <div class="col-auto"><button onclick="guardarConfig()" class="btn btn-sm btn-outline-dark">Guardar</button></div>
                </div></div></details>

                <div class="d-flex gap-2 mb-3">
                    <button id="selectAll" class="btn btn-outline-primary btn-sm">✅ Seleccionar Todos</button>
                    <button id="deselectAll" class="btn btn-outline-secondary btn-sm">❌ Desseleccionar</button>
                    <button id="sendSelected" class="btn btn-danger btn-sm">🚀 Enviar a Seleccionados</button>
                    <a href="/recordatorio-visita?action=force" class="btn btn-warning btn-sm">📨 Forzar Todos</a>
                </div>

                <div class="card shadow-sm mb-4">
                    <div class="card-header bg-primary text-white">Clientes Elegibles (facturas pagadas, activos, +45 días)</div>
                    <div class="table-responsive">
                        <table class="table table-sm table-striped mb-0">
                            <thead><tr><th><input type="checkbox" id="checkAll"></th><th>ID</th><th>Cliente</th><th>Celular</th><th>Vendedor</th><th>Zona</th><th>Estado</th></tr></thead>
                            <tbody>${filasElegibles}</tbody>
                        </table>
                    </div>
                </div>

                <div class="card shadow-sm">
                    <div class="card-header bg-secondary text-white">Historial de Envíos</div>
                    <div class="table-responsive">
                        <table class="table table-sm table-striped mb-0">
                            <thead><tr><th>ID</th><th>ID Cliente</th><th>Cliente</th><th>Semana</th><th>Enviado</th></tr></thead>
                            <tbody>${filasLog}</tbody>
                        </table>
                    </div>
                </div>

                <a href="/" class="btn btn-outline-secondary mt-3">Volver</a>
            </div>

            <script>
            document.getElementById('checkAll').addEventListener('change', function() {
                document.querySelectorAll('.cliente-check:not(:disabled)').forEach(cb => cb.checked = this.checked);
            });
            document.getElementById('selectAll').addEventListener('click', function() {
                document.querySelectorAll('.cliente-check:not(:disabled)').forEach(cb => cb.checked = true);
            });
            document.getElementById('deselectAll').addEventListener('click', function() {
                document.querySelectorAll('.cliente-check:not(:disabled)').forEach(cb => cb.checked = false);
            });
            document.getElementById('sendSelected').addEventListener('click', async function() {
                const ids = Array.from(document.querySelectorAll('.cliente-check:checked:not(:disabled)')).map(cb => cb.value);
                if (ids.length === 0) { alert('Selecciona al menos un cliente.'); return; }
                if (!confirm('Enviar recordatorio a ' + ids.length + ' cliente(s)?')) return;
                this.disabled = true; this.textContent = 'Enviando...';
                try {
                    const res = await fetch('/enviar-recordatorio-visita', {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ clientes: ids })
                    });
                    const text = await res.text();
                    alert(text);
                    location.reload();
                } catch(e) { alert('Error: ' + e.message); }
                this.disabled = false; this.textContent = 'Enviar a Seleccionados';
            });
            async function guardarConfig(){
                const d={batchSize:document.getElementById('cfgBatch').value,pauseSend:document.getElementById('cfgPauseSend').value*1000,pauseBatch:document.getElementById('cfgPauseBatch').value*60000};
                try{await fetch('/set-send-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});alert('Config guardada.');}catch(e){alert('Error: '+e.message);}
            }
            </script>
        </body>
        </html>`);
    } else if (routename === '/visitas') {
        const filtroZona = parsedUrl.searchParams.get('zona') || '';
        const filtroFechaDesde = parsedUrl.searchParams.get('fecha_desde') || '';
        const filtroFechaHasta = parsedUrl.searchParams.get('fecha_hasta') || '';
        const filtroDia = parsedUrl.searchParams.get('dia') || '';
        let where = ["a.estado IN ('pendiente','no_contesto','ausente','pospuso') OR a.estado IS NULL"];
        let params = [];
        if (filtroZona) { where.push("c.zona = ?"); params.push(filtroZona); }
        if (filtroDia) { where.push("a.fecha = ?"); params.push(filtroDia); }
        if (filtroFechaDesde) { where.push("a.fecha >= ?"); params.push(filtroFechaDesde); }
        if (filtroFechaHasta) { where.push("a.fecha <= ?"); params.push(filtroFechaHasta); }
        const whereClause = "WHERE (" + where.join(") AND (") + ")";
        const [zonas] = await pool.execute("SELECT DISTINCT c.zona FROM tab_agenda_visitas a JOIN tab_clientes c ON a.id_cliente = c.id_cliente WHERE c.zona != '' ORDER BY c.zona");
        const [visitas] = await pool.execute("SELECT a.id_agenda, a.id_cliente, a.fecha, a.hora, a.estado, a.frecuencia_dias, a.observacion, c.nombres, c.celular, c.zona, c.vendedor FROM tab_agenda_visitas a JOIN tab_clientes c ON a.id_cliente = c.id_cliente " + whereClause + " ORDER BY a.fecha ASC, a.hora ASC LIMIT 200", params);
        const estadoBadge = { pendiente:'bg-warning text-dark', cumplida:'bg-success', pago:'bg-success', cerrado:'bg-secondary', no_contesto:'bg-warning text-dark', ausente:'bg-warning text-dark', pospuso:'bg-warning text-dark' };
        const estadoLabel = { pendiente:'Pendiente', cumplida:'Cumplida', pago:'Pagó', cerrado:'Cerrado', no_contesto:'No Contestó', ausente:'Ausente', pospuso:'Pospuso' };
        const fmtTel = (t) => { const c = t.replace(/\D/g,''); return c.startsWith('58') ? c : '58'+c; };
        const rows = visitas.map(v => {
            const eb = estadoBadge[v.estado] || 'bg-warning text-dark';
            const el = estadoLabel[v.estado] || 'Pendiente';
            const wa = fmtTel(v.celular);
            return `<tr>
            <td><input type="checkbox" class="visita-check" value="${v.id_agenda}"></td>
            <td>${v.id_agenda}</td>
            <td>${v.fecha || ''}</td>
            <td><a href="?vista=cliente&id_cliente=${v.id_cliente}" target="_blank">${v.nombres || ''}</a> <a href="#" onclick="return verHistorial(${v.id_cliente})" title="Historial"><i class="bi bi-clock-history text-secondary ms-1" style="font-size:0.7rem"></i></a></td>
            <td>${v.celular || ''}</td>
            <td>${v.vendedor || ''}</td>
            <td>${v.zona || ''}</td>
            <td><span id="fecha-${v.id_agenda}">${v.fecha || ''}</span>
                <input type="date" id="nueva-fecha-${v.id_agenda}" style="display:none" class="form-control form-control-sm d-inline" style="width:auto">
                <button id="btn-repro-${v.id_agenda}" style="display:none" class="btn btn-sm btn-success" onclick="guardarRepro(${v.id_agenda})">✔</button>
            </td>
            <td>${v.observacion ? v.observacion.substring(0, 40) : ''}</td>
            <td><span class="badge ${eb}">${el}</span></td>
            <td class="no-print">
                <div class="dropdown">
                    <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" style="font-size:0.7rem;padding:2px 6px;">
                        <i class="bi bi-gear"></i>
                    </button>
                    <ul class="dropdown-menu dropdown-menu-end" style="font-size:0.75rem;min-width:170px;">
                        <li><a class="dropdown-item" href="https://wa.me/${wa}" target="_blank"><i class="bi bi-whatsapp text-success me-2"></i>WhatsApp</a></li>
                        <li><hr class="dropdown-divider"></li>
                        <li class="dropdown-header">Resultado de Visita</li>
                        <li><a class="dropdown-item" href="#" onclick="return accionVisita(${v.id_agenda},'pago')"><i class="bi bi-cash text-success me-2"></i>Pagó</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return accionVisita(${v.id_agenda},'no_contesto')"><i class="bi bi-telephone-x text-warning me-2"></i>No Contestó</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return accionVisita(${v.id_agenda},'ausente')"><i class="bi bi-person-x text-warning me-2"></i>Ausente</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return accionVisita(${v.id_agenda},'pospuso')"><i class="bi bi-calendar-x text-warning me-2"></i>Pospuso</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return accionVisita(${v.id_agenda},'cerrado')"><i class="bi bi-lock text-danger me-2"></i>Cerrado</a></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><a class="dropdown-item" href="#" onclick="return posponerVisita(${v.id_agenda})"><i class="bi bi-skip-forward text-warning me-2"></i>Posponer</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return reprogramar(${v.id_agenda})"><i class="bi bi-calendar-event text-info me-2"></i>Cambiar Fecha</a></li>
                        <li><hr class="dropdown-divider"></li>
                        <li class="dropdown-header">Frecuencia</li>
                        <li><a class="dropdown-item" href="#" onclick="return asignaFrec(${v.id_agenda},1)">Diario</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return asignaFrec(${v.id_agenda},7)">Semanal</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return asignaFrec(${v.id_agenda},15)">Quincenal</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return asignaFrec(${v.id_agenda},30)">Mensual</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return asignaFrec(${v.id_agenda},60)">Bimestral</a></li>
                        <li><a class="dropdown-item" href="#" onclick="return asignaFrec(${v.id_agenda},90)">Trimestral</a></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><a class="dropdown-item text-danger" href="#" onclick="return eliminarVisita(${v.id_agenda})"><i class="bi bi-trash me-2"></i>Eliminar</a></li>
                    </ul>
                </div>
            </td>
        </tr>`}).join('');
        const zonaOptions = zonas.map(z => `<option value="${z.zona}"${filtroZona === z.zona ? ' selected' : ''}>${z.zona}</option>`).join('');

        // Calendar
        const hoyCal = new Date();
        const anioCal = hoyCal.getFullYear();
        const mesCal = hoyCal.getMonth();
        const primerDia = new Date(anioCal, mesCal, 1);
        const ultimoDia = new Date(anioCal, mesCal + 1, 0);
        const inicioMes = primerDia.toISOString().split('T')[0];
        const finMes = ultimoDia.toISOString().split('T')[0];
        const [visitasPorDia] = await pool.execute("SELECT a.fecha, COUNT(*) as total FROM tab_agenda_visitas a WHERE a.fecha BETWEEN ? AND ? GROUP BY a.fecha", [inicioMes, finMes]);
        const calMap = {};
        visitasPorDia.forEach(v => { calMap[v.fecha] = v.total; });
        const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        let calRows = '';
        let diaCelda = 1;
        const primerDow = primerDia.getDay();
        const totalDias = ultimoDia.getDate();
        for (let s = 0; s < 6; s++) {
            if (diaCelda > totalDias) break;
            calRows += '<tr>';
            for (let d = 0; d < 7; d++) {
                if ((s === 0 && d < primerDow) || diaCelda > totalDias) {
                    calRows += '<td style="padding:6px"></td>';
                } else {
                    const fechaStr = `${anioCal}-${String(mesCal+1).padStart(2,'0')}-${String(diaCelda).padStart(2,'0')}`;
                    const count = calMap[fechaStr] || 0;
                    const hoyStr = hoyCal.toISOString().split('T')[0];
                    const cls = fechaStr === hoyStr ? 'bg-warning text-dark' : (count > 0 ? 'bg-success text-white' : '');
                    calRows += `<td class="${cls}" style="padding:6px;cursor:pointer;border-radius:6px;text-align:center" onclick="window.location='/visitas?dia=${fechaStr}'">
                        <strong>${diaCelda}</strong><br><small>${count > 0 ? count+' vis' : ''}</small>
                    </td>`;
                    diaCelda++;
                }
            }
            calRows += '</tr>';
        }
        const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><title>Visitas Agendadas</title><style>body{background:#f4f7f6}.card-custom{border-radius:12px;border:none;box-shadow:0 2px 8px rgba(0,0,0,0.06)}@media print{body{background:#fff}.no-print,.no-print-table{display:none!important}.card-custom{box-shadow:none;border:1px solid #ddd}table{font-size:11px}td:first-child,th:first-child{display:none}}</style></head><body class="bg-light">${header}
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
        <div class="container-fluid px-4 mt-3">
        <h3>📅 Agenda de Visitas</h3>

        <div class="row g-3 mb-3 no-print">
        <!-- Filters -->
        <div class="col-md-8">
        <div class="card card-custom p-3">
        <form class="row g-2 align-items-end" method="GET" action="/visitas">
            <div class="col-3">
                <label class="small fw-bold">Zona</label>
                <select name="zona" class="form-select form-select-sm">${zonaOptions}</select>
            </div>
            <div class="col-3">
                <label class="small fw-bold">Ver día</label>
                <input type="date" name="dia" class="form-control form-control-sm" value="${filtroDia}">
            </div>
            <div class="col-2">
                <label class="small fw-bold">Desde</label>
                <input type="date" name="fecha_desde" class="form-control form-control-sm" value="${filtroFechaDesde}">
            </div>
            <div class="col-2">
                <label class="small fw-bold">Hasta</label>
                <input type="date" name="fecha_hasta" class="form-control form-control-sm" value="${filtroFechaHasta}">
            </div>
            <div class="col-2 d-flex gap-1">
                <button type="submit" class="btn btn-sm btn-primary">Filtrar</button>
                <a href="/visitas" class="btn btn-sm btn-outline-secondary">X</a>
                <button onclick="window.print()" class="btn btn-sm btn-info text-white">🖨️</button>
            </div>
        </form>
        </div>
        </div>

        <!-- Move visits -->
        <div class="col-md-4 no-print">
        <div class="card card-custom p-3">
        <div class="row g-2 align-items-end">
            <div class="col-5">
                <label class="small fw-bold">De fecha</label>
                <input type="date" id="mvDesde" class="form-control form-control-sm">
            </div>
            <div class="col-5">
                <label class="small fw-bold">A fecha</label>
                <input type="date" id="mvHasta" class="form-control form-control-sm">
            </div>
            <div class="col-2">
                <button onclick="moverVisitas()" class="btn btn-sm btn-warning">Mover ➡</button>
            </div>
        </div>
        </div>
        </div>
        </div>

        <!-- Calendar -->
        <div class="card card-custom p-3 mb-3 no-print">
        <h5>🗓️ ${meses[mesCal]} ${anioCal}</h5>
        <table class="table table-sm table-borderless mb-0 text-center">
        <thead><tr>${diasSemana.map(d => `<th class="small text-muted">${d}</th>`).join('')}</tr></thead>
        <tbody>${calRows}</tbody>
        </table></div>

        <div class="card card-custom p-3">
        <div class="d-flex justify-content-between align-items-center mb-2 no-print">
            <h5>Visitas (${visitas.length})</h5>
            <div><input class="form-check-input" type="checkbox" id="checkAllVis" onchange="document.querySelectorAll('.visita-check').forEach(c=>c.checked=this.checked)"> <label class="form-check-label small">Sel. Todos</label></div>
        </div>
        <!-- Metrics -->
        ${(()=>{
            const totalVis = visitas.length;
            const cumplidas = visitas.filter(v => v.estado === 'cumplida' || v.estado === 'pago').length;
            const pct = totalVis > 0 ? Math.round(cumplidas/totalVis*100) : 0;
            const vendedores = {};
            visitas.forEach(v => { const nom = v.vendedor || 'N/A'; vendedores[nom] = (vendedores[nom]||0)+1; });
            const vendedorTop = Object.entries(vendedores).sort((a,b)=>b[1]-a[1]).slice(0,3);
            return `<div class="row g-2 mb-3 no-print">
                <div class="col-6 col-md-3"><div class="border rounded p-2 text-center bg-light"><small class="text-muted">Total</small><div class="fw-bold fs-5">${totalVis}</div></div></div>
                <div class="col-6 col-md-3"><div class="border rounded p-2 text-center bg-light"><small class="text-muted">Cumplidas</small><div class="fw-bold fs-5 text-success">${cumplidas} <small class="fs-6">(${pct}%)</small></div></div></div>
                <div class="col-6 col-md-3"><div class="border rounded p-2 text-center bg-light"><small class="text-muted">Pendientes</small><div class="fw-bold fs-5 text-warning">${totalVis - cumplidas}</div></div></div>
                <div class="col-6 col-md-3"><div class="border rounded p-2 text-center bg-light"><small class="text-muted">Top</small><div class="fw-bold fs-6">${vendedorTop.map(([n,c]) => n.split(' ')[0]+'('+c+')').join(', ')}</div></div></div>
            </div>`;
        })()}
        <div class="table-responsive">
        <table class="table table-hover table-sm align-middle">
        <thead class="table-light"><tr><th style="width:36px">Sel</th><th>ID</th><th>Fecha</th><th>Cliente</th><th>Celular</th><th>Vendedor</th><th>Zona</th><th>Acuerdo</th><th>Observación</th><th>Estado</th><th style="width:60px" class="no-print">Acción</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="11" class="text-center text-muted">Sin visitas</td></tr>'}</tbody>
        </table></div></div>
        <a href="/" class="btn btn-outline-secondary mt-2 no-print">⬅ Volver</a>
        </div>
        <script>
        function reprogramar(id, nombre){
            document.getElementById('fecha-'+id).style.display='none';
            document.getElementById('nueva-fecha-'+id).style.display='inline';
            document.getElementById('btn-repro-'+id).style.display='inline';
            return false;
        }
        async function guardarRepro(id){
            const nuevaFecha=document.getElementById('nueva-fecha-'+id).value;
            if(!nuevaFecha)return alert("Selecciona una fecha.");
            try{
                const r=await fetch('/reprogramar-visita',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_visita:id,nueva_fecha:nuevaFecha})});
                const t=await r.text();alert(t);location.reload();
            }catch(e){alert('Error: '+e.message);}
        }
        async function moverVisitas(){
            const desde=document.getElementById('mvDesde').value;
            const hasta=document.getElementById('mvHasta').value;
            if(!desde||!hasta)return alert("Selecciona ambas fechas.");
            if(!confirm("Mover TODAS las visitas de "+desde+" a "+hasta+"?"))return;
            try{
                const r=await fetch('/mover-visitas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({desde,hasta})});
                const t=await r.text();alert(t);location.reload();
            }catch(e){alert('Error: '+e.message);}
        }
        async function accionVisita(id, estado){
            if(!confirm("¿Marcar visita #"+id+" como "+estado+"?"))return false;
            try{
                const r=await fetch('/accion-visita',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_agenda:id,estado})});
                const t=await r.text();alert(t);if(t.includes('✅'))location.reload();
            }catch(e){alert('Error: '+e.message);}
            return false;
        }
        async function posponerVisita(id){
            if(!confirm("¿Posponer visita #"+id+" al próximo día hábil?"))return false;
            try{
                const r=await fetch('/accion-visita',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_agenda:id,estado:'posponer'})});
                const t=await r.text();alert(t);if(t.includes('✅'))location.reload();
            }catch(e){alert('Error: '+e.message);}
            return false;
        }
        async function asignaFrec(id, dias){
            if(!confirm("¿Asignar frecuencia de "+dias+" días a visita #"+id+"?"))return false;
            try{
                const r=await fetch('/accion-visita',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_agenda:id,estado:'frecuencia',frecuencia_dias:dias})});
                const t=await r.text();alert(t);if(t.includes('✅'))location.reload();
            }catch(e){alert('Error: '+e.message);}
            return false;
        }
        async function eliminarVisita(id){
            if(!confirm("¿Eliminar visita #"+id+"?"))return false;
            try{
                const r=await fetch('/accion-visita',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_agenda:id,estado:'eliminar'})});
                const t=await r.text();alert(t);if(t.includes('✅'))location.reload();
            }catch(e){alert('Error: '+e.message);}
            return false;
        }
        async function verHistorial(idCliente){
            const r=await fetch('/historial-cliente?id_cliente='+idCliente);
            const data=await r.json();
            if(!data.length){alert('Sin historial.');return false;}
            let h='<table class="table table-sm table-striped mb-0"><thead><tr><th>Fecha</th><th>Estado</th><th>Observación</th></tr></thead><tbody>';
            data.forEach(v=>{h+='<tr><td>'+v.fecha+'</td><td><span class="badge bg-secondary">'+(v.estado||'pendiente')+'</span></td><td>'+(v.observacion||'')+'</td></tr>';});
            h+='</tbody></table>';
            const d=document.getElementById('historialModal');
            d.querySelector('.modal-body').innerHTML=h;
            new bootstrap.Modal(d).show();
            return false;
        }
        </script>
        <!-- Historial Modal -->
        <div class="modal fade" id="historialModal" tabindex="-1"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Historial de Visitas</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"></div></div></div></div>
        </body></html>`);
    } else if (routename === '/accion-visita' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                const { id_agenda, estado } = data;
                if (estado === 'eliminar') {
                    await dualExecute("DELETE FROM tab_agenda_visitas WHERE id_agenda = ?", [id_agenda]);
                    res.end(`✅ Visita #${id_agenda} eliminada.`);
                } else if (estado === 'posponer') {
                    const [rows] = await pool.execute("SELECT fecha FROM tab_agenda_visitas WHERE id_agenda = ?", [id_agenda]);
                    if (rows.length === 0) { res.end("❌ Visita no encontrada."); return; }
                    let nueva = new Date(rows[0].fecha);
                    nueva.setDate(nueva.getDate() + 1);
                    while (nueva.getDay() === 0 || nueva.getDay() === 6) nueva.setDate(nueva.getDate() + 1);
                    const nuevaStr = nueva.toISOString().split('T')[0];
                    await dualExecute("UPDATE tab_agenda_visitas SET fecha = ? WHERE id_agenda = ?", [nuevaStr, id_agenda]);
                    res.end(`✅ Visita #${id_agenda} pospuesta al ${nuevaStr}.`);
                } else if (estado === 'frecuencia') {
                    const fd = parseInt(data.frecuencia_dias) || 0;
                    await dualExecute("UPDATE tab_agenda_visitas SET frecuencia_dias = ?, fecha_origen = COALESCE(fecha_origen, CURDATE()) WHERE id_agenda = ?", [fd, id_agenda]);
                    res.end(`✅ Frecuencia de ${fd} días asignada a visita #${id_agenda}.`);
                } else if (['pago','cumplida','no_contesto','ausente','pospuso','cerrado'].includes(estado)) {
                    await dualExecute("UPDATE tab_agenda_visitas SET estado = ? WHERE id_agenda = ?", [estado, id_agenda]);
                    res.end(`✅ Visita #${id_agenda} marcada como ${estado}.`);
                } else {
                    res.end("❌ Acción no válida.");
                }
            } catch (e) { res.end("Error: " + e.message); }
        });
    } else if (routename === '/reprogramar-visita' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                await dualExecute("UPDATE tab_agenda_visitas SET fecha = ? WHERE id_agenda = ?", [data.nueva_fecha, data.id_visita]);
                res.end(`✅ Visita #${data.id_visita} reprogramada para ${data.nueva_fecha}.`);
            } catch (e) { res.end("Error: " + e.message); }
        });
    } else if (routename === '/enviar-recordatorio-estado' && req.method === 'POST') {
        if (!isBotReady()) { res.end("Bot no listo."); return; }
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                const ids = data.clientes || [];
                if (ids.length === 0) { res.end("Ningún cliente seleccionado."); return; }
                res.end(`✅ Envío iniciado para ${ids.length} cliente(s).`);
                setTimeout(async () => {
                    let cont = 0;
                    const bs = sendConfig.batchSize;
                    const pb = sendConfig.pauseBatch;
                    for (let i = 0; i < ids.length; i++) {
                        if (i > 0 && i % bs === 0) { console.log(`[REC ESTADO] Pausa ${pb/60000}min lote ${i}/${ids.length}...`); await sleep(pb); }
                        const [clientes] = await pool.execute("SELECT id_cliente, nombres, celular FROM tab_clientes WHERE id_cliente = ?", [ids[i]]);
                        const c = clientes[0];
                        if (!c) continue;
                        const [facturas] = await pool.execute("SELECT nro_factura, total, abono_factura, porcentaje, DATEDIFF(CURDATE(), fecha_reg) as dias FROM tab_facturas WHERE id_cliente = ? AND pagada='NO' AND anulado='no' ORDER BY fecha_reg ASC LIMIT 1", [c.id_cliente]);
                        const f = facturas[0];
                        const notaStr = f ? `#${f.nro_factura}` : 'pendiente';
                        const diasStr = f ? `${f.dias} días` : 'varios días';
                        const divisas = f ? (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) : 0;
                        const bcv = (divisas && f) ? (divisas / (parseFloat(f.porcentaje) || 1)) : 0;
                        const jid = formatWhatsApp(c.celular);
                        if (!jid) continue;
                        const tpl = pickTemplate(MESSAGE_TEMPLATES.recordatorioEstado);
                        const msg = tpl(c.nombres, notaStr, divisas.toFixed(2), diasStr, bcv.toFixed(2));
                        await safeSendMessage(jid, { text: msg });
                        cont++;
                        await humanDelay(25, 50);
                    }
                    console.log(`[RECORDATORIO ESTADO] ${cont}/${ids.length} enviado(s).`);
                }, 500);
            } catch (e) { res.end("Error: " + e.message); }
        });
    } else if (routename === '/enviar-recordatorio-visita' && req.method === 'POST') {
        if (!isBotReady()) { res.end("Bot no listo."); return; }
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                const ids = data.clientes || [];
                if (ids.length === 0) { res.end("Ningún cliente seleccionado."); return; }
                res.end(`✅ Envío iniciado para ${ids.length} cliente(s).`);
                setTimeout(async () => {
                    let cont = 0;
                    const bs = sendConfig.batchSize;
                    const pb = sendConfig.pauseBatch;
                    const lunes = new Date();
                    lunes.setDate(lunes.getDate() - ((lunes.getDay() + 6) % 7));
                    const semanaInicio = lunes.toISOString().split('T')[0];
                    for (let i = 0; i < ids.length; i++) {
                        if (i > 0 && i % bs === 0) { console.log(`[REC VISITA] Pausa ${pb/60000}min lote ${i}/${ids.length}...`); await sleep(pb); }
                        const [clientes] = await pool.execute("SELECT id_cliente, nombres, celular FROM tab_clientes WHERE id_cliente = ?", [ids[i]]);
                        const c = clientes[0];
                        if (!c) continue;
                        const jid = formatWhatsApp(c.celular);
                        if (!jid) continue;
                        const tpl = pickTemplate(MESSAGE_TEMPLATES.recordatorioVisita);
                        const msg = tpl(c.nombres);
                        await safeSendMessage(jid, { text: msg });
                        await dualExecute("INSERT IGNORE INTO recordatorio_visita_log (id_cliente, semana_inicio) VALUES (?, ?)", [c.id_cliente, semanaInicio]);
                        cont++;
                        await humanDelay(25, 50);
                    }
                    console.log(`[RECORDATORIO VISITA] ${cont}/${ids.length} enviado(s).`);
                }, 500);
            } catch (e) { res.end("Error: " + e.message); }
        });
    } else if (routename === '/recordatorio-estado') {
        if (query.force) {
            if (!isBotReady()) { res.writeHead(302, { Location: '/recordatorio-estado?error=Bot+no+listo' }); res.end(); return; }
            res.writeHead(302, { Location: '/recordatorio-estado?success=Forzado+iniciado' });
            res.end();
            setTimeout(async () => {
                const [todos] = await pool.execute("SELECT DISTINCT c.id_cliente, c.nombres, c.celular FROM tab_clientes c JOIN tab_facturas f ON c.id_cliente = f.id_cliente WHERE f.pagada='NO' AND f.anulado='no' AND c.activo='si'");
                let cont = 0;
                const bs = sendConfig.batchSize;
                const pb = sendConfig.pauseBatch;
                for (let i = 0; i < todos.length; i++) {
                    if (i > 0 && i % bs === 0) { console.log(`[REC ESTADO] Pausa ${pb/60000}min lote ${i}/${todos.length}...`); await sleep(pb); }
                    const c = todos[i];
                    const [facturas] = await pool.execute("SELECT nro_factura, total, abono_factura, porcentaje, DATEDIFF(CURDATE(), fecha_reg) as dias FROM tab_facturas WHERE id_cliente = ? AND pagada='NO' AND anulado='no' ORDER BY fecha_reg ASC LIMIT 1", [c.id_cliente]);
                    const f = facturas[0];
                    const notaStr = f ? `#${f.nro_factura}` : 'pendiente';
                    const diasStr = f ? `${f.dias} días` : 'varios días';
                    const divisas = f ? (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) : 0;
                    const bcv = (divisas && f) ? (divisas / (parseFloat(f.porcentaje) || 1)) : 0;
                    const jid = formatWhatsApp(c.celular);
                    if (!jid) continue;
                    const tpl = pickTemplate(MESSAGE_TEMPLATES.recordatorioEstado);
                    const msg = tpl(c.nombres, notaStr, divisas.toFixed(2), diasStr, bcv.toFixed(2));
                    await safeSendMessage(jid, { text: msg });
                    cont++;
                    await humanDelay(25, 50);
                }
                console.log(`[RECORDATORIO ESTADO] Forzado: ${cont} enviado(s).`);
            }, 500);
            return;
        }
        const [zonas] = await pool.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' AND zona IS NOT NULL ORDER BY zona");
        const [vendedores] = await pool.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != '' AND vendedor IS NOT NULL ORDER BY vendedor");
        const filtroZona = query.zona || '';
        const filtroVendedor = query.vendedor || '';
        let sql = `SELECT c.id_cliente, c.nombres, c.celular, c.zona, c.vendedor,
                   SUM((f.total - f.abono_factura) / (f.porcentaje || 1)) as saldo_total,
                   COUNT(f.id_factura) as cantidad_facturas,
                   MAX(DATEDIFF(CURDATE(), f.fecha_reg)) as dias_vencida
                   FROM tab_clientes c JOIN tab_facturas f ON c.id_cliente = f.id_cliente
                   WHERE f.pagada = 'NO' AND f.anulado = 'no' AND c.activo = 'si'`;
        const params = [];
        if (filtroZona) { sql += " AND c.zona = ?"; params.push(filtroZona); }
        if (filtroVendedor) { sql += " AND c.vendedor = ?"; params.push(filtroVendedor); }
        sql += " GROUP BY c.id_cliente HAVING saldo_total > 0 ORDER BY dias_vencida DESC";
        const [deudores] = await pool.execute(sql, params);
        const [yaNotificados] = await pool.execute("SELECT id_cliente, COUNT(*) as total FROM recordatorios_log rl JOIN tab_facturas f ON rl.id_factura = f.id_factura GROUP BY f.id_cliente");
        const notifSet = new Set(yaNotificados.map(r => r.id_cliente));
        const zonaOpts = zonas.map(z => `<option value="${z.zona}"${filtroZona === z.zona?' selected':''}>${z.zona}</option>`).join('');
        const vendOpts = vendedores.map(v => `<option value="${v.vendedor}"${filtroVendedor === v.vendedor?' selected':''}>${v.vendedor}</option>`).join('');
        const filas = deudores.map(d => `<tr>
            <td><input type="checkbox" class="cliente-check-rec" value="${d.id_cliente}" checked></td>
            <td>${d.nombres}</td><td>${d.celular || ''}</td>
            <td><span class="badge bg-secondary">${d.zona || ''}</span></td>
            <td>${d.vendedor || ''}</td>
            <td class="text-center">${d.cantidad_facturas}</td>
            <td class="text-end text-danger fw-bold">$${parseFloat(d.saldo_total).toFixed(2)}</td>
            <td class="text-center">${d.dias_vencida}d</td>
            <td>${notifSet.has(d.id_cliente) ? '<span class="badge bg-success">✅</span>' : '<span class="badge bg-warning text-dark">⏳</span>'}</td>
        </tr>`).join('');
        res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>Recordatorios de Pago</title><style>body{background:#f4f7f6}.card-custom{border-radius:15px;border:none;box-shadow:0 4px 12px rgba(0,0,0,0.08)}</style></head><body>${header}
        <div class="container-fluid px-4 mt-3">
        ${query.error ? `<div class="alert alert-danger">❌ ${query.error}</div>` : ''}
        ${query.success ? `<div class="alert alert-success">✅ ${query.success}</div>` : ''}
        <details class="mb-2" style="max-width:500px">
        <summary style="cursor:pointer;font-size:0.9rem">⚙️ Configurar envíos</summary>
        <div class="card card-body p-2 mb-2">
        <div class="row g-2 align-items-end">
            <div class="col-auto"><label class="small">Bloque</label><input type="number" id="cfgBatch" class="form-control form-control-sm" value="${sendConfig.batchSize}" style="width:80px"></div>
            <div class="col-auto"><label class="small">Pausa/msg (seg)</label><input type="number" id="cfgPauseSend" class="form-control form-control-sm" value="${sendConfig.pauseSend/1000}" style="width:90px"></div>
            <div class="col-auto"><label class="small">Pausa/lote (min)</label><input type="number" id="cfgPauseBatch" class="form-control form-control-sm" value="${sendConfig.pauseBatch/60000}" style="width:90px"></div>
            <div class="col-auto"><button onclick="guardarConfigRec()" class="btn btn-sm btn-outline-dark">Guardar</button></div>
        </div></div></details>
        <div class="card card-custom p-4 mb-4">
        <div class="row align-items-end">
            <div class="col-md-4"><h4>📢 Recordatorios de Pago</h4><p class="text-muted small">Clientes con facturas vencidas.</p></div>
            <div class="col-md-4">
            <form method="GET" action="/recordatorio-estado" class="row g-2">
                <div class="col-6">
                    <label class="small fw-bold">Zona:</label>
                    <select name="zona" class="form-select form-select-sm"><option value="">Todas</option>${zonaOpts}</select>
                </div>
                <div class="col-6">
                    <label class="small fw-bold">Vendedor:</label>
                    <select name="vendedor" class="form-select form-select-sm"><option value="">Todos</option>${vendOpts}</select>
                </div>
                <div class="col-12 mt-2"><button type="submit" class="btn btn-dark w-100 btn-sm">Filtrar</button></div>
            </form>
            </div>
            <div class="col-md-4 text-end">
                <button onclick="enviarRecordatorio()" class="btn btn-danger btn-lg px-4 shadow">🚀 Enviar a Seleccionados</button>
                <a href="/recordatorio-estado?force=1" class="btn btn-warning btn-sm mt-1">📨 Forzar Todos</a>
                <div id="statusRec" class="mt-1 small fw-bold"></div>
            </div>
        </div>
        </div>
        <div class="card card-custom p-4">
        <div class="d-flex justify-content-between align-items-center mb-2">
            <h5>Deudores (${deudores.length})</h5>
            <div><input class="form-check-input" type="checkbox" id="selectAllRec" checked onclick="toggleAllRec()"> <label class="form-check-label small">Sel. Todos</label></div>
        </div>
        <div class="table-responsive">
        <table class="table table-hover align-middle table-sm">
        <thead class="table-light"><tr><th style="width:40px">Sel</th><th>Cliente</th><th>Celular</th><th>Zona</th><th>Vendedor</th><th class="text-center">Fact.</th><th class="text-end">Saldo</th><th class="text-center">Días</th><th>Notif.</th></tr></thead>
        <tbody>${filas}</tbody></table></div>
        </div></div>
        <script>
        function toggleAllRec(){const ch=document.getElementById('selectAllRec').checked;document.querySelectorAll('.cliente-check-rec').forEach(c=>c.checked=ch);}
        async function guardarConfigRec(){
            const d={batchSize:document.getElementById('cfgBatch').value,pauseSend:document.getElementById('cfgPauseSend').value*1000,pauseBatch:document.getElementById('cfgPauseBatch').value*60000};
            try{await fetch('/set-send-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});alert('Config guardada.');}catch(e){alert('Error: '+e.message);}
        }
        async function enviarRecordatorio(){
            const sel=Array.from(document.querySelectorAll('.cliente-check-rec:checked')).map(c=>c.value);
            if(sel.length===0)return alert("Selecciona al menos un cliente.");
            if(!confirm("Enviar recordatorio a "+sel.length+" cliente(s)?"))return;
            const st=document.getElementById('statusRec');st.className="mt-1 small fw-bold text-primary";st.innerHTML="⏳ Enviando...";
            try{
                const r=await fetch('/enviar-recordatorio-estado',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientes:sel})});
                const t=await r.text();alert(t);st.className="mt-1 small fw-bold text-success";st.innerHTML="✅ Enviado!";
            }catch(e){st.className="mt-1 small fw-bold text-danger";st.innerHTML="❌ "+e.message;}
        }
        </script>
        </body></html>`);
    } else if (routename === '/agendar-zona' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                const { zona, fecha, frecuencia } = data;
                if (!zona || !fecha) { res.end("Faltan datos."); return; }
                const [clientes] = await pool.execute("SELECT id_cliente, nombres, direccion, telefono, celular, zona, vendedor FROM tab_clientes WHERE zona = ? AND activo = 'si'", [zona]);
                if (clientes.length === 0) { res.end("No hay clientes en esa zona."); return; }
                res.end(`✅ ${clientes.length} visita(s) agendada(s) para el ${fecha}.`);
                setTimeout(async () => {
                    let ins = 0;
                    for (const c of clientes) {
                        const vendNom = c.vendedor || '';
                        const [vend] = await pool.execute("SELECT id_vendedor FROM tab_vendedores WHERE nombre = ? LIMIT 1", [vendNom]);
                        const idV = vend.length > 0 ? vend[0].id_vendedor : 0;
                        await dualExecute(
                            "INSERT IGNORE INTO tab_agenda_visitas (id_cliente, fecha, estado, frecuencia_dias, observacion) VALUES (?, ?, 'pendiente', ?, ?)",
                            [c.id_cliente, fecha, parseInt(frecuencia) || null, 'Agendamiento masivo por zona']
                        );
                        ins++;
                        await sleep(500);
                    }
                    console.log(`[AGENDAR ZONA] ${ins} visitas creadas para zona ${zona}`);
                }, 500);
            } catch (e) { res.end("Error: " + e.message); }
        });
    } else if (routename === '/mover-visitas' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                const { desde, hasta } = data;
                if (!desde || !hasta) { res.end("Faltan fechas."); return; }
                const [result] = await dualExecute("UPDATE tab_agenda_visitas SET fecha = ? WHERE fecha = ? AND estado IN ('pendiente','no_contesto','ausente','pospuso')", [hasta, desde]);
                res.end(`✅ ${result.affectedRows} visita(s) movida(s) de ${desde} a ${hasta}.`);
            } catch (e) { res.end("Error: " + e.message); }
        });
    } else if (routename === '/sync-agenda') {
        try {
            const sqlCreate = `CREATE TABLE IF NOT EXISTS tab_agenda_visitas (
                id_agenda INT AUTO_INCREMENT PRIMARY KEY,
                id_cliente INT NOT NULL,
                fecha DATE NOT NULL,
                hora TIME DEFAULT NULL,
                frecuencia_dias INT DEFAULT NULL,
                estado VARCHAR(20) DEFAULT 'pendiente',
                fecha_origen DATE DEFAULT NULL,
                observacion TEXT DEFAULT NULL,
                UNIQUE KEY uq_cliente_fecha (id_cliente, fecha),
                INDEX idx_fecha_estado (fecha, estado),
                INDEX idx_cliente (id_cliente)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_spanish_ci`;
            try { await poolLocal.execute(sqlCreate); } catch(e) {}
            try { await pool.execute(sqlCreate); } catch(e) {}
            const [locales] = await poolLocal.execute("SELECT * FROM tab_agenda_visitas ORDER BY id_agenda");
            let insertados = 0;
            for (const rec of locales) {
                const [existe] = await pool.execute("SELECT id_agenda FROM tab_agenda_visitas WHERE id_agenda = ?", [rec.id_agenda]);
                if (existe.length === 0) {
                    try {
                        await pool.execute(
                            "INSERT INTO tab_agenda_visitas (id_agenda, id_cliente, fecha, hora, frecuencia_dias, estado, fecha_origen, observacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            [rec.id_agenda, rec.id_cliente, rec.fecha, rec.hora || null, rec.frecuencia_dias || null, rec.estado || 'pendiente', rec.fecha_origen || null, rec.observacion || null]
                        );
                        insertados++;
                    } catch (e) { console.log("[SYNC] Error insertando id_agenda=" + rec.id_agenda + ":", e.message); }
                }
            }
            res.end(`<html><body style="font-family:sans-serif;padding:20px"><h2>✅ Sincronización completada</h2><p>Registros locales: ${locales.length}</p><p>Copiados a remoto: ${insertados}</p><p>Ya existían en remoto: ${locales.length - insertados}</p><a href="/" style="display:inline-block;margin-top:12px;padding:8px 20px;background:#333;color:#fff;border-radius:6px;text-decoration:none">Volver</a></body></html>`);
        } catch (e) { res.end("Error: " + e.message); }
    } else if (routename === '/sync-facturas') {
        const dir = query.dir || 'both'; // 'both', 'local-to-remote', 'remote-to-local'
        res.writeHead(302, { 'Location': '/' });
        res.end();
        setTimeout(async () => {
            try {
                if (dir === 'both' || dir === 'local-to-remote') {
                    console.log("[SYNC-FACTURAS] Iniciando Local → Remoto...");
                    const r1 = await syncFacturasLocalRemoto();
                    console.log("[SYNC-FACTURAS] Local → Remoto:", JSON.stringify(r1));
                }
                if (dir === 'both' || dir === 'remote-to-local') {
                    console.log("[SYNC-FACTURAS] Iniciando Remoto → Local...");
                    const r2 = await syncFacturasRemotoALocal();
                    console.log("[SYNC-FACTURAS] Remoto → Local:", JSON.stringify(r2));
                }
                console.log("[SYNC-FACTURAS] ✅ Sincronización completada.");
            } catch (e) {
                console.log("[SYNC-FACTURAS] Error:", e.message);
            }
        }, 500);
    } else if (routename === '/sync-facturas-status') {
        // Ver estado de sincronización: diferencias entre local y remoto
        try {
            const [remotoCount] = await pool.execute("SELECT COUNT(*) as total FROM tab_facturas");
            const [localCount] = await poolLocal.execute("SELECT COUNT(*) as total FROM tab_facturas");
            const [remotoNotif] = await pool.execute("SELECT COUNT(*) as total FROM tab_facturas WHERE whatsapp_notificado = 'SI'");
            const [localNotif] = await poolLocal.execute("SELECT COUNT(*) as total FROM tab_facturas WHERE whatsapp_notificado = 'SI'");
            const [soloRemoto] = await pool.execute(
                "SELECT COUNT(*) as total FROM tab_facturas f WHERE NOT EXISTS (SELECT 1 FROM tab_facturas fl WHERE fl.id_factura = f.id_factura)"
            );

            // Verificar si las columnas existen en local
            let localHasCols = false;
            try {
                const [cols] = await poolLocal.execute("SHOW COLUMNS FROM tab_facturas LIKE 'whatsapp_notificado'");
                localHasCols = cols.length > 0;
            } catch (e) {}

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                remoto: { total: remotoCount[0].total, notificados: remotoNotif[0].total },
                local: { total: localCount[0].total, notificados: localNotif[0].total, tieneColumnasWH: localHasCols },
                soloEnRemoto: soloRemoto[0].total,
                diferencia: remotoCount[0].total - localCount[0].total
            }, null, 2));
        } catch (e) { res.end(JSON.stringify({ error: e.message })); }
    } else if (routename === '/historial-cliente') {
        const idCliente = parseInt(url.searchParams.get('id_cliente')) || 0;
        if (!idCliente) { res.end(JSON.stringify([])); return; }
        try {
            const [rows] = await pool.execute("SELECT a.id_agenda, a.fecha, a.estado, a.observacion FROM tab_agenda_visitas a WHERE a.id_cliente = ? ORDER BY a.fecha DESC LIMIT 20", [idCliente]);
            res.end(JSON.stringify(rows));
        } catch (e) { res.end(JSON.stringify([])); }
    } else if (routename === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            bot: isBotReady() ? 'online' : 'offline',
            ia: ia.estaHabilitada() ? 'activa' : 'desactivada',
            procesos: procesosEstado,
            hora: new Date().toISOString()
        }));
    } else if (routename === '/entrenar' && req.method === 'POST') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const params = new URLSearchParams(b);
                const texto = params.get('instrucciones') || '';
                if (texto.trim() === '') { res.writeHead(302, { Location: '/entrenar?action=error' }); return res.end(); }
                ia.guardarInstrucciones(texto);
                await guardarInstruccionesBD(texto);
                res.writeHead(302, { Location: '/entrenar?action=guardado' });
                res.end();
            } catch (e) {
                console.log("[ENTRENAR] Error guardando:", e.message);
                res.writeHead(302, { Location: '/entrenar?action=error' });
                res.end();
            }
        });
    } else if (routename === '/entrenar') {
        let accion = query.action || '';
        const instruccionesActual = ia.textoInstrucciones();
        const procesosRows = PROCESOS_DISPO.map(p => {
            const activo = proceActivo(p.id);
            const badge = activo
                ? '<span class="badge bg-success" style="border-radius:20px;font-size:0.68rem">🟢 Encendido</span>'
                : '<span class="badge bg-danger" style="border-radius:20px;font-size:0.68rem">🔴 Apagado</span>';
            return `<div class="d-flex align-items-center justify-content-between p-2 border-bottom" style="border-color:rgba(255,255,255,0.08)!important">
                <div>
                    <div class="fw-bold" style="font-size:.9rem">${p.icono} ${p.nombre}</div>
                    <small class="text-white-50" style="font-size:.75rem">${p.desc}</small>
                </div>
                <div class="d-flex align-items-center gap-2">
                    ${badge}
                    ${p.id !== 'ia' ? `<button class="btn btn-sm btn-outline-success" style="border-radius:10px" onclick="runProc('${p.id}')">▶ Ejecutar</button>` : ''}
                    <button class="btn btn-sm ${activo ? 'btn-outline-danger' : 'btn-outline-success'}" style="border-radius:10px" onclick="toggleProc('${p.id}')">${activo ? 'Apagar' : 'Encender'}</button>
                </div>
            </div>`;
        }).join('');
        const linkDeploy = 'https://dashboard.render.com/web/srv-d9v94m3l550s7381avog';
        const linkCron = 'https://console.cron-job.org/jobs';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
<title>Entrenamiento del Bot IA</title>
<style>
body{background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;font-family:'Segoe UI',system-ui,sans-serif;color:#fff}
.card-dash{background:rgba(255,255,255,0.06);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;color:#fff}
.txt-ia{background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.15);color:#e6e6e6;border-radius:12px;font-family:consolas,monospace;font-size:.82rem;line-height:1.5}
.txt-ia:focus{outline:none;border-color:#7b6cff;box-shadow:0 0 0 3px rgba(123,108,255,.25)}
.btn-acc{background:linear-gradient(135deg,#4f8cff,#7b6cff);border:0;border-radius:12px;font-weight:700}
.btn-acc:hover{filter:brightness(1.1)}
.link-ext{color:#9db4ff;text-decoration:none;font-size:.82rem}
.link-ext:hover{color:#fff;text-decoration:underline}
</style></head>
<body>
${header}
<div class="container pb-4">
<div class="row g-3 mb-3">
<div class="col-md-4"><a href="${linkDeploy}" target="_blank" class="card-dash d-block p-3 h-100 text-decoration-none" style="color:#fff">
<div class="fw-bold mb-1"><i class="bi bi-rocket-takeoff me-1"></i> Render (Deploy)</div>
<small class="link-ext">dashboard.render.com/web/srv-d9v94m3l550s7381avog</small></a></div>
<div class="col-md-4"><a href="${linkCron}" target="_blank" class="card-dash d-block p-3 h-100 text-decoration-none" style="color:#fff">
<div class="fw-bold mb-1"><i class="bi bi-clock-history me-1"></i> cron-job.org (Conexión)</div>
<small class="link-ext">console.cron-job.org/jobs</small></a></div>
<div class="col-md-4"><a href="/sql" class="card-dash d-block p-3 h-100 text-decoration-none" style="color:#fff">
<div class="fw-bold mb-1"><i class="bi bi-database me-1"></i> Consultas SQL</div>
<small class="link-ext">Explora las tablas y haz consultas de lectura</small></a></div>
<div class="col-md-4"><div class="card-dash p-3 h-100">
<div class="fw-bold mb-1"><i class="bi bi-cpu me-1"></i> Estado del Bot</div>
${isBotReady() ? '<span class="badge bg-success" style="border-radius:20px">🟢 Online</span>' : '<span class="badge bg-danger" style="border-radius:20px">🔴 Offline</span>'}
<span class="ms-2 text-white-50 small">IA: ${ia.estaHabilitada() ? '🟢' : '🔴'}</span>
<button class="btn btn-sm btn-outline-light ms-2" style="border-radius:10px" onclick="location.href='/ping'">Ver /ping</button>
</div></div></div>
${accion === 'guardado' ? '<div class="alert alert-success py-2" style="border-radius:12px">✅ Entrenamiento del bot guardado. La IA lo usará inmediatamente.</div>' : ''}
${accion === 'seguir' ? '<div class="alert alert-success py-2" style="border-radius:12px">✅ Proceso actualizado.</div>' : ''}
${accion === 'runok' ? '<div class="alert alert-info py-2" style="border-radius:12px">▶ Proceso ejecutado. Revisa el dashboard/historial para ver resultados.</div>' : ''}
${accion === 'botoff' ? '<div class="alert alert-warning py-2" style="border-radius:12px">⚠️ El bot de WhatsApp está offline; no se pudo ejecutar el proceso.</div>' : ''}
${accion === 'error' ? '<div class="alert alert-danger py-2" style="border-radius:12px">❌ Hubo un error, revisa la consola del bot.</div>' : ''}
<div class="row g-3">
<div class="col-lg-7">
<div class="card-dash p-4">
<h5 class="mb-1"><i class="bi bi-robot me-2"></i>Entrenar al Bot (instrucciones.txt)</h5>
<p class="text-white-50 small mb-3">El sistema reemplaza ${'${fecha}'} y las tasas de dólar automáticamente.</p>
<form method="POST" action="/entrenar">
<textarea class="form-control txt-ia mb-3" name="instrucciones" rows="22">${instruccionesActual.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
<div class="d-flex gap-2 flex-wrap">
<button class="btn btn-acc px-4" type="submit"><i class="bi bi-save me-1"></i>Guardar Entrenamiento</button>
<a class="btn btn-outline-light" style="border-radius:12px" href="/">Volver al Admin</a>
</div>
</form>
</div>
</div>
<div class="col-lg-5">
<div class="card-dash p-4">
<h5 class="mb-2"><i class="bi bi-toggle-on me-2"></i>Procesos del Bot</h5>
<p class="text-white-50 small mb-2">Enciende o apaga cada proceso. El estado se guarda en la BD.</p>
${procesosRows}
</div>
</div>
</div>
</div>
<script>
async function toggleProc(id){
    if(!confirm('¿Cambiar el estado del proceso?'))return;
    const r=await fetch('/procesos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const t=await r.text();
    location.href='/entrenar?action='+(t==='OK'?'seguir':'error');
}
async function runProc(id){
    if(!confirm('¿Ejecutar ahora este proceso manualmente?'))return;
    const r=await fetch('/procesos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accion:'run'})});
    const t=await r.text();
    location.href='/entrenar?action='+(t==='OK'?'runok':(t==='BOT_OFFLINE'?'botoff':'error'));
}
</script>
</body></html>`);
    } else if (routename === '/procesos' && req.method === 'POST') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(b);
                const accion = data.accion === 'run' ? 'run' : 'toggle';
                if (data && data.id && PROCESOS_DISPO.some(p => p.id === data.id)) {
                    if (accion === 'run') {
                        const dis = {
                            notificador: () => checkNuevasFacturas(),
                            recordatorio: () => checkFacturasVencidas(),
                            cobranza: () => checkVendedoresRecordatorio(true),
                            estadisticas: () => checkEstadisticasVendedores(true),
                            dolar: () => actualizarDolar()
                        };
                        const fn = dis[data.id];
                        if (fn) {
                            if (data.id !== 'dolar' && !isBotReady()) { res.end("BOT_OFFLINE"); return; }
                            fn().catch(e => console.log("[PROCESOS] Error al ejecutar", data.id, e.message));
                            res.end("OK");
                        } else {
                            res.end("ERROR");
                        }
                        return;
                    }
                    procesosEstado[data.id] = !procesosEstado[data.id];
                    if (typeof procesosEstado[data.id] !== 'boolean') procesosEstado[data.id] = true;
                    if (data.id === 'ia') {
                        if (procesosEstado.ia) ia.forzarEstado(true);
                        else ia.forzarEstado(procesosEstado.ia);
                    }
                    await guardarConfigBD();
                    res.end("OK");
                } else {
                    res.end("ERROR");
                }
            } catch (e) { res.end("ERROR"); }
        });
    } else if (routename === '/sql') {
        if (req.method === 'POST') {
            let b = '';
            req.on('data', c => b += c);
            req.on('end', async () => {
                let sql = '';
                try { sql = (JSON.parse(b).sql || '').toString().trim().replace(/;\s*$/, ''); } catch (e) {}
                if (!sql) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Consulta vacía'})); }
                const head = sql.split(/\s+/)[0].toUpperCase();
                const permitidas = ['SELECT','SHOW','DESCRIBE','DESC','EXPLAIN','PRAGMA'];
                if (!permitidas.includes(head) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE)\b/i.test(sql)) {
                    res.writeHead(403, {'Content-Type':'application/json'});
                    return res.end(JSON.stringify({error:'Solo se permiten consultas de lectura (SELECT, SHOW, DESCRIBE, EXPLAIN).'}));
                }
                try {
                    const [rows, fields] = await pool.query({ sql, timeout: 20000 });
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({filas: rows.length, campos: (fields||[]).map(f => f.name), rows: rows.slice(0, 200)}));
                } catch (e) {
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({error: e.message}));
                }
            });
        } else {
            let tabsHtml = '';
            try {
                const [tabs] = await pool.query("SHOW TABLES");
                tabsHtml = tabs.map(t => Object.values(t)[0])
                    .map(t => `<option value="SELECT * FROM \`${t.replace(/`/g,'``')}\` LIMIT 20">${t}</option>`).join('');
            } catch (e) {}
            res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
            res.end(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
<title>Consultas SQL</title>
<style>
body{background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;font-family:'Segoe UI',system-ui,sans-serif;color:#fff}
.card-dash{background:rgba(255,255,255,0.06);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;color:#fff}
.txt-sql{background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.15);color:#8ff;border-radius:12px;font-family:consolas,monospace;font-size:.82rem}
.txt-sql:focus{outline:none;border-color:#4f8cff;box-shadow:0 0 0 3px rgba(79,140,255,.25);color:#e6e6e6}
.btn-acc{background:linear-gradient(135deg,#4f8cff,#7b6cff);border:0;border-radius:12px;font-weight:700}
.btn-acc:hover{filter:brightness(1.1)}
.tbl-r{width:100%;font-size:.74rem;overflow:auto;max-height:380px;display:block}
.tbl-r table{width:100%;border-collapse:collapse}
.tbl-r th{position:sticky;top:0;background:#3a3558;color:#cdd;padding:6px 8px;text-align:left;white-space:nowrap}
.tbl-r td{padding:5px 8px;border-top:1px solid rgba(255,255,255,0.07);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip-sql{background:rgba(79,140,255,0.15);border:1px solid rgba(79,140,255,0.3);border-radius:10px;padding:2px 8px;font-size:.72rem;color:#a8c4ff;cursor:pointer}
.chip-sql:hover{background:rgba(79,140,255,0.3)}
</style></head>
<body>
${header}
<div class="container pb-4">
<div class="row g-3">
<div class="col-lg-6">
<div class="card-dash p-4">
<h5 class="mb-1"><i class="bi bi-database me-2"></i>Consultas SQL (lectura)</h5>
<p class="text-white-50 small mb-3">Solo SELECT / SHOW / DESCRIBE / EXPLAIN. Máx. 200 filas mostradas.</p>
<div class="mb-3">
<label class="form-label text-white-50 small fw-bold">Tablas disponibles</label>
<select class="form-select form-select-sm" id="tablasSel" onchange="document.getElementById('sql').value=this.value">
<option value="">— Elegir tabla —</option>${tabsHtml}
</select>
</div>
<textarea id="sql" class="form-control txt-sql mb-3" rows="10" placeholder="SELECT * FROM tab_clientes LIMIT 20"></textarea>
<div class="d-flex gap-2 flex-wrap align-items-center">
<button class="btn btn-acc px-4" onclick="ejecutar()"><i class="bi bi-play-fill me-1"></i>Ejecutar (Ctrl+Enter)</button>
<button class="btn btn-outline-light" style="border-radius:12px" onclick="document.getElementById('sql').value='SHOW TABLES';ejecutar()">SHOW TABLES</button>
<a class="btn btn-outline-light" style="border-radius:12px" href="/entrenar">Volver a Entrenar</a>
</div>
</div>
</div>
<div class="col-lg-6">
<div class="card-dash p-4">
<h5 class="mb-2"><i class="bi bi-terminal me-2"></i>Resultado</h5>
<div id="resultado" class="text-white-50 small">Aquí verás el resultado de la consulta.</div>
</div>
</div>
</div>
</div>
<script>
async function ejecutar(){
    const sql=document.getElementById('sql').value.trim();
    if(!sql)return alert("Escribe una consulta.");
    const res=document.getElementById('resultado');
    res.className="text-white-50 small";res.innerHTML="⏳ Ejecutando...";
    try{
        const r=await fetch('/sql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql})});
        const d=await r.json();
        if(d.error){res.className="text-danger small fw-bold";res.innerHTML="❌ "+d.error.replace(/</g,'&lt;');return;}
        if(!d.campos||d.filas===0){res.className="text-white-50 small";res.innerHTML="✅ "+d.filas+" fila(s), sin columnas.";return;}
        const esc=v=>{v=(v===null||v===undefined)?'NULL':String(v);return v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');};
        let h="<div class='tbl-r'><table class='table table-dark table-striped'><thead><tr>"+d.campos.map(c=>"<th>"+esc(c)+"</th>").join("")+"</tr></thead><tbody>";
        for(const row of d.rows){h+="<tr>"+d.campos.map(c=>"<td>"+esc(row[c])+"</td>").join("")+"</tr>";}
        h+="</tbody></table></div>";
        res.className="small";
        res.innerHTML="<span class='text-info fw-bold'>✅ "+d.filas+" fila(s)</span>"+h;
    }catch(e){res.className="text-danger small fw-bold";res.innerHTML="❌ "+e.message;}
}
document.getElementById('sql').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')ejecutar();});
</script>
</body></html>`);
        }
    } else {
        const [zonas] = await pool.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' AND zona IS NOT NULL ORDER BY zona");
        const zonaOptsMain = zonas.map(z => `<option value="${z.zona}">${z.zona}</option>`).join('');
        const [stats] = await pool.execute("SELECT COUNT(*) as total FROM tab_agenda_visitas WHERE estado IN ('pendiente','no_contesto','ausente','pospuso') OR estado IS NULL");
        const pendientes = stats[0]?.total || 0;
        const hoyStr = new Date().toISOString().split('T')[0];
        const [hoyVis] = await pool.execute("SELECT a.id_agenda, a.id_cliente, a.fecha, a.hora, c.nombres, c.celular, c.zona, c.direccion, c.vendedor FROM tab_agenda_visitas a JOIN tab_clientes c ON a.id_cliente = c.id_cliente WHERE a.fecha = ? AND (a.estado IN ('pendiente','no_contesto','ausente','pospuso') OR a.estado IS NULL) ORDER BY c.zona, c.nombres", [hoyStr]);
        const hoyTotal = hoyVis.length;
        const hoyZonas = [...new Set(hoyVis.map(v => v.zona))];
        const hoyMapLink = hoyVis.map(v => encodeURIComponent(v.direccion || v.nombres)).filter(Boolean).join('/');
        const hoyGmaps = hoyMapLink ? `https://www.google.com/maps/dir/${hoyMapLink}` : '';
        res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<meta http-equiv="refresh" content="30">
<title>ONE4CARS Admin</title>
<style>
body{background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;font-family:'Segoe UI',system-ui,sans-serif}
.card-dash{background:rgba(255,255,255,0.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;color:#fff;transition:transform 0.2s,box-shadow 0.2s}
.card-dash:hover{transform:translateY(-4px);box-shadow:0 12px 40px rgba(0,0,0,0.4)}
.card-dash .card-body{padding:1.25rem}
.card-dash .icon-box{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:1.5rem}
.card-dash .btn{font-size:0.85rem;font-weight:600;letter-spacing:0.3px;border-radius:12px;padding:0.5rem 1rem}
.header-gradient{background:rgba(0,0,0,0.3);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.08)}
.dolar-badge{background:rgba(255,255,255,0.08);border-radius:12px;padding:0.35rem 0.85rem;font-size:0.8rem}
.qr-container img{border-radius:16px;background:#fff;padding:8px}
.stat-box{background:rgba(255,255,255,0.06);border-radius:14px;padding:0.75rem;text-align:center}
.stat-box .num{font-size:1.5rem;font-weight:700}
@media(max-width:576px){
.card-dash .card-body{padding:1rem}
.card-dash .btn{font-size:0.8rem;padding:0.4rem 0.75rem}
.stat-box .num{font-size:1.2rem}
.dolar-badge{font-size:0.7rem}
}
</style>
</head>
<body>
<nav class="navbar navbar-dark header-gradient mb-4">
<div class="container">
<a class="navbar-brand fw-bold" href="/" style="font-size:1.1rem;letter-spacing:-0.3px">
<i class="bi bi-speedometer2 me-2"></i>ONE4CARS
</a>
<div class="d-flex align-items-center gap-2">
<span class="dolar-badge text-white-50"><i class="bi bi-currency-dollar"></i> BCV ${dolarInfo.bcv}</span>
<span class="dolar-badge text-white-50"><i class="bi bi-currency-exchange"></i> $ ${dolarInfo.paralelo}</span>
<span class="dolar-badge text-white-50"><i class="bi bi-yin-yang"></i> B ${dolarInfo.binance}</span>
<span class="badge ${qrCodeData === 'ONLINE ✅' ? 'bg-success' : 'bg-danger'}" style="border-radius:20px;font-size:0.7rem">
${qrCodeData === 'ONLINE ✅' ? '🟢 Online' : '🔴 Offline'}
</span>
</div>
</div>
</nav>
<div class="container pb-4">
${qrCodeData.startsWith('data') ? `
<div class="row mb-4 justify-content-center">
<div class="col-12 col-sm-6 col-md-4">
<div class="card-dash p-4 text-center">
<h6 class="text-white-50 mb-3"><i class="bi bi-qr-code me-2"></i>Escanee el QR</h6>
<div class="qr-container">${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" class="img-fluid" style="max-width:220px">` : ''}</div>
<p class="text-white-50 small mt-2">Conecte su WhatsApp para usar el bot</p>
<a href="/reset-sesion" class="btn btn-outline-light btn-sm mt-2" onclick="return confirm('¿Borrar sesión y generar nuevo QR?')"><i class="bi bi-arrow-repeat me-1"></i>Nuevo QR</a>
</div>
</div>
</div>
` : ''}
<div class="row mb-3 g-2">
<div class="col-12 col-sm-6">
<div class="card-dash">
<div class="card-body d-flex align-items-center justify-content-between">
<div>
<h6 class="text-white-50 mb-1" style="font-size:0.75rem"><i class="bi bi-calendar-day me-1"></i>Visitas de Hoy</h6>
<span class="fw-bold" style="font-size:1.3rem">${hoyTotal}</span>
<small class="text-white-50 ms-2">${hoyZonas.length} zona(s)</small>
</div>
<div class="d-flex gap-2">
${hoyGmaps ? `<a href="${hoyGmaps}" target="_blank" class="btn btn-sm" style="background:rgba(25,135,84,0.2);color:#75b798;border-radius:12px"><i class="bi bi-geo-alt-fill me-1"></i>Salir a Visitar</a>` : ''}
<a href="/visitas?fecha=${hoyStr}" class="btn btn-sm" style="background:rgba(13,110,253,0.2);color:#6ea8fe;border-radius:12px"><i class="bi bi-list-ul me-1"></i>Ver</a>
</div>
</div>
</div>
</div>
${hoyVis.length > 0 ? `
<div class="col-12 col-sm-6">
<div class="card-dash">
<div class="card-body" style="max-height:100px;overflow-y:auto">
<div style="font-size:0.7rem;color:rgba(255,255,255,0.5)">${hoyVis.slice(0,6).map(v => `<span class="me-3 d-inline-block"><span style="color:#${v.zona ? ['f5a','6ea','8f8','f88','8af','fa8','af8','faf','aaf','ff8'][Math.abs(v.zona.charCodeAt(0)||0)%10] : 'aaa'}">●</span> ${v.nombres.split(' ').slice(0,2).join(' ')} ${v.zona ? '('+v.zona+')' : ''}</span>`).join('')}${hoyVis.length > 6 ? `<span class="text-white-50">+${hoyVis.length-6} más</span>` : ''}</div>
</div>
</div>
</div>` : ''}
</div>
<div class="row g-3">
<div class="col-6 col-sm-4 col-md-3">
<a href="/entrenar" class="text-decoration-none">
<div class="card-dash h-100" style="background:rgba(123,108,255,0.18);border-color:rgba(123,108,255,0.45)">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(123,108,255,0.25);color:#b3a6ff"><i class="bi bi-robot"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">IA / Entrenamiento</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Entrenar al Bot</span>
<span class="d-block mt-1" style="font-size:0.7rem;color:#b3a6ff">instrucciones + procesos on/off</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/sql" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(79,140,255,0.2);color:#6ea8fe"><i class="bi bi-database"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">SQL</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Consultas a la BD</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/cobranza" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(13,110,253,0.2);color:#6ea8fe"><i class="bi bi-cash-stack"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Cobranza</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Panel de Cobros</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/recordatorio-estado" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(255,193,7,0.2);color:#ffda6a"><i class="bi bi-bell-fill"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Recordatorios</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Deudas vencidas</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/recordatorio-visita" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(220,53,69,0.2);color:#ea868f"><i class="bi bi-envelope-paper-fill"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Rec. Visita</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Recordatorio visita</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/visitas" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(25,135,84,0.2);color:#75b798"><i class="bi bi-calendar-check-fill"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Visitas</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Agenda (${pendientes} pend.)</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/notificador-estado" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(108,117,125,0.2);color:#b0b5ba"><i class="bi bi-megaphone-fill"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Notificador</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Envíos automáticos</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/marketing-panel" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(13,202,240,0.2);color:#6edff6"><i class="bi bi-megaphone"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Marketing</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Campañas masivas</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/historial" class="text-decoration-none">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(111,66,193,0.2);color:#b78ee8"><i class="bi bi-chat-dots-fill"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Historial</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Chats</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/reset-sesion" class="text-decoration-none" onclick="return confirm('¿Borrar sesión del bot?')">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(255,255,255,0.08);color:#fff"><i class="bi bi-arrow-repeat"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Reset</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Nuevo QR</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/sync-agenda" class="text-decoration-none" onclick="return confirm('¿Sincronizar agenda local → remoto?')">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(13,202,240,0.2);color:#6edff6"><i class="bi bi-cloud-arrow-up"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Sync</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Sincronizar Agenda</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/sync-facturas" class="text-decoration-none" onclick="return confirm('¿Sincronizar tab_facturas (Local ↔ Remoto)?\nSe preservarán los campos whatsapp_notificado y whatsapp_mora.')">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(255,193,7,0.2);color:#ffda6a"><i class="bi bi-arrow-left-right"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Sync Fact</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Sincronizar Facturas</span>
</div>
</div>
</a>
</div>
<div class="col-6 col-sm-4 col-md-3">
<a href="/sync-facturas-status" class="text-decoration-none" target="_blank">
<div class="card-dash h-100">
<div class="card-body">
<div class="d-flex align-items-center gap-3 mb-2">
<div class="icon-box" style="background:rgba(108,117,125,0.2);color:#b0b5ba"><i class="bi bi-info-circle"></i></div>
<small class="text-white-50 text-uppercase" style="font-size:0.65rem;letter-spacing:0.5px">Estado Sync</small>
</div>
<span class="fw-bold" style="font-size:0.95rem">Ver Estado Sync</span>
</div>
</div>
</a>
</div>
</div>
<div class="row mt-4">
<div class="col-12">
<div class="card-dash">
<div class="card-body">
<div class="row g-2 align-items-end">
<div class="col-12 col-sm-6 col-md-3">
<label class="text-white-50 small fw-bold mb-1"><i class="bi bi-geo-alt me-1"></i>Zona</label>
<select id="zonaSel" class="form-select form-select-sm" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:10px">${zonaOptsMain}</select>
</div>
<div class="col-6 col-sm-4 col-md-2">
<label class="text-white-50 small fw-bold mb-1"><i class="bi bi-calendar me-1"></i>Fecha</label>
<input type="date" id="fechaSel" class="form-control form-control-sm" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:10px">
</div>
<div class="col-6 col-sm-2 col-md-2">
<label class="text-white-50 small fw-bold mb-1"><i class="bi bi-arrow-repeat me-1"></i>Días</label>
</div>
<div class="col-12 col-sm-4 col-md-3">
<button onclick="agendarZona()" class="btn btn-success w-100" style="border-radius:10px;font-weight:600"><i class="bi bi-calendar-plus me-1"></i>Agendar Zona</button>
</div>
<div class="col-12"><div id="statusZona" class="small fw-bold mt-1"></div></div>
</div>
</div>
</div>
</div>
</div>
</div>
<script>
async function agendarZona(){
    const zona=document.getElementById('zonaSel').value;
    const fecha=document.getElementById('fechaSel').value;
    const frecuencia=document.getElementById('frecSel').value;
    if(!zona||!fecha)return alert("Selecciona zona y fecha.");
    if(!confirm("Agendar visitas para toda la zona "+zona+" el "+fecha+"?"))return;
    const st=document.getElementById('statusZona');st.className="small fw-bold text-info";st.innerHTML="⏳ Agendando...";
    try{
        const r=await fetch('/agendar-zona',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zona,fecha,frecuencia})});
        const t=await r.text();alert(t);st.innerHTML="✅ "+t;
    }catch(e){st.innerHTML="❌ "+e.message;}
}
document.querySelectorAll('#frecSel, #zonaSel, #fechaSel').forEach(el => {
    el.addEventListener('keydown', e => { if(e.key==='Enter') agendarZona(); });
});
</script>
</body>
</html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    await cargarConfigBD();
    await restaurarSesiones();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
