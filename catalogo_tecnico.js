/**
 * Catálogo técnico del bot maestro (juant200_venezon).
 * Usa las tablas:
 *   tab_maestro_vehiculos, tab_master_piezas, tab_calce_pieza_vehiculo,
 *   tab_equivalencias_oem, tab_aplicacion_vehiculo_producto
 * y los índices propios:
 *   bot_fit_producto, bot_oem_producto
 */

let poolRef = null;
let vehiculosCache = null;
let tiposCache = null;

function init(pool) { poolRef = pool; }

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contiene(texto, palabra) {
  if (!palabra || palabra.length < 3) return false;
  if (palabra.length >= 5) return texto.includes(palabra);
  const esc = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(texto);
}

async function cargarVehiculos() {
  if (vehiculosCache) return vehiculosCache;
  const [rows] = await poolRef.query(
    'SELECT id_vehiculo, marca, modelo, anio_desde, anio_hasta FROM tab_maestro_vehiculos ORDER BY marca, modelo'
  );
  vehiculosCache = rows || [];
  return vehiculosCache;
}

async function cargarTipos() {
  if (tiposCache) return tiposCache;
  const [rows] = await poolRef.query(
    "SELECT DISTINCT tipo FROM tab_productos WHERE activo = 'si' AND tipo <> '' ORDER BY tipo"
  );
  tiposCache = (rows || []).map(r => String(r.tipo || '').trim()).filter(Boolean);
  return tiposCache;
}

// Alias de jerga / nombres comerciales → patrones contra tab_productos.tipo
const ALIAS_PIEZAS = {
  'bujia': ['BUJIA'], 'bujias': ['BUJIA'],
  'meseta': ['MESETA'], 'mesetas': ['MESETA'],
  'cubo': ['CUBO'], 'cubos': ['CUBO'],
  'bobina': ['BOBINA'], 'bobinas': ['BOBINA'],
  'sensor abs': ['SENSORABS'], 'sensores abs': ['SENSORABS'], 'sensor de abs': ['SENSORABS'], 'sensores de abs': ['SENSORABS'], 'abs': ['SENSORABS'],
  'punta': ['PUNTA'], 'puntas': ['PUNTA'], 'tripode': ['TRIPOIDE'], 'tripoide': ['TRIPOIDE'],
  'inyector': ['INYECTOR'], 'inyectores': ['INYECTOR'],
  'estopera': ['ESTOPERA'], 'estoperas': ['ESTOPERA'],
  'terminal': ['TERMINAL'], 'terminales': ['TERMINAL'],
  'correa': ['CORREA'], 'correas': ['CORREA'],
  'rolinera': ['ROLINERA'], 'rolineras': ['ROLINERA'], 'rodamiento': ['ROLINERA'], 'rodamientos': ['ROLINERA'],
  'valvula iac': ['VALVULAIAC'], 'iac': ['VALVULAIAC'],
  'valvula aceite': ['VALVULAACEITE'],
  'sensor oxigeno': ['SENSOROXIGENO'], 'oxigeno': ['SENSOROXIGENO'],
  'cable bujia': ['CABLEBUJIA'], 'cables bujia': ['CABLEBUJIA'],
  'switch': ['SWITCH'], 'swich': ['SWITCH'],
  'filtro': ['FILTRO'], 'filtros': ['FILTRO'],
  'pastilla': ['PASTILLA'], 'pastillas': ['PASTILLA'], 'balata': ['PASTILLA'], 'balatas': ['PASTILLA'],
  'disco': ['DISCO'], 'discos': ['DISCO'],
  'bomba': ['BOMBA'], 'bombas': ['BOMBA'],
  'amortiguador': ['AMORTIGUADOR'], 'amortiguadores': ['AMORTIGUADOR'],
  'embrague': ['EMBRAGUE'], 'cloche': ['EMBRAGUE'], 'croche': ['EMBRAGUE'],
  'rotula': ['ROTULA', 'MUNON'], 'rotulas': ['ROTULA', 'MUNON'], 'munon': ['MUNON', 'ROTULA'], 'munones': ['MUNON', 'ROTULA'],
  'soporte': ['SOPORTE'], 'soportes': ['SOPORTE'],
  'buje': ['BUJE'], 'bujes': ['BUJE'],
  'cruz': ['CRUZ', 'CRUCETA'], 'cruceta': ['CRUCETA', 'CRUZ'], 'crucetas': ['CRUCETA', 'CRUZ'],
  'regulador': ['REGULADOR'], 'reguladores': ['REGULADOR'],
  'sensor': ['SENSOR'], 'sensores': ['SENSOR'],
  'bomba gasolina': ['BOMBA'], 'bomba agua': ['BOMBA'], 'bomba aceite': ['BOMBA'],
  'tensor': ['TENSOR'], 'tensores': ['TENSOR'],
  'polea': ['POLEA'], 'poleas': ['POLEA'],
  'piston': ['PISTON'], 'pistones': ['PISTON'],
  'valvula': ['VALVULA'], 'valvulas': ['VALVULA']
};

async function cargarAliasTipos() {
  const tipos = await cargarTipos();
  const all = { ...ALIAS_PIEZAS };
  for (const t of tipos) {
    const k = norm(t);
    if (k && !all[k]) all[k] = [t];
  }
  return all;
}

async function extraerVehiculo(texto) {
  const t = norm(texto);
  const vehiculos = await cargarVehiculos();
  const anios = t.match(/\b(19|20)\d{2}\b/g) || [];
  const anio = anios.length ? parseInt(anios[0], 10) : null;
  const anioHasta = anios.length > 1 ? parseInt(anios[anios.length - 1], 10) : null;

  const marcas = [...new Set(vehiculos.map(v => norm(v.marca)).filter(Boolean))].sort((a, b) => b.length - a.length);
  let marca = '';
  for (const m of marcas) {
    if (contiene(t, m)) { marca = m; break; }
  }

  const modelos = [...new Set(vehiculos.map(v => norm(v.modelo)).filter(Boolean))].sort((a, b) => b.length - a.length);
  let modelo = '';
  for (const m of modelos) {
    if (!contiene(t, m)) continue;
    if (marca) {
      const ok = vehiculos.some(v => norm(v.marca) === marca && norm(v.modelo) === m);
      if (!ok) continue;
    }
    modelo = m;
    break;
  }

  let ids = [];
  if (!marca && modelo) {
    const vv = vehiculos.find(v => norm(v.modelo) === modelo);
    if (vv) marca = norm(vv.marca);
  }
  if (marca || modelo) {
    ids = vehiculos.filter(v => {
      if (marca && norm(v.marca) !== marca) return false;
      if (modelo && norm(v.modelo) !== modelo) return false;
      if (anio && Number(v.anio_desde) > anio) return false;
      if (anio && Number(v.anio_hasta) < anio) return false;
      if (!anio && anioHasta && Number(v.anio_hasta) < anioHasta) return false;
      return true;
    }).map(v => Number(v.id_vehiculo));
  }
  return { marca, modelo, anio, anioHasta, ids };
}

async function extraerPieza(texto) {
  const t = norm(texto);
  const alias = await cargarAliasTipos();
  const claves = Object.keys(alias).sort((a, b) => b.length - a.length);
  for (const k of claves) {
    if (contiene(t, k)) {
      return { term: k, tipos: [...new Set(alias[k])] };
    }
  }
  return { term: '', tipos: [] };
}

async function buscarProductosPorTipo(tipos, vehiculoIds, marca, modelo) {
  if (!tipos || !tipos.length) return [];
  const condTipos = tipos.map(() => 'f.tipo_pieza LIKE ?').join(' OR ');
  const paramsTipos = tipos.map(t => `${t}%`);
  let whereVeh = '';
  const paramsVeh = [];
  if (vehiculoIds && vehiculoIds.length) {
    whereVeh = `f.id_vehiculo IN (${vehiculoIds.map(() => '?').join(',')})`;
    paramsVeh.push(...vehiculoIds);
  } else if (marca) {
    whereVeh = 'f.marca = ?';
    paramsVeh.push(marca);
    if (modelo) { whereVeh += ' AND f.modelo = ?'; paramsVeh.push(modelo); }
  } else {
    return [];
  }
  const sql = `SELECT p.producto, p.descripcion, p.tipo, p.precio_minimo,
                      (COALESCE(p.cantidad_existencia,0) + COALESCE(p.cantidad_existencia_almacen,0)) AS stock_total,
                      p.cantidad_fabricando,
                      f.marca, f.modelo, f.anio_desde, f.anio_hasta, f.confianza
               FROM bot_fit_producto f
               JOIN tab_productos p ON p.id_producto = f.id_producto
               WHERE ${whereVeh} AND p.activo = 'si'
                 AND (${condTipos})
               ORDER BY f.confianza DESC,
                        (COALESCE(p.cantidad_existencia,0) + COALESCE(p.cantidad_existencia_almacen,0)) DESC
               LIMIT 20`;
  const [rows] = await poolRef.query(sql, [...paramsVeh, ...paramsTipos]);
  const vistos = new Set();
  return (rows || []).filter(r => {
    const k = String(r.producto || '');
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, 8);
}

async function buscarTiposDeVehiculo(vehiculoIds) {
  if (!vehiculoIds || !vehiculoIds.length) return [];
  const sql = `SELECT tipo_pieza, COUNT(*) AS n
               FROM bot_fit_producto
               WHERE id_vehiculo IN (${vehiculoIds.map(() => '?').join(',')})
               GROUP BY tipo_pieza
               ORDER BY n DESC LIMIT 15`;
  const [rows] = await poolRef.query(sql, vehiculoIds);
  return (rows || []).map(r => r.tipo_pieza).filter(Boolean);
}

async function buscarProductosPorTipoSolo(tipos) {
  if (!tipos || !tipos.length) return [];
  const conds = tipos.map(() => 'tipo LIKE ?').join(' OR ');
  const params = tipos.map(t => `${t}%`);
  const [rows] = await poolRef.query(
    `SELECT producto, descripcion, tipo, precio_minimo,
            (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) AS stock_total,
            cantidad_fabricando
     FROM tab_productos
     WHERE activo = 'si' AND (${conds})
     ORDER BY (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) DESC
     LIMIT 8`,
    params
  );
  return rows || [];
}

async function buscarCompatibles(texto) {
  try {
    const v = await extraerVehiculo(texto);
    const p = await extraerPieza(texto);
    const nombreVeh = [v.marca, v.modelo, v.anio].filter(Boolean).join(' ');

    if (v.ids.length && p.tipos.length) {
      const productos = await buscarProductosPorTipo(p.tipos, v.ids, v.marca, v.modelo);
      if (productos.length) {
        return { ok: true, productos, vehiculo: v, pieza: p, mensaje: `🔧 *Compatibles con ${nombreVeh}*` };
      }
      const alternativos = await buscarProductosPorTipoSolo(p.tipos);
      if (alternativos.length) {
        return {
          ok: false,
          productos: alternativos,
          vehiculo: v,
          pieza: p,
          mensaje: `No tengo un calce exacto registrado para *${nombreVeh}*. Estas son las opciones disponibles de *${p.term}*; un asesor confirma compatibilidad antes de comprar.`
        };
      }
    }
    if (v.ids.length && !p.tipos.length) {
      const tipos = await buscarTiposDeVehiculo(v.ids);
      return { ok: false, vehiculo: v, pieza: p, tipos, mensaje: `Encontré el vehículo *${nombreVeh}*. ¿Qué pieza necesita? Por ejemplo: ${tipos.slice(0, 8).join(', ')}.` };
    }
    if (!v.ids.length && p.tipos.length) {
      const productos = await buscarProductosPorTipoSolo(p.tipos);
      return { ok: false, productos, vehiculo: v, pieza: p, mensaje: 'Para confirmar el calce exacto, indíqueme marca, modelo y año del vehículo.' };
    }
    return null;
  } catch (e) {
    console.log('[CATALOGO] Error compatibilidad:', e.message);
    return null;
  }
}

async function buscarPorOEM(texto) {
  try {
    const s = String(texto || '');
    const m1 = s.match(/\b\d{4,5}[-_ ]\d{3,}\b/g) || [];
    const m2 = s.match(/\b[A-Z]{1,3}\d{4,}\b/gi) || [];
    let codigos = [];
    if (m1.length) {
      for (const c of m1) {
        codigos.push(String(c).toUpperCase());
        codigos.push(String(c).replace(/[-_ ]/g, '').toUpperCase());
      }
    } else if (m2.length) {
      codigos = m2.map(c => String(c).toUpperCase());
    } else {
      const m3 = s.match(/\b[A-Z0-9]{5,}\b/gi) || [];
      codigos = m3.map(c => String(c).toUpperCase()).filter(c => /\d/.test(c));
    }
    codigos = [...new Set(codigos)].filter(c => c.length >= 4).slice(0, 6);
    if (!codigos.length) return null;

    const select = `SELECT p.producto, p.descripcion, p.tipo, p.precio_minimo,
                           (COALESCE(p.cantidad_existencia,0) + COALESCE(p.cantidad_existencia_almacen,0)) AS stock_total,
                           p.cantidad_fabricando, o.codigo_oem
                    FROM bot_oem_producto o
                    JOIN tab_productos p ON p.id_producto = o.id_producto
                    WHERE p.activo = 'si' AND `;
    let rows = [];
    // 1) Exacto por código (con y sin guiones)
    for (const c of codigos) {
      const [r] = await poolRef.query(
        select + `(o.codigo_oem = ? OR REPLACE(o.codigo_oem,'-','') = ?) LIMIT 8`,
        [c, c.replace(/-/g, '')]
      );
      if (r && r.length) { rows = r; break; }
    }
    // 2) Exacto por código de producto / equivalencia
    if (!rows.length) {
      for (const c of codigos) {
        const [r] = await poolRef.query(
          `SELECT producto, descripcion, tipo, precio_minimo,
                  (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) AS stock_total,
                  cantidad_fabricando, ? AS codigo_oem
           FROM tab_productos
           WHERE activo = 'si' AND (producto = ? OR cod_producto_1 = ? OR cod_producto_2 = ? OR equivalencia LIKE ?)
           LIMIT 8`,
          [c, c, c, c, `%${c}%`]
        );
        if (r && r.length) { rows = r; break; }
      }
    }
    // 3) Coincidencia parcial solo con el código completo
    if (!rows.length) {
      for (const c of codigos) {
        const [r] = await poolRef.query(
          select + `(o.codigo_oem LIKE ? OR p.equivalencia LIKE ?) LIMIT 8`,
          [`%${c}%`, `%${c}%`]
        );
        if (r && r.length) { rows = r; break; }
      }
    }
    if (rows && rows.length) return { ok: true, codigos, productos: rows };
    return { ok: false, codigos, productos: [] };
  } catch (e) {
    console.log('[CATALOGO] Error OEM:', e.message);
    return null;
  }
}

module.exports = {
  init,
  extraerVehiculo,
  extraerPieza,
  buscarCompatibles,
  buscarPorOEM,
  buscarTiposDeVehiculo,
  norm
};
