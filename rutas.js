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
            `SELECT c.zona,
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
             GROUP BY c.zona`
        );
        const zonas = (rows || []).map(z => {
            const clientes = Number(z.clientes) || 0;
            const enMora = Number(z.en_mora) || 0;
            const saldo = Number(z.saldo_mora) || 0;
            const frios = Number(z.frios) || 0;
            const score = clientes * 1 + enMora * 5 + frios * 2 + Math.min(saldo / 1000, 15);
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
            `SELECT c.id_cliente, c.nombres, c.celular, c.zona,
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
             WHERE c.activo = 'SI' AND c.zona = ?
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

async function buscarZona(term) {
    try {
        const [rows] = await poolRef.query(
            "SELECT DISTINCT zona FROM tab_clientes WHERE zona IS NOT NULL AND zona <> '' AND zona LIKE ? ORDER BY zona LIMIT 1",
            [`%${term}%`]
        );
        return rows && rows[0] ? rows[0].zona : null;
    } catch (e) { return null; }
}

async function textoRuta() {
    const ranking = await rankingZonas(5);
    if (!ranking.length) return 'No encontré zonas con clientes activos.';
    let msg = `🗺️ *RUTA RECOMENDADA DE HOY*\n_Combina concentración de clientes, cobranza vencida y reactivación._\n\n`;

    const top = ranking[0];
    const detalle = await detalleZona(top.zona, 8);
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
    msg += `\nPara ver una zona en detalle: *ruta ${ranking[1] ? ranking[1].zona : top.zona}*`;
    return msg;
}

async function textoZona(term) {
    const zona = await buscarZona(term);
    if (!zona) return `No encontré una zona que coincida con "*${term}*".`;
    const ranking = await rankingZonas(100);
    const info = ranking.find(z => z.zona === zona) || { zona, clientes: 0, enMora: 0, saldo: 0, frios: 0, score: 0 };
    const detalle = await detalleZona(zona, 15);
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

module.exports = { init, rankingZonas, detalleZona, textoRuta, textoZona, buscarZona };
