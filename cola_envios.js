/**
 * Cola central de envíos con protección anti-baneo.
 * - Un mensaje cada N minutos (30 por defecto).
 * - Máximo N mensajes al día (5 por defecto).
 * - Solo de lunes a viernes, en horario laboral.
 * - Tipos variados (rotación para no repetir el mismo tipo seguido).
 * - Modo prueba: todo se redirige al 584123715550 hasta que se autorice.
 */
const CONFIG_KEY = 'cola_envios';
const DIAS_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

let poolRef = null;
let enviarRef = null;
let formatRef = null;
let trabajando = false;
let ultimoEnvioMs = 0;
let ultimoTipo = '';

const config = {
    activo: true,
    modo_prueba: true,
    telefono_prueba: '584123715550',
    intervalo_min: 30,
    max_dia: 5,
    hora_inicio: 8,
    hora_fin: 18,
    dias: [1, 2, 3, 4, 5] // lunes a viernes
};

function init(pool, { enviar, format }) {
    poolRef = pool;
    enviarRef = enviar;
    formatRef = format;
}

async function crearTablas() {
    await poolRef.query(`CREATE TABLE IF NOT EXISTS bot_cola_envios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tipo VARCHAR(40) NOT NULL,
        telefono VARCHAR(100) NOT NULL,
        nombre VARCHAR(200) NULL,
        texto TEXT NOT NULL,
        prioridad TINYINT NOT NULL DEFAULT 5,
        estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        fecha_creada TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_envio DATETIME NULL,
        destino_real VARCHAR(100) NULL,
        forzar_real TINYINT NOT NULL DEFAULT 0,
        intentos INT NOT NULL DEFAULT 0,
        error VARCHAR(300) NULL,
        INDEX idx_estado (estado, prioridad, fecha_creada),
        INDEX idx_tipo (tipo),
        INDEX idx_tel (telefono)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
    try { await poolRef.query("ALTER TABLE bot_cola_envios ADD COLUMN forzar_real TINYINT NOT NULL DEFAULT 0"); } catch (e) {}
}

async function cargar() {
    try {
        const [rows] = await poolRef.query(
            "SELECT valor FROM bot_config WHERE clave = ? LIMIT 1",
            [CONFIG_KEY]
        );
        if (rows && rows[0] && rows[0].valor) {
            const guardado = JSON.parse(rows[0].valor);
            Object.assign(config, guardado);
        }
    } catch (e) {
        console.log('[COLA] No se pudo cargar config:', e.message);
    }
    try {
        const [r] = await poolRef.query(
            "SELECT UNIX_TIMESTAMP(MAX(fecha_envio)) t FROM bot_cola_envios WHERE estado = 'enviado'"
        );
        if (r && r[0] && r[0].t) ultimoEnvioMs = Number(r[0].t) * 1000;
    } catch (e) {}
    return config;
}

async function guardar() {
    try {
        const valor = JSON.stringify(config);
        await poolRef.query(
            "INSERT INTO bot_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)",
            [CONFIG_KEY, valor]
        );
    } catch (e) {
        console.log('[COLA] Error guardando config:', e.message);
    }
}

async function initCompleto(pool, deps) {
    init(pool, deps);
    await crearTablas();
    await cargar();
    return config;
}

function ahoraCaracas() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Caracas',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const obj = {};
    for (const p of partes) obj[p.type] = p.value;
    const hora = parseInt(obj.hour, 10) % 24;
    const diaSemana = new Date(`${obj.year}-${obj.month}-${obj.day}T12:00:00-04:00`).getUTCDay();
    return { fecha: `${obj.year}-${obj.month}-${obj.day}`, hora, minuto: parseInt(obj.minute, 10), diaSemana };
}

async function enviadosHoy() {
    try {
        const { fecha } = ahoraCaracas();
        const [r] = await poolRef.query(
            "SELECT COUNT(*) n FROM bot_cola_envios WHERE estado = 'enviado' AND DATE(fecha_envio) = ?",
            [fecha]
        );
        return Number(r && r[0] ? r[0].n : 0);
    } catch (e) {
        return 0;
    }
}

async function encolar({ tipo, telefono, nombre = null, texto, prioridad = 5, real = false }) {
    if (!telefono || !texto) return false;
    const tel = String(telefono).replace(/\s+/g, '').trim();
    if (!tel) return false;
    // Teléfono inválido (ej. "580", vacío o menos de 10 dígitos) → no se encola
    if (tel.replace(/\D/g, '').length < 10) {
        console.log(`[COLA] Teléfono inválido para ${tipo}: "${tel}" (${nombre || 'sin nombre'})`);
        return false;
    }
    try {
        const excluyentes = ['cobranza', 'estado_cuenta'];
        const extra = excluyentes.includes(tipo) ? " OR tipo IN ('cobranza','estado_cuenta')" : '';
        const [dup] = await poolRef.query(
            `SELECT 1 FROM bot_cola_envios
             WHERE telefono = ? AND estado = 'pendiente' AND (tipo = ?${extra})
             LIMIT 1`,
            [tel, tipo]
        );
        if (dup && dup.length) return false;
        await poolRef.query(
            `INSERT INTO bot_cola_envios (tipo, telefono, nombre, texto, prioridad, forzar_real)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [tipo, tel, nombre, texto, prioridad, real ? 1 : 0]
        );
        return true;
    } catch (e) {
        console.log('[COLA] Error encolando:', e.message);
        return false;
    }
}

async function siguiente() {
    // Rotación justa por tipo: se elige el tipo que hace más tiempo no se envía,
    // para que la cola no se sature de un solo tipo (ej. cobranza).
    try {
        const [pend] = await poolRef.query(
            "SELECT tipo, COUNT(*) n FROM bot_cola_envios WHERE estado = 'pendiente' GROUP BY tipo"
        );
        if (!pend || !pend.length) return null;
        const [ultimos] = await poolRef.query(
            "SELECT tipo, MAX(fecha_envio) ult FROM bot_cola_envios WHERE estado = 'enviado' GROUP BY tipo"
        );
        const ultimoPorTipo = new Map();
        for (const u of (ultimos || [])) ultimoPorTipo.set(u.tipo, new Date(u.ult).getTime() || 0);
        let tipos = (pend || []).map(p => p.tipo);
        // "Estado de cuenta" masivo: SOLO de lunes a viernes.
        const { diaSemana } = ahoraCaracas();
        if (diaSemana === 0 || diaSemana === 6) tipos = tipos.filter(t => t !== 'estado_cuenta');
        if (!tipos.length) return null;
        if (tipos.length > 1 && ultimoTipo) tipos = tipos.filter(t => t !== ultimoTipo);
        tipos.sort((a, b) => (ultimoPorTipo.get(a) || 0) - (ultimoPorTipo.get(b) || 0));
        const tipo = tipos[0];
        const [r] = await poolRef.query(
            `SELECT * FROM bot_cola_envios
             WHERE estado = 'pendiente' AND tipo = ?
             ORDER BY prioridad ASC, fecha_creada ASC LIMIT 1`,
            [tipo]
        );
        return (r && r[0]) || null;
    } catch (e) {
        return null;
    }
}

async function tick(opciones = {}) {
    if (!config.activo || trabajando) return;
    trabajando = true;
    try {
        const { hora, diaSemana, fecha } = ahoraCaracas();
        const forzar = !!opciones.forzar;
        if (!forzar) {
            if (!config.dias.includes(diaSemana)) return;
            if (hora < config.hora_inicio || hora >= config.hora_fin) return;
        }
        const esperaMs = Math.max(1, Number(config.intervalo_min) || 30) * 60000;
        // Reparto inteligente: si el cupo diario es bajo, separar los mensajes
        // a lo largo de la jornada (ej. 5/día en 10h = 1 cada 2 horas).
        const ventanaMin = Math.max(60, (Number(config.hora_fin) - Number(config.hora_inicio)) * 60);
        const cupo = Math.max(1, Number(config.max_dia) || 5);
        const separacionMin = Math.max(Number(config.intervalo_min) || 30, Math.round(ventanaMin / cupo));
        const esperaRealMs = separacionMin * 60000;
        if (!opciones.ignorarIntervalo && ultimoEnvioMs && Date.now() - ultimoEnvioMs < esperaRealMs) return;
        const enviados = await enviadosHoy();
        if (!opciones.ignorarCuota && enviados >= cupo) return;

        const item = await siguiente();
        if (!item) return;
        const destino = (config.modo_prueba && !Number(item.forzar_real))
            ? formatRef(config.telefono_prueba)
            : formatRef(item.telefono);
        if (!destino) return;

        try {
            await enviarRef(destino, item.texto);
            await poolRef.query(
                "UPDATE bot_cola_envios SET estado = 'enviado', fecha_envio = NOW(), destino_real = ? WHERE id = ?",
                [destino, item.id]
            );
            ultimoEnvioMs = Date.now();
            ultimoTipo = item.tipo;
            console.log(`[COLA] Enviado (${item.tipo}) a ${destino}${config.modo_prueba ? ' [MODO PRUEBA]' : ''}`);
        } catch (e) {
            await poolRef.query(
                "UPDATE bot_cola_envios SET intentos = intentos + 1, error = ? WHERE id = ?",
                [String(e.message).slice(0, 290), item.id]
            );
            if (item.intentos >= 2) {
                await poolRef.query("UPDATE bot_cola_envios SET estado = 'error' WHERE id = ?", [item.id]);
            }
            console.log('[COLA] Error enviando:', e.message);
        }
    } catch (e) {
        console.log('[COLA] Error tick:', e.message);
    } finally {
        trabajando = false;
    }
}

async function estado() {
    const { fecha } = ahoraCaracas();
    const q = async (sql, params = []) => {
        const [r] = await poolRef.query(sql, params);
        return r || [];
    };
    const pendientes = await q("SELECT tipo, COUNT(*) n FROM bot_cola_envios WHERE estado = 'pendiente' GROUP BY tipo");
    const enviados = await q("SELECT COUNT(*) n FROM bot_cola_envios WHERE estado = 'enviado' AND DATE(fecha_envio) = ?", [fecha]);
    const totalPend = pendientes.reduce((a, b) => a + Number(b.n), 0);
    let msg = `📮 *COLA DE ENVÍOS*\n\n`;
    msg += `Estado: *${config.activo ? 'ACTIVA' : 'PAUSA'}*\n`;
    msg += `Modo: *${config.modo_prueba ? 'PRUEBA → 584123715550' : 'REAL'}*\n`;
    msg += `Ritmo: *1 mensaje cada ${config.intervalo_min} min*\n`;
    msg += `Máximo diario: *${config.max_dia}*\n`;
    const ventanaMin = Math.max(60, (Number(config.hora_fin) - Number(config.hora_inicio)) * 60);
    const separacion = Math.max(Number(config.intervalo_min) || 30, Math.round(ventanaMin / Math.max(1, Number(config.max_dia) || 5)));
    msg += `Separación efectiva: *1 cada ${separacion} min* (repartido en la jornada)\n`;
    msg += `Días: *lunes a viernes*\n`;
    msg += `Horario: *${config.hora_inicio}:00 a ${config.hora_fin}:00*\n\n`;
    msg += `Enviados hoy: *${Number(enviados[0] ? enviados[0].n : 0)}*\n`;
    msg += `Pendientes: *${totalPend}*\n`;
    if (pendientes.length) {
        msg += `\n*Por tipo:*\n`;
        pendientes.forEach(p => { msg += `• ${p.tipo}: ${p.n}\n`; });
    }
    return msg;
}

function comando(texto) {
    const t = String(texto || '').toLowerCase().trim();
    if (t === 'cola') return { accion: 'estado' };
    if (t === 'cola pausa') return { accion: 'config', cambios: { activo: false } };
    if (t === 'cola reanudar') return { accion: 'config', cambios: { activo: true } };
    if (t === 'cola prueba') return { accion: 'config', cambios: { modo_prueba: true } };
    if (t === 'cola real') return { accion: 'config', cambios: { modo_prueba: false } };
    let m = t.match(/^cola intervalo\s+(\d{1,3})$/);
    if (m) return { accion: 'config', cambios: { intervalo_min: Math.max(5, parseInt(m[1], 10)) } };
    m = t.match(/^cola diario\s+(\d{1,3})$/);
    if (m) return { accion: 'config', cambios: { max_dia: Math.max(1, parseInt(m[1], 10)) } };
    m = t.match(/^cola horario\s+(\d{1,2})\s+(\d{1,2})$/);
    if (m) return { accion: 'config', cambios: { hora_inicio: parseInt(m[1], 10), hora_fin: parseInt(m[2], 10) } };
    if (t === 'cola vaciar') return { accion: 'vaciar' };
    return null;
}

async function aplicar(cambios) {
    Object.assign(config, cambios);
    await guardar();
    return config;
}

async function vaciar() {
    const [r] = await poolRef.query("DELETE FROM bot_cola_envios WHERE estado = 'pendiente'");
    return r ? r.affectedRows : 0;
}

/** Día hábil: si la fecha cae sábado o domingo, se mueve al lunes siguiente. */
function ajustarDiaHabil(y, m, d) {
    const f = new Date(y, m - 1, d, 12, 0, 0);
    const dow = f.getDay();
    if (dow === 6) f.setDate(f.getDate() + 2);
    else if (dow === 0) f.setDate(f.getDate() + 1);
    return f;
}

module.exports = {
    initCompleto, cargar, guardar, encolar, tick, estado, comando, aplicar, vaciar,
    config, ahoraCaracas, ajustarDiaHabil, enviadosHoy
};
