/**
 * Acciones naturales del gerente: el bot interpreta órdenes y las ejecuta
 * (encolando mensajes), no solo las responde como consulta.
 */
let pool, encolarFn, enviarFn, fmtFn, excluidosFn, colaRef;

function init(p, deps) {
    pool = p;
    encolarFn = deps.encolar;
    enviarFn = deps.enviar;
    fmtFn = deps.fmt;
    excluidosFn = deps.excluidos;
    colaRef = deps.cola;
}

function money(n) {
    return Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ¿Hoy es sábado o domingo en Venezuela? */
function esFinDeSemana() {
    const dia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' })).getDay();
    return dia === 0 || dia === 6;
}

/** Extrae filtros naturales: días, monto, zona, vendedor, cliente y límite. */
function parseFiltros(t) {
    const mDias = t.match(/(?:m[aá]s de|mayor(?:es)? a|superior a|desde|hace)\s+(\d{1,3})\s*d[ií]as/i)
        || t.match(/(\d{1,3})\s*d[ií]as/i);
    const mMonto = t.match(/(?:m[aá]s de|mayor(?:es)? a|superior a|desde)\s*\$?\s*([\d.,]+)\s*(?:usd|d[oó]lares|\$)/i)
        || t.match(/\$\s*([\d.,]+)/);
    const limpiar = (s) => String(s || '')
        .replace(/\s+(?:a|para)\s+\d{1,3}\s+clientes?.*$/i, '')
        .replace(/\s+(?:con|que|y)\s+.*$/i, '')
        .replace(/[?.!]+$/g, '')
        .trim();
    const mZona = t.match(/zona\s+(.+?)(?:\s+(?:con|que|y)\s+|$)/i);
    const mVend = t.match(/vendedor\s+(.+?)(?:\s+(?:con|que|y)\s+|$)/i);
    const mCli = t.match(/\bal\s+cliente\s+(.+?)(?:\s+(?:con|que|y)\s+|$)/i);
    const mLim = t.match(/(?:a|para)\s+(\d{1,3})\s+(?:clientes|vendedores)/i) || t.match(/l[ií]mite\s+(\d{1,3})/i);
    const parseMonto = (s) => {
        let x = String(s || '').replace(/[^\d.,]/g, '');
        const lc = x.lastIndexOf(','), ld = x.lastIndexOf('.');
        if (lc > -1 && ld > -1) x = lc > ld ? x.replace(/\./g, '').replace(',', '.') : x.replace(/,/g, '');
        else if (lc > -1) x = (x.length - lc - 1 === 3) ? x.replace(/,/g, '') : x.replace(',', '.');
        return parseFloat(x);
    };
    return {
        dias: mDias ? parseInt(mDias[1], 10) : null,
        monto: mMonto ? parseMonto(mMonto[1]) : null,
        zona: mZona ? limpiar(mZona[1]) : null,
        vendedor: mVend ? limpiar(mVend[1]) : null,
        cliente: mCli ? limpiar(mCli[1]) : null,
        limite: Math.min(mLim ? parseInt(mLim[1], 10) : 20, 50)
    };
}

function whereFiltros(f, alias = 'c') {
    let sql = '';
    const params = [];
    if (f.zona) { sql += ` AND ${alias}.zona LIKE ?`; params.push(`%${f.zona}%`); }
    if (f.vendedor) { sql += ` AND ${alias}.vendedor LIKE ?`; params.push(`%${f.vendedor}%`); }
    if (f.cliente) { sql += ` AND ${alias}.nombres LIKE ?`; params.push(`%${f.cliente}%`); }
    return { sql, params };
}

function resumenEnvio(titulo, encontrados, encolados, omitidos, extra = '', nombres = []) {
    let s = `📨 *${titulo}*\n\n• Encontrados: *${encontrados}*\n• Mensajes en cola: *${encolados}*\n• Omitidos: *${omitidos}*\n${extra}`;
    if (nombres.length) {
        s += `\n*Detalle (${nombres.length}):*\n`;
        nombres.forEach((n, i) => { s += `${i + 1}. ${n}\n`; });
    }
    s += colaRef && colaRef.config.modo_prueba ? '\n⚠️ Modo prueba: saldrán al 584123715550.' : '\n✅ Se enviarán según la cola anti-baneo.';
    return s;
}

// ===== 1. Recordatorio de visita =====
async function accionVisita(from, t) {
    if (!/(?:recu[eé]rdale|recordar|recordatorio|agenda|coordina|env[ií]a|manda)/i.test(t)) return false;
    if (!/visita/i.test(t)) return false;
    const f = parseFiltros(t);
    const dias = f.dias || 30;
    const w = whereFiltros(f);
    const [rows] = await pool.query(
        `SELECT c.id_cliente, c.nombres, c.celular
         FROM tab_clientes c
         LEFT JOIN (SELECT id_cliente, MAX(fecha_reg) ultima FROM tab_facturas WHERE anulado='no' GROUP BY id_cliente) u ON u.id_cliente=c.id_cliente
         LEFT JOIN bot_visita15_log v ON v.id_cliente=c.id_cliente
         WHERE c.activo='SI' AND c.celular<>''
           AND (v.id_cliente IS NULL OR v.fecha_envio < DATE_SUB(NOW(), INTERVAL 15 DAY))
           AND (u.ultima IS NULL OR u.ultima < DATE_SUB(CURDATE(), INTERVAL ? DAY))
           ${w.sql}
         ORDER BY u.ultima ASC
         LIMIT ?`,
        [dias, ...w.params, f.limite]
    );
    let enc = 0, om = 0;
    const nombres = [];
    for (const c of (rows || [])) {
        const texto = `👋 Hola *${c.nombres}*, le saluda su asesor de *ONE4CARS*. Queremos coordinar una visita para conocer sus necesidades actuales y mostrarle las novedades del catálogo. ¿Qué día le queda cómodo esta semana? 🚗`;
        const ok = await encolarFn({ tipo: 'visita', telefono: c.celular, nombre: c.nombres, texto, prioridad: 5 });
        if (ok) {
            enc++;
            nombres.push(c.nombres);
            try { await pool.query("INSERT INTO bot_visita15_log (id_cliente, fecha_envio) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE fecha_envio=NOW()", [c.id_cliente]); } catch (e) {}
        } else om++;
    }
    await enviarFn(from, resumenEnvio(`RECORDATORIOS DE VISITA (+${dias} días sin comprar)`, (rows || []).length, enc, om, '', nombres));
    return true;
}

// ===== 2. Estado de cuenta masivo =====
async function accionEstadoCuenta(from, t) {
    if (!/(?:env[ií]a|manda|comparte|m[aá]ndale)/i.test(t)) return false;
    if (!/estado de cuenta/i.test(t)) return false;
    const f = parseFiltros(t);
    const w = whereFiltros(f);
    let sql = `SELECT c.id_cliente, c.nombres, c.celular, COUNT(*) facturas,
                      ROUND(SUM(f.total - f.abono_factura), 2) saldo
               FROM tab_facturas f
               JOIN tab_clientes c ON c.id_cliente = f.id_cliente
               WHERE f.pagada='NO' AND f.anulado='no' AND c.celular<>''`;
    const params = [];
    if (f.dias) { sql += " AND DATEDIFF(CURDATE(), f.fecha_reg) >= ?"; params.push(f.dias); }
    sql += w.sql; params.push(...w.params);
    if (f.monto) { sql += " AND (f.total - f.abono_factura) >= ?"; params.push(f.monto); }
    sql += " GROUP BY c.id_cliente ORDER BY saldo DESC LIMIT ?";
    params.push(f.limite);
    const [rows] = await pool.query(sql, params);

    let enc = 0, om = 0;
    const nombres = [];
    for (const c of (rows || [])) {
        const [facts] = await pool.query(
            "SELECT nro_factura FROM tab_facturas WHERE id_cliente=? AND pagada='NO' AND anulado='no' ORDER BY fecha_reg ASC LIMIT 3",
            [c.id_cliente]
        );
        let links = '';
        (facts || []).forEach(x => { links += `• #${x.nro_factura}: https://www.one4cars.com/uploads/notas/${x.nro_factura}.jpg\n`; });
        const texto = `📊 *ESTADO DE CUENTA*\n\nHola *${c.nombres}*, su saldo pendiente es *$${money(c.saldo)}* en *${c.facturas}* factura(s).\n\n${links ? '*Facturas firmadas:*\n' + links : ''}\nLe agradecemos gestionar el pago. Estamos a su disposición. 🚗`;
        const ok = await encolarFn({ tipo: 'estado_cuenta', telefono: c.celular, nombre: c.nombres, texto, prioridad: 3 });
        if (ok) { enc++; nombres.push(`${c.nombres} ($${money(c.saldo)})`); } else om++;
    }
    await enviarFn(from, resumenEnvio('ESTADOS DE CUENTA ENVIADOS', (rows || []).length, enc, om, '', nombres)
        + `\n📅 *Solo se envían de lunes a viernes*, de 8:00 a.m. a 6:00 p.m., repartidos por la cola anti-baneo.`
        + (esFinDeSemana() ? '\n⏳ Hoy es fin de semana: el primero saldrá el lunes.' : ''));
    return true;
}

// ===== 3. Lista de precios =====
async function accionListaPrecios(from, t) {
    if (!/(?:env[ií]a|manda|comparte|m[aá]ndale)/i.test(t)) return false;
    if (!/(lista de precios|cat[aá]logo)/i.test(t)) return false;
    const f = parseFiltros(t);
    const w = whereFiltros(f);
    const [rows] = await pool.query(
        `SELECT c.id_cliente, c.nombres, c.celular FROM tab_clientes c
         WHERE c.activo='SI' AND c.celular<>'' ${w.sql}
         ORDER BY c.nombres LIMIT ?`,
        [...w.params, f.limite]
    );
    let enc = 0, om = 0;
    const nombres = [];
    for (const c of (rows || [])) {
        const texto = `📋 *LISTA DE PRECIOS ONE4CARS*\n\nHola *${c.nombres}*, le compartimos nuestra lista de precios al mayor vigente:\nhttps://www.one4cars.com/lista_de_precios.php/\n\nRecuerde: trabajamos al mayor con compra mínima de *USD 100*. ¿Le ayudo con algo en específico? 🚗`;
        const ok = await encolarFn({ tipo: 'lista_precios', telefono: c.celular, nombre: c.nombres, texto, prioridad: 4 });
        if (ok) { enc++; nombres.push(c.nombres); } else om++;
    }
    await enviarFn(from, resumenEnvio('LISTA DE PRECIOS ENVIADA', (rows || []).length, enc, om, '', nombres));
    return true;
}

// ===== 4. Campaña de clientes fríos =====
async function accionFrios(from, t) {
    if (!/(campa[nñ]a\s*(fr[ií]a|fr[ií]os)|reactivaci[oó]n|clientes fr[ií]os)/i.test(t)) return false;
    const f = parseFiltros(t);
    const dias = f.dias || 60;
    const w = whereFiltros(f);
    const [rows] = await pool.query(
        `SELECT c.id_cliente, c.nombres, c.celular, u.ultima
         FROM tab_clientes c
         JOIN (SELECT id_cliente, MAX(fecha_reg) ultima FROM tab_facturas WHERE anulado='no' GROUP BY id_cliente) u ON u.id_cliente=c.id_cliente
         WHERE c.activo='SI' AND c.celular<>''
           AND u.ultima < DATE_SUB(CURDATE(), INTERVAL ? DAY)
           ${w.sql}
         ORDER BY u.ultima ASC LIMIT ?`,
        [dias, ...w.params, f.limite]
    );
    let enc = 0, om = 0;
    const nombres = [];
    for (const c of (rows || [])) {
        const texto = `¡Buenos días, *${c.nombres}*! 👋\n\nLe escribe *ONE4CARS*. Hace tiempo que no tenemos el gusto de atenderle (su última compra fue el ${new Date(c.ultima).toLocaleDateString('es-VE')}).\n\n• Precios mayoristas vigentes\n• Nuevas llegadas de repuestos\n• Atención personalizada y despacho a su zona\n\n¿Hay algo en lo que podamos ayudarle hoy? 🚗`;
        const ok = await encolarFn({ tipo: 'fria', telefono: c.celular, nombre: c.nombres, texto, prioridad: 5 });
        if (ok) { enc++; nombres.push(c.nombres); } else om++;
    }
    await enviarFn(from, resumenEnvio(`CAMPAÑA FRÍA (+${dias} días sin comprar)`, (rows || []).length, enc, om, '', nombres));
    return true;
}

// ===== 5. No cobrar masivo por zona / vendedor =====
async function accionNoCobrarMasivo(from, t) {
    if (!/no\s+cobrar/i.test(t)) return false;
    if (!/(zona|vendedor)/i.test(t)) return false;
    const f = parseFiltros(t);
    if (!f.zona && !f.vendedor) return false;
    let where = '';
    const params = [];
    if (f.zona) { where += " zona LIKE ?"; params.push(`%${f.zona}%`); }
    if (f.vendedor) { where += (where ? " OR" : "") + " vendedor LIKE ?"; params.push(`%${f.vendedor}%`); }
    const [rows] = await pool.query(`SELECT id_cliente FROM tab_clientes WHERE ${where}`, params);
    let n = 0;
    for (const r of (rows || [])) {
        try {
            await pool.query("INSERT IGNORE INTO bot_no_cobrar (id_cliente, motivo) VALUES (?, ?)", [r.id_cliente, `excluido por ${f.zona ? 'zona ' + f.zona : 'vendedor ' + f.vendedor}`]);
            n++;
        } catch (e) {}
    }
    await enviarFn(from, `🚫 *NO COBRAR MASIVO*\n\n• Regla: ${f.zona ? 'zona ' + f.zona : 'vendedor ' + f.vendedor}\n• Clientes excluidos: *${n}*\n\nYa no recibirán recordatorios de cobranza.`);
    return true;
}

// ===== 6. Control natural de la cola =====
async function accionCola(from, t) {
    if (!colaRef) return false;
    const cmd = colaRef.comando(t);
    if (!cmd) return false;
    if (cmd.accion === 'config') { await colaRef.aplicar(cmd.cambios); }
    else if (cmd.accion === 'vaciar') { await colaRef.vaciar(); }
    await enviarFn(from, await colaRef.estado());
    return true;
}

// ===== 7. Aviso de cartera a vendedores =====
async function accionAvisoVendedores(from, t) {
    if (!/av[ií]sa(?:le|les)?\s+a\s+los\s+vendedores|env[ií]a(?:le|les)?\s+(?:la\s+)?cartera\s+a\s+los\s+vendedores/i.test(t)) return false;
    const f = parseFiltros(t);
    const [rows] = await pool.query(
        `SELECT v.id_vendedor, v.nombre, v.celular_vendedor,
                COUNT(DISTINCT f.id_cliente) clientes,
                COUNT(*) facturas,
                ROUND(SUM(f.total - f.abono_factura), 2) saldo
         FROM tab_facturas f
         JOIN tab_vendedores v ON v.id_vendedor = f.id_vendedor
         WHERE f.pagada='NO' AND f.anulado='no' AND v.celular_vendedor IS NOT NULL AND v.celular_vendedor <> ''
         GROUP BY v.id_vendedor HAVING saldo > 0 ORDER BY saldo DESC LIMIT ?`,
        [f.limite]
    );
    let enc = 0, om = 0;
    const nombres = [];
    for (const v of (rows || [])) {
        const texto = `📊 *SU CARTERA PENDIENTE — ONE4CARS*\n\nVendedor: *${v.nombre}*\n\n• Clientes con deuda: *${v.clientes}*\n• Facturas pendientes: *${v.facturas}*\n• Total por cobrar: *$${money(v.saldo)}*\n\nLe recordamos gestionar estos cobros para mantener la rotación. Escriba *cartera de ${v.nombre}* para ver el detalle.`;
        const ok = await encolarFn({ tipo: 'cartera_vendedor', telefono: v.celular_vendedor, nombre: v.nombre, texto, prioridad: 3 });
        if (ok) { enc++; } else om++;
    }
    await enviarFn(from, resumenEnvio('AVISO DE CARTERA A VENDEDORES', (rows || []).length, enc, om));
    return true;
}

async function manejar(from, t) {
    if (await accionCola(from, t)) return true;
    if (await accionNoCobrarMasivo(from, t)) return true;
    if (await accionAvisoVendedores(from, t)) return true;
    if (await accionVisita(from, t)) return true;
    if (await accionEstadoCuenta(from, t)) return true;
    if (await accionListaPrecios(from, t)) return true;
    if (await accionFrios(from, t)) return true;
    return false;
}

module.exports = { init, manejar, parseFiltros };

