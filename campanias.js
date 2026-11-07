/**
 * Campañas de recuperación de clientes fríos y seguimiento de leads.
 * - clientesFrios: clientes activos sin compra reciente.
 * - enviarFria: mensaje personalizado con control de duplicados (bot_campania_log).
 * - enviarLeads: seguimiento a interesados que no completaron registro/pedido.
 * - resumenDiario: digest natural para los administradores.
 */
const axios = require('axios');

let poolRef = null;
let enviarRef = null;   // async (jid, texto) => void
let formatRef = null;   // (tel) => jid

function init(pool, { enviar, format }) {
  poolRef = pool;
  enviarRef = enviar;
  formatRef = format;
}

async function clientesFrios(dias = 60, limite = 50) {
  const [rows] = await poolRef.query(
    `SELECT c.id_cliente, c.nombres, c.celular, c.telefono, c.vendedor,
            MAX(f.fecha_reg) AS ultima_compra,
            COUNT(f.id_factura) AS compras,
            COALESCE(SUM(f.total_desc), 0) AS monto_total
     FROM tab_clientes c
     JOIN tab_facturas f ON f.id_cliente = c.id_cliente AND f.anulado = 'no'
     WHERE c.activo = 'SI'
       AND (c.celular <> '' OR c.telefono <> '')
     GROUP BY c.id_cliente
     HAVING ultima_compra < DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY ultima_compra DESC
     LIMIT ?`,
    [Number(dias) || 60, Number(limite) || 50]
  );
  return rows || [];
}

async function yaEnviado(campania, telefono) {
  try {
    const [r] = await poolRef.query(
      `SELECT 1 FROM bot_campania_log
       WHERE campania = ? AND telefono = ?
         AND fecha > DATE_SUB(NOW(), INTERVAL 45 DAY)
       LIMIT 1`,
      [campania, String(telefono || '')]
    );
    return !!(r && r.length);
  } catch (e) {
    return false;
  }
}

async function registrarEnvio(campania, telefono) {
  try {
    await poolRef.query(
      'INSERT INTO bot_campania_log (campania, telefono) VALUES (?, ?)',
      [campania, String(telefono || '')]
    );
  } catch (e) {}
}

function nombreCorto(nombres) {
  const n = String(nombres || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'estimado cliente';
  if (n.length <= 38) return n.replace(/,\s*C\.?A\.?$/i, '').trim() || n;
  // Empresa larga: conservar hasta 4 palabras o 44 caracteres.
  const palabras = n.split(' ');
  const corto = [];
  let len = 0;
  for (const p of palabras) {
    if (len + p.length + 1 > 44 || corto.length >= 4) break;
    corto.push(p);
    len += p.length + 1;
  }
  const res = corto.join(' ').replace(/[,]+$/, '').trim();
  return res || n.slice(0, 44);
}

function fechaCorta(f) {
  try {
    return new Date(f).toLocaleDateString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) { return String(f || ''); }
}

function textoFria(c, plantilla) {
  if (plantilla) {
    return plantilla
      .replace(/{nombre}/g, nombreCorto(c.nombres))
      .replace(/{fecha}/g, fechaCorta(c.ultima_compra))
      .replace(/{vendedor}/g, String(c.vendedor || 'su asesor'));
  }
  return `¡Buenos días, *${nombreCorto(c.nombres)}*! 👋

Le escribe *ONE4CARS*. Hace tiempo que no tenemos el gusto de atenderle (su última compra fue el ${fechaCorta(c.ultima_compra)}) y queríamos saludarle.

Le avisamos que seguimos trabajando para su tienda:
• Precios mayoristas vigentes
• Nuevas llegadas de repuestos
• Atención personalizada y despacho a su zona

¿Hay algo en lo que podamos ayudarle hoy? Responda a este mensaje y un asesor le atenderá de inmediato.

— Equipo ONE4CARS`;
}

async function enviarFria({ dias = 60, limite = 20, soloSimular = false, plantilla = null }) {
  const clientes = await clientesFrios(dias, 200);
  const seleccion = [];
  const omitidos = [];
  for (const c of clientes) {
    if (seleccion.length >= Number(limite)) break;
    const tel = String(c.celular || c.telefono || '').trim();
    if (!tel) continue;
    if (await yaEnviado('fria', tel)) { omitidos.push(c.nombres); continue; }
    seleccion.push({ ...c, tel });
  }

  const resultado = { campania: 'fria', dias, totalFrios: clientes.length, enviados: 0, omitidosPorDuplicado: omitidos.length, simulado: !!soloSimular, mensajes: [] };

  for (const c of seleccion) {
    const texto = textoFria(c, plantilla);
    resultado.mensajes.push({ telefono: c.tel, nombre: c.nombres, texto });
    if (soloSimular) continue;
    const jid = formatRef(c.tel);
    if (!jid) continue;
    try {
      await enviarRef(jid, texto);
      await registrarEnvio('fria', c.tel);
      resultado.enviados += 1;
      await new Promise(r => setTimeout(r, 4000)); // ritmo humano
    } catch (e) {
      resultado.mensajes[resultado.mensajes.length - 1].error = e.message;
    }
  }
  return resultado;
}

async function enviarLeads({ horas = 24, limite = 20, soloSimular = false }) {
  const [rows] = await poolRef.query(
    `SELECT id, telefono, nombre, mensaje, fecha FROM bot_leads
     WHERE estado = 'nuevo' AND fecha < DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY fecha DESC LIMIT ?`,
    [Number(horas) || 24, Number(limite) || 20]
  );
  const resultado = { campania: 'leads', horas, encontrados: (rows || []).length, enviados: 0, simulado: !!soloSimular, mensajes: [] };

  for (const l of (rows || [])) {
    const tel = String(l.telefono || '').trim();
    const nombre = nombreCorto(l.nombre);
    const texto = `¡Hola, *${nombre}*! 👋

Le escribe *ONE4CARS*. Vimos que se interesó en nuestros productos y queríamos acompañarle en el siguiente paso.

Para abrir su cuenta de mayorista solo necesita enviar:
1. Copia del RIF de la empresa.
2. Foto del local.
3. Dirección fiscal.
4. Nombre del dueño.

Recuerde que la compra mínima es de *USD 100*. Un asesor validará sus datos y le activará la cuenta hoy mismo.

¿Desea que le explique el proceso?`;
    resultado.mensajes.push({ telefono: tel, nombre: l.nombre, texto });
    if (soloSimular) continue;
    const jid = formatRef(tel);
    if (!jid) continue;
    try {
      await enviarRef(jid, texto);
      await poolRef.query("UPDATE bot_leads SET estado = 'seguimiento' WHERE id = ?", [l.id]);
      resultado.enviados += 1;
      await new Promise(r => setTimeout(r, 4000));
    } catch (e) {
      resultado.mensajes[resultado.mensajes.length - 1].error = e.message;
    }
  }
  return resultado;
}

async function resumenDiario() {
  const q = async (sql, params = []) => {
    const [r] = await poolRef.query(sql, params);
    return r && r[0] ? r[0] : {};
  };
  const hoy = await q(`SELECT COUNT(*) n, COALESCE(SUM(total_desc),0) monto
                       FROM tab_facturas WHERE fecha_reg = CURDATE() AND anulado = 'no'`);
  const cobrado = await q(`SELECT COUNT(*) n, COALESCE(SUM(abono_factura),0) monto
                           FROM tab_facturas WHERE fecha_reg = CURDATE() AND anulado = 'no' AND abono_factura > 0`);
  const nuevos = await q(`SELECT COUNT(*) n FROM tab_clientes WHERE fecha_reg = CURDATE()`);
  const leads = await q(`SELECT COUNT(*) n FROM bot_leads WHERE fecha >= CURDATE()`);
  const chats = await q(`SELECT COUNT(DISTINCT telefono) n FROM historial_chat WHERE fecha >= CURDATE() AND rol = 'user'`);
  const frios = await q(`SELECT COUNT(*) n FROM (
      SELECT c.id_cliente FROM tab_clientes c
      JOIN tab_facturas f ON f.id_cliente = c.id_cliente AND f.anulado = 'no'
      WHERE c.activo = 'SI' AND (c.celular <> '' OR c.telefono <> '')
      GROUP BY c.id_cliente
      HAVING MAX(f.fecha_reg) < DATE_SUB(CURDATE(), INTERVAL 60 DAY)
  ) x`);
  const mora = await q(`SELECT COUNT(*) n, COALESCE(SUM(total - abono_factura),0) monto
                        FROM tab_facturas
                        WHERE anulado = 'no' AND pagada = 'NO'
                          AND fecha_reg < DATE_SUB(CURDATE(), INTERVAL 30 DAY)`);

  const monto = Number(hoy.monto || 0);
  const montoCobrado = Number(cobrado.monto || 0);
  const moraMonto = Number(mora.monto || 0);

  return `📊 *RESUMEN DIARIO ONE4CARS*
${new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}

*Ventas de hoy*
• Facturas: *${Number(hoy.n || 0)}*
• Monto: *$${monto.toFixed(2)}*
• Abonos recibidos: *$${montoCobrado.toFixed(2)}* (${Number(cobrado.n || 0)} facturas)

*Clientes*
• Nuevos hoy: *${Number(nuevos.n || 0)}*
• Chats atendidos hoy: *${Number(chats.n || 0)}*
• Leads nuevos: *${Number(leads.n || 0)}*
• Clientes fríos (60+ días sin comprar): *${Number(frios.n || 0)}*

*Cartera*
• Facturas vencidas 30+ días: *${Number(mora.n || 0)}* por *$${moraMonto.toFixed(2)}*

Para recuperar clientes fríos escriba: *campana fria 60 20*
Para seguimiento a interesados: *campania leads*`;
}

module.exports = { init, clientesFrios, enviarFria, enviarLeads, resumenDiario };
