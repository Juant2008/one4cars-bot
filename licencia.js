/**
 * Licencia y control central del bot maestro.
 * - Licencia local en juant200_venezon.bot_licencia (id=1).
 * - Control central opcional: CENTRAL_PING_URL + CENTRAL_TOKEN.
 * - Si no hay fila o la BD falla, el bot queda activo (fail-open) para no
 *   tumbar la operación por un problema de configuración.
 */
const axios = require('axios');

let poolRef = null;
let fallosCentral = 0;
let cache = { ts: 0, activa: true, estado: 'activa', motivo: '', fecha_expiracion: null };

function init(pool) { poolRef = pool; }

function estaActiva() { return cache.activa !== false; }
function estado() { return cache; }

async function verificar(forzar = false) {
  if (!forzar && Date.now() - cache.ts < 5 * 60 * 1000) return cache;

  let activa = true;
  let estadoLic = 'activa';
  let motivo = '';
  let fecha = null;

  try {
    const [rows] = await poolRef.query(
      "SELECT estado, fecha_expiracion, notas FROM bot_licencia WHERE id = 1 LIMIT 1"
    );
    if (rows && rows[0]) {
      estadoLic = String(rows[0].estado || 'activa').toLowerCase();
      fecha = rows[0].fecha_expiracion || null;
      if (estadoLic !== 'activa') {
        activa = false;
        motivo = `estado:${estadoLic}`;
      }
      if (fecha && new Date(fecha) < new Date()) {
        activa = false;
        motivo = 'expirada';
      }
    }
  } catch (e) {
    // Fail-open: si la tabla no existe o falla la BD, no bloquear el bot.
    console.log('[LICENCIA] No se pudo leer bot_licencia:', e.message);
  }

  const url = (process.env.CENTRAL_PING_URL || '').trim();
  if (activa && url) {
    try {
      const token = (process.env.CENTRAL_TOKEN || '').trim();
      const r = await axios.get(url, {
        params: { store: 'ONE4CARS', token },
        timeout: 8000
      });
      if (r.data && r.data.ok === true) {
        fallosCentral = 0;
      } else {
        fallosCentral += 1;
      }
    } catch (e) {
      fallosCentral += 1;
    }
    if (fallosCentral >= 3) {
      activa = false;
      motivo = 'sin_control_central';
    }
  } else if (!url) {
    fallosCentral = 0;
  }

  cache = { ts: Date.now(), activa, estado: estadoLic, motivo, fecha_expiracion: fecha };
  return cache;
}

async function setEstado(nuevoEstado, fechaExpiracion = null) {
  const estadoLimpio = String(nuevoEstado || '').toLowerCase().slice(0, 20);
  if (!['activa', 'inactiva', 'suspendida'].includes(estadoLimpio)) {
    throw new Error('Estado inválido. Use activa, inactiva o suspendida.');
  }
  await poolRef.query(
    "INSERT INTO bot_licencia (id, estado, fecha_expiracion) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE estado = VALUES(estado), fecha_expiracion = VALUES(fecha_expiracion)",
    [estadoLimpio, fechaExpiracion]
  );
  return verificar(true);
}

module.exports = { init, verificar, estaActiva, estado, setEstado };
