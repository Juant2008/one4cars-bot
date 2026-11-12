/**
 * Ruta de venta del día.
 * Puntúa cada zona combinando:
 *  - cantidad de clientes activos en la misma zona
 *  - clientes con facturas vencidas (+30 días) y su saldo
 *  - clientes sin comprar hace +90 días
 * y devuelve las mejores zonas con los clientes a visitar.
 */
let poolRef = null;

function init(pool) { poolRef = pool; }

async function rankingZonas(limite = 5) {
    try {
        const [rows] = await poolRef.query(
            `SELECT TRIM(c.zona) AS zona,
                    COUNT(DISTINCT c.id_cliente) AS clientes,
                    COUNT(DISTINCT CASE WHEN m.id_cliente IS NOT NULL THEN c.id_cliente END) AS en_mora,
                    ROUND(COALESCE(SUM(m.saldo), 0), 2) AS saldo_mora,
                    COUNT(DISTINCT CASE WHEN ult.ultima IS NULL OR ult.ultima < DATE_SUB(CURDATE(), INTERVAL 90 DAY)
                                        THEN c.id_cliente END) AS frios
             FROM tab_clientes c
             LEFT JOIN (
                 SELECT id_cliente, SUM(total - abono_factura) AS saldo
                 FROM tab_facturas
                 WHERE pagada = 'NO' AND anulado = 'no'
                   AND fecha_reg <= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                 GROUP BY id_cliente
             ) m ON m.id_cliente = c.id_cliente
             LEFT JOIN (
                 SELECT id_cliente, MAX(fecha_reg) AS ultima
                 FROM tab_facturas WHERE anulado = 'no'
                 GROUP BY id_cliente
             ) ult ON ult.id_cliente = c.id_cliente
             WHERE c.activo = 'SI' AND c.zona IS NOT NULL AND c.zona <> ''
             GROUP BY TRIM(c.zona)`
        );
        const zonas = (rows || []).map(z => {
            const clientes = Number(z.clientes) || 0;
            const enMora = Number(z.en_mora) || 0;
            const saldo = Number(z.saldo_mora) || 0;
            const frios = Number(z.frios) || 0;
            // La cobranza pesa mucho más que la reactivación.
            const score = clientes * 1 + enMora * 8 + Math.min(saldo / 500, 30) + frios * 1;
            return { zona: z.zona, clientes, enMora, saldo, frios, score: Math.round(score * 10) / 10 };
        });
        zonas.sort((a, b) => b.score - a.score);
        return zonas.slice(0, limite);
    } catch (e) {
        console.log('[RUTA] Error ranking:', e.message);
        return [];
    }
}

async function detalleZona(zona, limite = 10) {
    try {
        const [rows] = await poolRef.query(
            `SELECT c.id_cliente, c.nombres, c.celular, TRIM(c.zona) AS zona,
                    COALESCE(m.saldo, 0) AS saldo,
                    COALESCE(m.dias, 0) AS dias_mora,
                    CASE WHEN ult.ultima IS NULL THEN NULL
                         ELSE DATEDIFF(CURDATE(), ult.ultima) END AS dias_sin_comprar
             FROM tab_clientes c
             LEFT JOIN (
                 SELECT id_cliente,
                        SUM(total - abono_factura) AS saldo,
                        MAX(DATEDIFF(CURDATE(), fecha_reg)) AS dias
                 FROM tab_facturas
                 WHERE pagada = 'NO' AND anulado = 'no'
                   AND fecha_reg <= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                 GROUP BY id_cliente
             ) m ON m.id_cliente = c.id_cliente
             LEFT JOIN (
                 SELECT id_cliente, MAX(fecha_reg) AS ultima
                 FROM tab_facturas WHERE anulado = 'no'
                 GROUP BY id_cliente
             ) ult ON ult.id_cliente = c.id_cliente
             WHERE c.activo = 'SI' AND TRIM(c.zona) = ?
             ORDER BY (COALESCE(m.saldo,0) > 0) DESC,
                      COALESCE(m.saldo, 0) DESC,
                      (ult.ultima IS NULL) DESC,
                      ult.ultima ASC
             LIMIT ?`,
            [zona, Number(limite) || 10]
        );
        return rows || [];
    } catch (e) {
        console.log('[RUTA] Error detalle:', e.message);
        return [];
    }
}

function money(n) {
    return Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normZona(s) {
    return String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim();
}

// Coincidencia por PALABRA: "este" NO debe coincidir con "oeste".
function coincideZona(zona, term) {
    const z = normZona(zona);
    const t = normZona(term);
    if (!t) return false;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(z);
}

async function buscarZona(term) {
    const zonas = await buscarZonas(term, 1);
    return zonas.length ? zonas[0] : null;
}

async function buscarZonas(term, limite = 20) {
    try {
        const consultar = async (q) => {
            const [rows] = await poolRef.query(
                "SELECT DISTINCT zona FROM tab_clientes WHERE zona IS NOT NULL AND zona <> '' AND zona LIKE ? ORDER BY zona LIMIT 300",
                [`%${q}%`]
            );
            return (rows || [])
                .map(r => String(r.zona || '').trim())
                .filter(z => z && coincideZona(z, q));
        };
        let filtradas = await consultar(term);
        // Si no aparece la zona completa, intentar con cada palabra significativa
        if (!filtradas.length) {
            const palabras = String(term || '').split(/\s+/).filter(p => p.length >= 4);
            for (const p of [...palabras].sort((a, b) => b.length - a.length)) {
                filtradas = await consultar(p);
                if (filtradas.length) break;
            }
        }
        return [...new Set(filtradas)].slice(0, Number(limite) || 20);
    } catch (e) { return []; }
}

const sesiones = new Map(); // telefono -> { zonas: [...], i: 0 }

function tieneSesion(telefono) {
    return sesiones.has(String(telefono || ''));
}

async function textoRuta(telefono) {
    const ranking = await rankingZonas(100);
    if (!ranking.length) return 'No encontré zonas con clientes activos.';
    sesiones.set(String(telefono || ''), { zonas: ranking.map(z => z.zona), i: 0 });
    let msg = `🗺️ *RUTA RECOMENDADA DE HOY*\n_Prioriza cobranza vencida y concentración de clientes._\n\n`;

    const top = ranking[0];
    const detalle = await detalleZona(top.zona, 200);
    msg += `🏆 *${top.zona}* — puntaje *${top.score}*\n`;
    msg += `• Clientes activos: *${top.clientes}*\n`;
    msg += `• Con facturas vencidas: *${top.enMora}* por *$${money(top.saldo)}*\n`;
    msg += `• Sin comprar +90 días: *${top.frios}*\n\n`;

    if (detalle.length) {
        msg += `📋 *Clientes a visitar en ${top.zona}:*\n`;
        detalle.forEach((c, i) => {
            const partes = [];
            if (Number(c.saldo) > 0) partes.push(`debe *$${money(c.saldo)}* (${c.dias_mora}d)`);
            if (c.dias_sin_comprar === null) partes.push('sin compras registradas');
            else if (Number(c.dias_sin_comprar) >= 90) partes.push(`hace *${c.dias_sin_comprar}d* sin comprar`);
            msg += `${i + 1}. *${c.nombres}*${partes.length ? ' — ' + partes.join(' · ') : ''}\n`;
            if (c.celular) msg += `   📞 ${String(c.celular).trim()}\n`;
        });
        msg += `\n`;
    }

    const otras = ranking.slice(1);
    if (otras.length) {
        msg += `📌 *Otras zonas con potencial:*\n`;
        otras.forEach((z, i) => {
            msg += `${i + 2}. *${z.zona}* — ${z.clientes} clientes · ${z.enMora} en mora ($${money(z.saldo)}) · ${z.frios} fríos\n`;
        });
    }
    msg += `\nSi esa zona no te sirve (tráfico, etc.): *otra opción*\nPara ver una zona en detalle: *ruta ${ranking[1] ? ranking[1].zona : top.zona}*`;
    return msg;
}

async function otraRuta(telefono) {
    const key = String(telefono || '');
    const st = sesiones.get(key);
    if (!st) return textoRuta(telefono);
    if (st.i + 1 >= st.zonas.length) {
        return 'Ya te mostré todas las zonas con potencial. Escríbeme *ruta NOMBRE DE ZONA* para ver una en específico.';
    }
    st.i++;
    const zona = st.zonas[st.i];
    const txt = await textoZona(zona);
    return `🔁 *Otra opción (${st.i + 1}/${st.zonas.length})*\n\n${txt}`;
}

async function textoClientesZona(term) {
    const zonas = await buscarZonas(term, 50);
    if (!zonas.length) return `No encontré zonas que contengan "*${term}*".`;
    const marcas = zonas.map(() => '?').join(',');
    const [rows] = await poolRef.query(
        `SELECT c.id_cliente, c.nombres, c.zona, c.celular,
                COALESCE(p.pend, 0) AS pend,
                COALESCE(p.vencido, 0) AS vencido,
                COALESCE(p.nfact, 0) AS nfact,
                COALESCE(p.dias, 0) AS dias,
                u.ultima,
                CASE WHEN u.ultima IS NULL THEN NULL ELSE DATEDIFF(CURDATE(), u.ultima) END AS dias_sin_comprar,
                COALESCE(v.comprado, 0) AS comprado,
                COALESCE(v.ncompras, 0) AS ncompras
         FROM tab_clientes c
         LEFT JOIN (
             SELECT f.id_cliente,
                    SUM(f.total - f.abono_factura) AS pend,
                    SUM(CASE WHEN DATEDIFF(CURDATE(), f.fecha_reg) >= 30 THEN f.total - f.abono_factura ELSE 0 END) AS vencido,
                    COUNT(*) AS nfact,
                    MAX(DATEDIFF(CURDATE(), f.fecha_reg)) AS dias
             FROM tab_facturas f
             WHERE f.pagada = 'NO' AND f.anulado = 'no'
             GROUP BY f.id_cliente
         ) p ON p.id_cliente = c.id_cliente
         LEFT JOIN (
             SELECT id_cliente, MAX(fecha_reg) AS ultima
             FROM tab_facturas WHERE anulado = 'no' GROUP BY id_cliente
         ) u ON u.id_cliente = c.id_cliente
         LEFT JOIN (
             SELECT id_cliente, SUM(total - abono_factura) AS comprado, COUNT(*) AS ncompras
             FROM tab_facturas WHERE anulado = 'no' GROUP BY id_cliente
         ) v ON v.id_cliente = c.id_cliente
         WHERE c.activo = 'SI' AND TRIM(c.zona) IN (${marcas})
         ORDER BY TRIM(c.zona) ASC,
                  COALESCE(p.dias, 0) DESC,
                  COALESCE(p.vencido, 0) DESC,
                  c.nombres`,
        zonas
    );
    const clientes = rows || [];
    const conVencida = clientes.filter(c => Number(c.vencido) > 0);
    const conPendiente = clientes.filter(c => Number(c.pend) > 0 && Number(c.vencido) <= 0);
    const alDia = clientes.filter(c => Number(c.pend) <= 0 && c.ultima);
    const sinCompras = clientes.filter(c => !c.ultima);
    const totalVencido = conVencida.reduce((a, c) => a + Number(c.vencido), 0);
    const totalNoVencido = conPendiente.reduce((a, c) => a + Number(c.pend), 0);
    const totalPend = clientes.reduce((a, c) => a + Number(c.pend), 0);

    let msg = `🗺️ *ZONA "${term.toUpperCase()}"*\n`;
    msg += `Zonas: ${zonas.join(' · ')}\n\n`;
    let totalRegistrados = clientes.length;
    try {
        const [tot] = await poolRef.query(
            `SELECT COUNT(*) AS n FROM tab_clientes WHERE TRIM(zona) IN (${marcas})`,
            zonas
        );
        if (tot && tot[0] && Number(tot[0].n) > 0) totalRegistrados = Number(tot[0].n);
    } catch (e) {}
    msg += `• Clientes en la zona: *${totalRegistrados}* (activos: *${clientes.length}*)\n`;
    msg += `• 🔴 Con factura VENCIDA: *${conVencida.length}* → *$${money(totalVencido)}*\n`;
    msg += `• 🧾 Con factura NO vencida: *${conPendiente.length}* → *$${money(totalNoVencido)}* _(no visitar aún)_\n`;
    msg += `• ✅ Al día (compró y no debe): *${alDia.length}*\n`;
    msg += `• ⚪ Sin compras registradas: *${sinCompras.length}*\n`;
    msg += `• Total pendiente: *$${money(totalPend)}*\n`;
    msg += `\n_Ordenados por zona y días de vencimiento (más viejo primero)._`;

    const porZona = new Map();
    for (const c of clientes) {
        const z = c.zona || 'SIN ZONA';
        if (!porZona.has(z)) porZona.set(z, []);
        porZona.get(z).push(c);
    }
    const zonasOrdenadas = [...porZona.keys()].sort((a, b) => String(a).localeCompare(String(b), 'es'));
    for (const zona of zonasOrdenadas) {
        const lista = porZona.get(zona);
        msg += `\n*${zona}* (${lista.length})\n`;
        lista.forEach((c, i) => {
            let estado = '⚪ Sin compras';
            if (Number(c.vencido) > 0) estado = `🔴 *VENCIDA* $${money(c.vencido)} · ${c.dias}d`;
            else if (Number(c.pend) > 0) estado = `🧾 Factura $${money(c.pend)} · ${c.dias}d · *NO vencida* (no visitar aún)`;
            else if (c.ultima) estado = `✅ Al día`;
            const compras = c.ultima
                ? `$${money(c.comprado)} en ${c.ncompras} fact · últ. ${new Date(c.ultima).toLocaleDateString('es-VE')}`
                : 'sin compras';
            msg += `${i + 1}. ${c.nombres} — ${estado} · ${compras}`;
            if (c.celular) msg += ` · 📞 ${String(c.celular).trim()}`;
            msg += `\n`;
        });
    }
    return msg.trim();
}

async function textoZona(term) {
    const zonas = await buscarZonas(term, 25);
    if (!zonas.length) return `No encontré una zona que coincida con "*${term}*".`;

    // Si hay varias coincidencias, mostrarlas todas para que elija.
    if (zonas.length > 1) {
        const ranking = await rankingZonas(200);
        const mapa = new Map(ranking.map(z => [z.zona, z]));
        let msg = `🗺️ *ZONAS QUE COINCIDEN CON "${term}" (${zonas.length})*\n\n`;
        zonas.forEach((z, i) => {
            const info = mapa.get(z) || { clientes: 0, enMora: 0, saldo: 0, frios: 0 };
            msg += `${i + 1}. *${z}* — ${info.clientes} clientes · ${info.enMora} en mora ($${money(info.saldo)}) · ${info.frios} fríos\n`;
        });
        msg += `\nEscribe *ruta NOMBRE EXACTO* para ver el detalle de una.`;
        return msg.trim();
    }

    const zona = zonas[0];
    const ranking = await rankingZonas(200);
    const info = ranking.find(z => z.zona === zona) || { zona, clientes: 0, enMora: 0, saldo: 0, frios: 0, score: 0 };
    const detalle = await detalleZona(zona, 200);
    let msg = `🗺️ *ZONA ${zona}*\n\n• Clientes activos: *${info.clientes}*\n• Con facturas vencidas: *${info.enMora}* por *$${money(info.saldo)}*\n• Sin comprar +90 días: *${info.frios}*\n\n`;
    if (detalle.length) {
        msg += `*Clientes:*\n`;
        detalle.forEach((c, i) => {
            const partes = [];
            if (Number(c.saldo) > 0) partes.push(`$${money(c.saldo)} (${c.dias_mora}d)`);
            if (c.dias_sin_comprar === null) partes.push('sin compras');
            else if (Number(c.dias_sin_comprar) >= 90) partes.push(`${c.dias_sin_comprar}d sin comprar`);
            msg += `${i + 1}. ${c.nombres}${partes.length ? ' — ' + partes.join(' · ') : ''}\n`;
        });
    }
    return msg.trim();
}

module.exports = { init, rankingZonas, detalleZona, textoRuta, textoZona, textoClientesZona, buscarZona, buscarZonas, otraRuta, tieneSesion };

