const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerFacturasNoNotificadas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
        `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular, f.total, f.fecha_reg, f.id_cliente, f.id_vendedor,
                v.celular_vendedor, v.nombre as vendedor_nombre
         FROM tab_facturas f
         LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
         WHERE f.whatsapp_notificado = 'NO' AND f.anulado = 'no' AND pagada = 'NO'
         ORDER BY f.id_factura ASC`
    );
    await conn.end();
    return rows;
}

async function obtenerFacturasNoNotificadasCount() {
    const conn = await mysql.createConnection(dbConfig);
    // CORREGIDO: Se usan backticks para evitar el error de token por salto de línea
    const [rows] = await conn.execute(`SELECT COUNT(*) as total FROM tab_facturas 
    WHERE whatsapp_notificado = 'NO' AND pagada = 'NO' AND anulado = 'no'`);
    await conn.end();
    return rows[0].total;
}

// ===== RECORDATORIOS POR VENCIMIENTO =====
async function obtenerFacturasVencidas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
        `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular, f.total, f.abono_factura,
                f.porcentaje, f.fecha_reg, f.id_cliente, f.id_vendedor,
                v.celular_vendedor, v.nombre as vendedor_nombre,
                DATEDIFF(CURDATE(), f.fecha_reg) as dias_vencida
         FROM tab_facturas f
         LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
         LEFT JOIN tab_clientes c ON f.id_cliente = c.id_cliente
         WHERE f.pagada = 'NO' AND f.anulado = 'no'
           AND f.fecha_reg <= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           AND (c.cliente_oficina IS NULL OR c.cliente_oficina != 'SI')
           AND (v.nombre IS NULL OR v.nombre != 'OFICINA')  AND (v.nombre IS NULL OR v.nombre != 'MANUEL FERRAZ') -- FILTRO SOLICITADO
         ORDER BY f.fecha_reg ASC`
    );
    await conn.end();
    return rows;
}

async function obtenerFacturasVencidasAll() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
        `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular, f.total, f.abono_factura,
                f.porcentaje, f.fecha_reg, f.id_cliente, f.id_vendedor,
                v.celular_vendedor, v.nombre as vendedor_nombre,
                DATEDIFF(CURDATE(), f.fecha_reg) as dias_vencida
         FROM tab_facturas f
         LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
         WHERE f.pagada = 'NO' AND f.anulado = 'no'
           AND f.fecha_reg <= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           AND (v.nombre IS NULL OR v.nombre != 'OFICINA') -- FILTRO SOLICITADO
         ORDER BY f.fecha_reg ASC`
    );
    await conn.end();
    return rows;
}

async function obtenerRecordatoriosEnviados() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT id_factura, nivel FROM recordatorios_log");
    await conn.end();
    const map = {};
    for (const r of rows) {
        if (!map[r.id_factura]) map[r.id_factura] = [];
        map[r.id_factura].push(r.nivel);
    }
    return map;
}

async function marcarRecordatorio(id_factura, nivel) {
    const conn = await mysql.createConnection(dbConfig);
    try {
        await conn.execute("INSERT INTO recordatorios_log (id_factura, nivel) VALUES (?, ?)", [id_factura, nivel]);
    } catch (e) {}
    await conn.end();
}

async function obtenerUltimoEnvioVendedor() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT MAX(fecha_envio) as ultimo FROM envio_vendedor_log");
    await conn.end();
    return rows[0].ultimo || null;
}

async function marcarEnvioVendedor() {
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute("INSERT INTO envio_vendedor_log (fecha_envio) VALUES (CURDATE())");
    await conn.end();
}

module.exports = {
    obtenerFacturasNoNotificadas,
    obtenerFacturasNoNotificadasCount,
    obtenerFacturasVencidas,
    obtenerFacturasVencidasAll,
    obtenerRecordatoriosEnviados,
    marcarRecordatorio,
    obtenerUltimoEnvioVendedor,
    marcarEnvioVendedor
};
