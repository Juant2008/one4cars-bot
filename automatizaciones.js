/**
 * Automatizaciones de retención y profesionalismo.
 * Todo lo que va a clientes entra por la cola anti-baneo (cola_envios).
 * Los avisos internos a administradores se envían directo (1 mensaje).
 */
const cola = require('./cola_envios');

let poolRef = null;
let enviarRef = null;
let formatRef = null;
let adminRef = null; // async (texto) => void  (aviso interno a admins)
let ofertaRef = null; // async () => string con catálogo/ofertas (opcional)

function init(pool, { enviar, format, avisarAdmins }) {
    poolRef = pool;
    enviarRef = enviar;
    formatRef = format;
    adminRef = avisarAdmins;
}

function q(sql, params = []) {
    return poolRef.query(sql, params).then(([r]) => r || []);
}

async function tabla(sql) {
    try { await poolRef.query(sql); } catch (e) { console.log('[AUTO] Error tabla:', e.message); }
}

async function initTablas() {
    await tabla(`CREATE TABLE IF NOT EXISTS bot_encuesta_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_factura INT NOT NULL,
        telefono VARCHAR(100) NOT NULL,
        nombre VARCHAR(200) NULL,
        fecha_envio DATETIME NULL,
        respuesta TINYINT NULL,
        fecha_respuesta DATETIME NULL,
        UNIQUE KEY uq_encuesta (id_factura)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_aviso_vencimiento_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_factura INT NOT NULL,
        fecha_envio DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_aviso (id_factura)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_aniversario_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_cliente INT NOT NULL,
        anio SMALLINT NOT NULL,
        fecha_envio DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_aniv (id_cliente, anio)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_intereses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        telefono VARCHAR(100) NOT NULL,
        consulta VARCHAR(300) NULL,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        contactado TINYINT NOT NULL DEFAULT 0,
        convertido TINYINT NOT NULL DEFAULT 0,
        INDEX idx_tel (telefono),
        INDEX idx_fecha (fecha)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_fidelizacion (
        id_cliente INT PRIMARY KEY,
        anio SMALLINT NOT NULL,
        compras INT NOT NULL,
        porcentaje TINYINT NOT NULL DEFAULT 10,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_visita15_log (
        id_cliente INT PRIMARY KEY,
        fecha_envio DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_stock_bajo_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fecha DATE NOT NULL,
        detalle TEXT NULL,
        UNIQUE KEY uq_fecha (fecha)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

    await tabla(`CREATE TABLE IF NOT EXISTS bot_no_cobrar (
        id_cliente INT PRIMARY KEY,
        motivo VARCHAR(200) NULL,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
}

function nombreCorto(n) {
    const s = String(n || '').trim().replace(/\s+/g, ' ');
    if (!s) return 'estimado cliente';
    return s.length > 40 ? s.slice(0, 40) : s;
}

// ===== 1. ENCUESTA DE SATISFACCIÓN (15 días después de la factura) =====
async function chequearEncuestas() {
    const facturas = await q(
        `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular
         FROM tab_facturas f
         LEFT JOIN bot_encuesta_log e ON e.id_factura = f.id_factura
         WHERE f.anulado = 'no' AND f.pagada = 'NO'
           AND DATEDIFF(CURDATE(), f.fecha_reg) = 15
           AND e.id_factura IS NULL
           AND f.celular <> ''
         LIMIT 30`
    );
    let n = 0;
    for (const f of facturas) {
        const texto = `⭐ *ENCUESTA DE SATISFACCIÓN ONE4CARS*\n\nHola *${nombreCorto(f.nombres)}*, hace 15 días recibió su factura *N° ${f.nro_factura}*.\n\nNos gustaría saber cómo fue su experiencia. Responda con un número del *1 al 5*:\n\n1️⃣ Muy mala\n2️⃣ Mala\n3️⃣ Regular\n4️⃣ Buena\n5️⃣ Excelente\n\nSu opinión nos ayuda a servirle mejor. ¡Gracias! 🚗`;
        const ok = await cola.encolar({ tipo: 'encuesta', telefono: f.celular, nombre: f.nombres, texto, prioridad: 3 });
        if (ok) {
            await poolRef.query(
                `INSERT IGNORE INTO bot_encuesta_log (id_factura, telefono, nombre) VALUES (?, ?, ?)`,
                [f.id_factura, f.celular, f.nombres]
            );
            n++;
        }
    }
    return { encoladas: n, encontradas: facturas.length };
}

/** Registra la respuesta 1-5 a una encuesta pendiente (últimos 7 días). */
async function registrarRespuestaEncuesta(telefono, valor) {
    const v = parseInt(valor, 10);
    if (!(v >= 1 && v <= 5)) return false;
    const tel = String(telefono || '').replace(/\s+/g, '');
    const [r] = await q(
        `SELECT id FROM bot_encuesta_log
         WHERE telefono = ? AND respuesta IS NULL
           AND fecha_envio > DATE_SUB(NOW(), INTERVAL 7 DAY)
         ORDER BY id DESC LIMIT 1`,
        [tel]
    ).catch(() => []);
    if (!r || !r.length) return false;
    await poolRef.query(
        "UPDATE bot_encuesta_log SET respuesta = ?, fecha_respuesta = NOW() WHERE id = ?",
        [v, r[0].id]
    );
    return true;
}

// ===== 2. AVISO AL VENDEDOR: MAÑANA VENCE (30 días) =====
async function chequearAvisoVendedor() {
    const facturas = await q(
        `SELECT f.id_factura, f.nro_factura, f.nombres, f.fecha_reg,
                v.nombre AS vendedor_nombre, v.celular_vendedor
         FROM tab_facturas f
         LEFT JOIN tab_vendedores v ON v.id_vendedor = f.id_vendedor
         LEFT JOIN bot_aviso_vencimiento_log a ON a.id_factura = f.id_factura
         WHERE f.anulado = 'no' AND f.pagada = 'NO'
           AND DATEDIFF(CURDATE(), f.fecha_reg) = 29
           AND a.id_factura IS NULL
           AND v.celular_vendedor IS NOT NULL AND v.celular_vendedor <> ''
         LIMIT 30`
    );
    let n = 0;
    for (const f of facturas) {
        const texto = `⏰ *AVISO DE VENCIMIENTO — ONE4CARS*\n\nVendedor: *${f.vendedor_nombre || 'N/A'}*\n\nMañana se cumplen *30 días* de la factura *N° ${f.nro_factura}* del cliente *${f.nombres}* (emitida el ${String(f.fecha_reg).slice(0, 10)}).\n\nLe recordamos gestionar la cobranza para mantener la cartera al día.`;
        const ok = await cola.encolar({ tipo: 'aviso_vencimiento', telefono: f.celular_vendedor, nombre: f.vendedor_nombre, texto, prioridad: 2 });
        if (ok) {
            await poolRef.query("INSERT IGNORE INTO bot_aviso_vencimiento_log (id_factura) VALUES (?)", [f.id_factura]);
            n++;
        }
    }
    return { encoladas: n, encontradas: facturas.length };
}

// ===== 3. ANIVERSARIO DEL CLIENTE =====
async function chequearAniversarios() {
    const clientes = await q(
        `SELECT c.id_cliente, c.nombres, c.celular, c.fecha_reg
         FROM tab_clientes c
         LEFT JOIN bot_aniversario_log a ON a.id_cliente = c.id_cliente AND a.anio = YEAR(CURDATE())
         WHERE c.activo = 'SI' AND c.celular <> ''
           AND MONTH(c.fecha_reg) = MONTH(CURDATE())
           AND DAY(c.fecha_reg) = DAY(CURDATE())
           AND YEAR(c.fecha_reg) < YEAR(CURDATE())
           AND a.id_cliente IS NULL
         LIMIT 50`
    );
    let n = 0;
    for (const c of clientes) {
        const anios = new Date().getFullYear() - new Date(c.fecha_reg).getFullYear();
        const texto = `🎉 *¡FELIZ ANIVERSARIO, ${nombreCorto(c.nombres)}!* 🎉\n\nHoy celebramos *${anios} año${anios === 1 ? '' : 's'}* de trabajo conjunto. Gracias por su confianza y por permitirnos ser parte de su negocio.\n\nLe deseamos muchos éxitos más y seguimos a su disposición. 🚗\n\n— Equipo ONE4CARS`;
        const ok = await cola.encolar({ tipo: 'aniversario', telefono: c.celular, nombre: c.nombres, texto, prioridad: 4 });
        if (ok) {
            await poolRef.query("INSERT IGNORE INTO bot_aniversario_log (id_cliente, anio) VALUES (?, YEAR(CURDATE()))", [c.id_cliente]);
            n++;
        }
    }
    return { encoladas: n, encontradas: clientes.length };
}

// ===== 4. STOCK BAJO (aviso al administrador) =====
async function chequearStockBajo() {
    const productos = await q(
        `SELECT p.producto, p.tipo, (p.cantidad_existencia + p.cantidad_existencia_almacen) AS stock, x.u AS vendidas
         FROM (
            SELECT r.id_producto, SUM(r.cantidad) u
            FROM tab_facturas_reng r
            JOIN tab_facturas f ON f.id_factura = r.id_factura
            WHERE f.fecha_reg >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND f.anulado = 'no'
            GROUP BY r.id_producto
         ) x
         JOIN tab_productos p ON p.id_producto = x.id_producto
         WHERE p.activo = 'si'
           AND (p.cantidad_existencia + p.cantidad_existencia_almacen) <= 3
           AND x.u >= 5
         ORDER BY x.u DESC
         LIMIT 10`
    );
    if (!productos.length) return { avisados: 0 };
    const hoy = new Date().toISOString().slice(0, 10);
    const [ya] = await q("SELECT 1 FROM bot_stock_bajo_log WHERE fecha = ? LIMIT 1", [hoy]);
    if (ya && ya.length) return { avisados: 0, yaEnviado: true };

    let msg = `📦 *ALERTA DE STOCK BAJO — ONE4CARS*\n\nEstos productos se vendieron en los últimos 30 días y están por agotarse:\n\n`;
    productos.forEach(p => {
        msg += `• *${p.producto}* (${p.tipo || 's/tipo'}) — stock: *${p.stock}* · vendidas: ${p.vendidas}\n`;
    });
    msg += `\nRevise las órdenes de compra para reponer.`;
    if (adminRef) await adminRef(msg);
    await poolRef.query("INSERT IGNORE INTO bot_stock_bajo_log (fecha, detalle) VALUES (?, ?)", [hoy, msg.slice(0, 500)]);
    return { avisados: productos.length };
}

// ===== 5. FIDELIZACIÓN 10% (oficina, +10 compras al año) =====
async function chequearFidelizacion(forzar = false) {
    // Solo el día 1 del mes, ajustado a día hábil.
    const hoy = new Date();
    const dia1 = cola.ajustarDiaHabil(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    const esDia = forzar || (
        hoy.getFullYear() === dia1.getFullYear() &&
        hoy.getMonth() === dia1.getMonth() &&
        hoy.getDate() === dia1.getDate()
    );
    if (!esDia) return { aplicados: 0, motivo: 'no es el día de fidelización' };

    const clientes = await q(
        `SELECT c.id_cliente, c.nombres, c.celular, c.descuento, COUNT(f.id_factura) compras
         FROM tab_clientes c
         JOIN tab_facturas f ON f.id_cliente = c.id_cliente AND f.anulado = 'no'
              AND YEAR(f.fecha_reg) = YEAR(CURDATE())
         WHERE c.activo = 'SI' AND c.cliente_oficina = 'SI' AND c.celular <> ''
         GROUP BY c.id_cliente
         HAVING compras > 10`
    );
    let n = 0;
    for (const c of clientes) {
        const [ya] = await q(
            "SELECT 1 FROM bot_fidelizacion WHERE id_cliente = ? AND anio = YEAR(CURDATE()) LIMIT 1",
            [c.id_cliente]
        );
        if (ya && ya.length) continue;
        try {
            await poolRef.query(
                `INSERT INTO bot_fidelizacion (id_cliente, anio, compras, porcentaje) VALUES (?, YEAR(CURDATE()), ?, 10)
                 ON DUPLICATE KEY UPDATE compras = VALUES(compras)`,
                [c.id_cliente, c.compras]
            );
            // Marca de descuento del sistema (bandera existente).
            if (String(c.descuento || '').trim().toUpperCase() !== 'SI') {
                await poolRef.query("UPDATE tab_clientes SET descuento = 'SI' WHERE id_cliente = ?", [c.id_cliente]);
            }
        } catch (e) { console.log('[AUTO] Fidelización error:', e.message); continue; }

        const texto = `🏆 *¡BIENVENIDO AL CLUB DE FIDELIDAD ONE4CARS!*\n\nEstimado *${nombreCorto(c.nombres)}*, por su preferencia y sus *${c.compras} compras* este año, le otorgamos un *10% de descuento* en sus próximas compras.\n\nEl beneficio quedó activado en su cuenta. Gracias por confiar en nosotros. 🚗`;
        await cola.encolar({ tipo: 'fidelidad', telefono: c.celular, nombre: c.nombres, texto, prioridad: 3 });
        n++;
    }
    if (n && adminRef) {
        await adminRef(`🏆 Fidelización aplicada a *${n}* cliente(s) de oficina con más de 10 compras este año.`);
    }
    return { aplicados: n, encontrados: clientes.length };
}

// ===== 6. CARRITO ABANDONADO (48h después de consultar) =====
async function registrarInteres(telefono, consulta) {
    try {
        const tel = String(telefono || '').replace(/\s+/g, '');
        if (!tel || !consulta) return;
        await poolRef.query(
            "INSERT INTO bot_intereses (telefono, consulta) VALUES (?, ?)",
            [tel, String(consulta).slice(0, 280)]
        );
    } catch (e) {}
}

async function chequearCarrito() {
    const intereses = await q(
        `SELECT i.id, i.telefono, i.consulta
         FROM bot_intereses i
         WHERE i.contactado = 0 AND i.convertido = 0
           AND i.fecha < DATE_SUB(NOW(), INTERVAL 48 HOUR)
           AND i.fecha > DATE_SUB(NOW(), INTERVAL 7 DAY)
           AND NOT EXISTS (
               SELECT 1 FROM tab_facturas f
               WHERE REPLACE(REPLACE(f.celular,' ',''),'+','') COLLATE utf8_unicode_ci = REPLACE(REPLACE(i.telefono,' ',''),'+','')
                 AND f.fecha_reg >= DATE(i.fecha)
           )
         ORDER BY i.fecha ASC
         LIMIT 10`
    );
    let n = 0;
    for (const i of intereses) {
        const texto = `👋 Hola, le escribe *ONE4CARS*.\n\nHace un par de días revisamos su consulta sobre *${String(i.consulta || 'nuestro catálogo').slice(0, 80)}* y queríamos saber si desea que le enviemos la *lista de precios al mayor* o preparar una cotización para su negocio.\n\nRecuerde que trabajamos exclusivamente al mayor, con compra mínima de *USD 100*. ¿Le ayudo? 🚗`;
        const ok = await cola.encolar({ tipo: 'carrito', telefono: i.telefono, texto, prioridad: 4 });
        if (ok) {
            await poolRef.query("UPDATE bot_intereses SET contactado = 1 WHERE id = ?", [i.id]);
            n++;
        }
    }
    return { encoladas: n, encontradas: intereses.length };
}

// ===== 7. RECORDATORIO DE VISITA CADA 15 DÍAS =====
async function chequearVisitas15() {
    const clientes = await q(
        `SELECT c.id_cliente, c.nombres, c.celular
         FROM tab_clientes c
         LEFT JOIN bot_visita15_log v ON v.id_cliente = c.id_cliente
         WHERE c.activo = 'SI' AND c.celular <> ''
           AND (v.id_cliente IS NULL OR v.fecha_envio < DATE_SUB(NOW(), INTERVAL 15 DAY))
           AND EXISTS (
               SELECT 1 FROM tab_facturas f
               WHERE f.id_cliente = c.id_cliente AND f.anulado = 'no'
                 AND f.fecha_reg >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
           )
         ORDER BY v.fecha_envio ASC
         LIMIT 5`
    );
    let n = 0;
    for (const c of clientes) {
        const texto = `👋 Hola *${nombreCorto(c.nombres)}*, le saluda su asesor de *ONE4CARS*. Queremos coordinar una visita para conocer sus necesidades actuales y mostrarle las novedades del catálogo. ¿Qué día le queda cómodo esta semana? 🚗`;
        const ok = await cola.encolar({ tipo: 'visita', telefono: c.celular, nombre: c.nombres, texto, prioridad: 5 });
        if (ok) {
            await poolRef.query(
                "INSERT INTO bot_visita15_log (id_cliente, fecha_envio) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE fecha_envio = NOW()",
                [c.id_cliente]
            );
            n++;
        }
    }
    return { encoladas: n, encontradas: clientes.length };
}

// ===== 8. NO COBRAR: SAMY MOTORS, SUPER, IMPORTACIONES JJ 8.1, DAVERFREN =====
const EXCLUSIONES_COBRANZA = [
    "nombres LIKE '%SAMY MOTORS%'",
    "tipo = 'SUPER'",
    "nombres LIKE '%IMPORTACIONES JJ 8.1%'",
    "nombres LIKE '%DAVERFREN%'"
];

async function clientesExcluidosCobranza() {
    try {
        const rows = await q(
            `SELECT id_cliente FROM tab_clientes WHERE ${EXCLUSIONES_COBRANZA.join(' OR ')}`
        );
        const set = new Set(rows.map(r => Number(r.id_cliente)));
        const manuales = await q("SELECT id_cliente FROM bot_no_cobrar");
        for (const m of manuales) set.add(Number(m.id_cliente));
        return set;
    } catch (e) {
        return new Set();
    }
}

async function listarNoCobrar() {
    const fijos = await q(
        `SELECT id_cliente, nombres, tipo FROM tab_clientes WHERE ${EXCLUSIONES_COBRANZA.join(' OR ')} ORDER BY nombres`
    );
    const manuales = await q(
        `SELECT n.id_cliente, c.nombres, c.tipo, n.motivo, n.fecha
         FROM bot_no_cobrar n LEFT JOIN tab_clientes c ON c.id_cliente = n.id_cliente
         ORDER BY n.fecha DESC`
    );
    return { fijos, manuales };
}

async function agregarNoCobrar(texto) {
    const t = String(texto || '').trim();
    if (!t) return null;
    let cliente = null;
    if (/^\d+$/.test(t)) {
        const r = await q("SELECT id_cliente, nombres, tipo FROM tab_clientes WHERE id_cliente = ? LIMIT 1", [parseInt(t, 10)]);
        cliente = r[0] || null;
    } else {
        const r = await q(
            "SELECT id_cliente, nombres, tipo FROM tab_clientes WHERE nombres LIKE ? ORDER BY nombres LIMIT 1",
            [`%${t}%`]
        );
        cliente = r[0] || null;
    }
    if (!cliente) return null;
    await poolRef.query(
        "INSERT INTO bot_no_cobrar (id_cliente, motivo) VALUES (?, 'agregado por administrador') ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)",
        [cliente.id_cliente]
    );
    return cliente;
}

async function quitarNoCobrar(texto) {
    const t = String(texto || '').trim();
    if (!t) return null;
    let cliente = null;
    if (/^\d+$/.test(t)) {
        const r = await q("SELECT id_cliente, nombres FROM tab_clientes WHERE id_cliente = ? LIMIT 1", [parseInt(t, 10)]);
        cliente = r[0] || null;
    } else {
        const r = await q("SELECT id_cliente, nombres FROM tab_clientes WHERE nombres LIKE ? ORDER BY nombres LIMIT 1", [`%${t}%`]);
        cliente = r[0] || null;
    }
    if (!cliente) return null;
    await poolRef.query("DELETE FROM bot_no_cobrar WHERE id_cliente = ?", [cliente.id_cliente]);
    return cliente;
}

async function candidatosCobranza() {
    const excluidos = await clientesExcluidosCobranza();
    const rows = await q(
        `SELECT f.id_cliente, c.nombres, c.tipo, MAX(DATEDIFF(CURDATE(), f.fecha_reg)) dias,
                ROUND(SUM(f.total - f.abono_factura),2) saldo
         FROM tab_facturas f
         JOIN tab_clientes c ON c.id_cliente = f.id_cliente
         LEFT JOIN tab_vendedores v ON v.id_vendedor = f.id_vendedor
         WHERE f.pagada = 'NO' AND f.anulado = 'no'
           AND f.fecha_reg <= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           AND (v.nombre IS NULL OR v.nombre != 'MANUEL FERRAZ')
         GROUP BY f.id_cliente
         ORDER BY saldo DESC`
    );
    return rows.filter(r => !excluidos.has(Number(r.id_cliente)));
}

// ===== 9. MENSAJES DE MUESTRA (solo pruebas) =====
function textoMuestra(tipo) {
    const n = 'CLIENTE DE PRUEBA';
    switch (tipo) {
        case 'encuesta':
            return `⭐ *ENCUESTA DE SATISFACCIÓN ONE4CARS*\n\nHola *${n}*, hace 15 días recibió su factura *N° 1234*.\n\nNos gustaría saber cómo fue su experiencia. Responda con un número del *1 al 5*:\n\n1️⃣ Muy mala\n2️⃣ Mala\n3️⃣ Regular\n4️⃣ Buena\n5️⃣ Excelente\n\nSu opinión nos ayuda a servirle mejor. ¡Gracias! 🚗`;
        case 'aviso_vencimiento':
            return `⏰ *AVISO DE VENCIMIENTO — ONE4CARS*\n\nVendedor: *VENDEDOR DE PRUEBA*\n\nMañana se cumplen *30 días* de la factura *N° 1234* del cliente *${n}* (emitida el 09/10/2026).\n\nLe recordamos gestionar la cobranza para mantener la cartera al día.`;
        case 'aniversario':
            return `🎉 *¡FELIZ ANIVERSARIO, ${n}!* 🎉\n\nHoy celebramos *2 años* de trabajo conjunto. Gracias por su confianza y por permitirnos ser parte de su negocio.\n\nLe deseamos muchos éxitos más y seguimos a su disposición. 🚗\n\n— Equipo ONE4CARS`;
        case 'carrito':
            return `👋 Hola, le escribe *ONE4CARS*.\n\nHace un par de días revisamos su consulta sobre *bujías para Corolla 2015* y queríamos saber si desea que le enviemos la *lista de precios al mayor* o preparar una cotización para su negocio.\n\nRecuerde que trabajamos exclusivamente al mayor, con compra mínima de *USD 100*. ¿Le ayudo? 🚗`;
        case 'visita':
            return `👋 Hola *${n}*, le saluda su asesor de *ONE4CARS*. Queremos coordinar una visita para conocer sus necesidades actuales y mostrarle las novedades del catálogo. ¿Qué día le queda cómodo esta semana? 🚗`;
        case 'fria':
            return `¡Buenos días, *${n}*! 👋\n\nLe escribe *ONE4CARS*. Hace tiempo que no tenemos el gusto de atenderle y queríamos saludarle.\n\n• Precios mayoristas vigentes\n• Nuevas llegadas de repuestos\n• Atención personalizada y despacho a su zona\n\n¿Hay algo en lo que podamos ayudarle hoy? 🚗`;
        case 'leads':
            return `¡Hola, *${n}*! 👋\n\nLe escribe *ONE4CARS*. Vimos que se interesó en nuestros productos y queríamos acompañarle en el siguiente paso.\n\nPara abrir su cuenta de mayorista solo necesita enviar:\n1. Copia del RIF de la empresa.\n2. Foto del local.\n3. Dirección fiscal.\n4. Nombre del dueño.\n\nRecuerde que la compra mínima es de *USD 100*.`;
        case 'fidelidad':
            return `🏆 *¡BIENVENIDO AL CLUB DE FIDELIDAD ONE4CARS!*\n\nEstimado *${n}*, por su preferencia y sus *12 compras* este año, le otorgamos un *10% de descuento* en sus próximas compras.\n\nEl beneficio quedó activado en su cuenta. Gracias por confiar en nosotros. 🚗`;
        case 'stock':
            return `📦 *ALERTA DE STOCK BAJO — ONE4CARS*\n\nEstos productos se vendieron en los últimos 30 días y están por agotarse:\n\n• *B11001* (BUJIA) — stock: *2* · vendidas: 48\n• *MF9292* (FILTRO) — stock: *1* · vendidas: 22\n\nRevise las órdenes de compra para reponer.`;
        case 'satisfaccion_gracias':
            return `⭐ *ENCUESTA REGISTRADA*\n\nSu calificación: *5/5*\n\n¡Muchas gracias por su valoración! Nos alegra saber que tuvo una buena experiencia. 🙌\n\n— Equipo ONE4CARS`;
        default:
            return null;
    }
}

module.exports = {
    init, initTablas, nombreCorto, textoMuestra,
    chequearEncuestas, registrarRespuestaEncuesta,
    chequearAvisoVendedor, chequearAniversarios, chequearStockBajo,
    chequearFidelizacion, registrarInteres, chequearCarrito,
    chequearVisitas15, clientesExcluidosCobranza, EXCLUSIONES_COBRANZA,
    listarNoCobrar, agregarNoCobrar, quitarNoCobrar, candidatosCobranza
};
