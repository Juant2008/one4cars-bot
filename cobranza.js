const mysql = require('mysql2/promise');

// ===== CONFIGURACIÓN DE DB =====
const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function db() { 
    return await mysql.createConnection(dbConfig); 
}

// 1. Obtener lista de vendedores para el filtro dinámico
async function obtenerVendedores() {
    const conn = await db();
    const [rows] = await conn.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != '' ORDER BY vendedor ASC");
    await conn.end();
    return rows;
}

// 2. Obtener lista de zonas para el filtro dinámico
async function obtenerZonas() {
    const conn = await db();
    const [rows] = await conn.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' ORDER BY zona ASC");
    await conn.end();
    return rows;
}

// 3. Obtener clientes que tienen facturas pendientes (Deudores)
async function obtenerListaDeudores(filtros) {
    const conn = await db();
    
    // SQL optimizado: Agrupa por cliente para evitar repetir filas por factura
    let sql = `
        SELECT 
            c.id_cliente, 
            c.nombres, 
            c.celular, 
            c.vendedor, 
            c.zona, 
            SUM((f.total - f.abono_factura) / (f.porcentaje || 1)) as saldo_total,
            COUNT(f.id_factura) as cantidad_facturas
        FROM tab_clientes c
        JOIN tab_facturas f ON c.id_cliente = f.id_cliente
        WHERE f.pagada = 'NO' AND f.anulado = 'no'
    `;
    
    const params = [];
    
    // Filtros dinámicos
    if (filtros.vendedor) {
        sql += " AND c.vendedor = ?";
        params.push(filtros.vendedor);
    }
    if (filtros.zona) {
        sql += " AND c.zona = ?";
        params.push(filtros.zona);
    }

    sql += " GROUP BY c.id_cliente ORDER BY saldo_total DESC";
    
    const [rows] = await conn.execute(sql, params);
    await conn.end();
    return rows;
}

// 4. Generar el HTML del Panel de Cobranza (Ancho Completo)
async function generarHTML(vendedores, zonas, deudores, header, q) {
    return `<!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <title>Cobranza ONE4CARS</title>
        <style>
            body { background-color: #f8f9fa; }
            .card-custom { border-radius: 15px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
            .table-full { width: 100% !important; }
            .btn-send { transition: all 0.3s; }
            .btn-send:hover { transform: scale(1.02); }
        </style>
    </head>
    <body>
        ${header}
        
        <div class="container-fluid px-4">
            
            <!-- SECCIÓN DE FILTROS (ARRIBA PARA DAR ESPACIO A LA TABLA) -->
            <div class="card card-custom p-4 mb-4">
                <div class="row align-items-end">
                    <div class="col-md-4">
                        <h4 class="mb-0">💰 Gestión de Cobros</h4>
                        <p class="text-muted small">Filtre clientes y envíe recordatorios masivos.</p>
                    </div>
                    <div class="col-md-3">
                        <form method="GET" action="/cobranza" class="row g-2">
                            <div class="col-6">
                                <label class="form-label small fw-bold">Vendedor:</label>
                                <select name="vendedor" class="form-select">
                                    <option value="">Todos</option>
                                    ${vendedores.map(v => `<option value="${v.vendedor}" ${q.vendedor === v.vendedor ? 'selected' : ''}>${v.vendedor}</option>`).join('')}
                                </select>
                            </div>
                            <div class="col-6">
                                <label class="form-label small fw-bold">Zona:</label>
                                <select name="zona" class="form-select">
                                    <option value="">Todas</option>
                                    ${zonas.map(z => `<option value="${z.zona}" ${q.zona === z.zona ? 'selected' : ''}>${z.zona}</option>`).join('')}
                                </select>
                            </div>
                            <div class="col-12 mt-3">
                                <button type="submit" class="btn btn-dark w-100">Aplicar Filtros</button>
                            </div>
                        </form>
                    </div>
                    <div class="col-md-5 text-end">
                        <button onclick="enviarCobranzaMasiva()" class="btn btn-danger btn-lg px-5 btn-send shadow">🚀 Enviar WhatsApp a Seleccionados</button>
                        <div id="status" class="mt-2 small fw-bold"></div>
                    </div>
                </div>
            </div>

            <!-- TABLA A LO ANCHO (SIN SCROLL) -->
            <div class="card card-custom p-4">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5>Clientes con Deuda Pendiente (${deudores.length})</h5>
                    <div class="form-check">
                        <input class="form-check-input" type="checkbox" id="selectAll" checked onclick="toggleAll()">
                        <label class="form-check-label small">Seleccionar Todos</label>
                    </div>
                </div>
                
                <div class="table-responsive">
                    <table class="table table-hover align-middle table-full">
                        <thead class="table-light">
                            <tr>
                                <th style="width: 40px;">Sel</th>
                                <th>Cliente</th>
                                <th>Celular</th>
                                <th>Zona</th>
                                <th>Vendedor</th>
                                <th class="text-center">Facturas</th>
                                <th class="text-end">Deuda Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${deudores.length > 0 ? deudores.map(d => `
                            <tr>
                                <td><input type="checkbox" class="client-check" value="${d.id_cliente}" checked></td>
                                <td><strong>${d.nombres}</strong></td>
                                <td>${d.celular}</td>
                                <td><span class="badge bg-secondary">${d.zona}</span></td>
                                <td>${d.vendedor}</td>
                                <td class="text-center">${d.cantidad_facturas}</td>
                                <td class="text-end text-danger fw-bold">$${parseFloat(d.saldo_total).toFixed(2)}</td>
                            </tr>`).join('') : `<tr><td colspan="7" class="text-center text-muted">No hay deudores con los filtros seleccionados.</td></tr>`}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            function toggleAll() {
                const check = document.getElementById('selectAll').checked;
                document.querySelectorAll('.client-check').forEach(c => c.checked = check);
            }

            async function enviarCobranzaMasiva() {
                const selected = Array.from(document.querySelectorAll('.client-check:checked')).map(c => c.value);
                if (selected.length === 0) return alert("Selecciona al menos un cliente.");

                const status = document.getElementById('status');
                status.className = "mt-2 small fw-bold text-primary";
                status.innerHTML = "⏳ Enviando recordatorios... Por favor espere.";
                
                try {
                    const response = await fetch('/enviar-cobranza', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ facturas: selected })
                    });
                    
                    if (response.ok) {
                        status.className = "mt-2 small fw-bold text-success";
                        status.innerHTML = "✅ ¡Mensajes enviados con éxito!";
                        alert("Los recordatorios han sido enviados a través del Bot.");
                    } else {
                        status.className = "mt-2 small fw-bold text-danger";
                        status.innerHTML = "❌ Error al procesar el envío.";
                    }
                } catch (e) {
                    status.className = "mt-2 small fw-bold text-danger";
                    status.innerHTML = "❌ Error de conexión con el servidor.";
                }
            }
        </script>
    </body>
    </html>`;
}

module.exports = { 
    obtenerVendedores, 
    obtenerZonas, 
    obtenerListaDeudores, 
    generarHTML 
};
