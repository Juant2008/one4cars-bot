const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

// Obtener lista de vendedores para el filtro
async function obtenerVendedores() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != '' ORDER BY vendedor ASC");
    await conn.end();
    return rows;
}

// Obtener lista de zonas para el filtro
async function obtenerZonas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' ORDER BY zona ASC");
    await conn.end();
    return rows;
}

// Obtener clientes filtrados para el panel de marketing
async function obtenerClientesMarketing(filtros) {
    const conn = await mysql.createConnection(dbConfig);
    let sql = "SELECT id_cliente, nombres, celular, vendedor, zona, usuario, clave FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
    const params = [];

    if (filtros.vendedor) {
        sql += " AND vendedor = ?";
        params.push(filtros.vendedor);
    }
    if (filtros.zona) {
        sql += " AND zona = ?";
        params.push(filtros.zona);
    }

    sql += " ORDER BY nombres ASC";
    const [rows] = await conn.execute(sql, params);
    await conn.end();
    return rows;
}

// Generar el HTML del Panel de Marketing
async function generarHTMLMarketing(clientes, vendedores, zonas, header, q) {
    return `<!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <title>Marketing ONE4CARS</title>
        <style>
            .card-marketing { border-radius: 15px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .st-sticky { position: sticky; top: 20px; }
        </style>
    </head>
    <body class="bg-light">
        ${header}
        <div class="container-fluid px-4">
            <div class="row">
                <div class="col-md-4">
                    <div class="card card-marketing p-4 st-sticky">
                        <h4>🎯 Campañas Masivas</h4>
                        <hr>
                        <form method="GET" action="/marketing-panel" class="mb-4">
                            <label class="form-label small fw-bold">Filtrar por Vendedor:</label>
                            <select name="vendedor" class="form-select mb-3">
                                <option value="">Todos los vendedores</option>
                                ${vendedores.map(v => `<option value="${v.vendedor}" ${q.vendedor === v.vendedor ? 'selected' : ''}>${v.vendedor}</option>`).join('')}
                            </select>

                            <label class="form-label small fw-bold">Filtrar por Zona:</label>
                            <select name="zona" class="form-select mb-3">
                                <option value="">Todas las zonas</option>
                                ${zonas.map(z => `<option value="${z.zona}" ${q.zona === z.zona ? 'selected' : ''}>${z.zona}</option>`).join('')}
                            </select>
                            <button type="submit" class="btn btn-dark w-100">Aplicar Filtros</button>
                        </form>

                        <div class="mb-3">
                            <label class="form-label small fw-bold">Acción de Marketing:</label>
                            <select id="tipoMarketing" class="form-select" onchange="toggleInputs()">
                                <option value="precios">Enviar Lista de Precios (PDF)</option>
                                <option value="bienvenida">Mensaje de Bienvenida (Portal)</option>
                                <option value="satisfaccion">Consulta de Satisfacción</option>
                                <option value="personalizado">Mensaje Personalizado</option>
                            </select>
                        </div>

                        <div id="customMsgDiv" class="mb-3 d-none">
                            <label class="form-label small fw-bold">Mensaje:</label>
                            <textarea id="msgPersonalizado" class="form-control" rows="4" placeholder="Escribe aquí tu mensaje..."></textarea>
                        </div>

                        <button onclick="enviarCampana()" class="btn btn-success btn-lg w-100 shadow">🚀 Iniciar Envío Masivo</button>
                        <div id="status" class="mt-3 small text-center fw-bold"></div>
                    </div>
                </div>

                <div class="col-md-8">
                    <div class="card card-marketing p-4">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <h5>Seleccionados: ${clientes.length} clientes</h5>
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="selectAll" checked onclick="toggleAll()">
                                <label class="form-check-label">Seleccionar Todos</label>
                            </div>
                        </div>
                        <div class="table-responsive">
                            <table class="table table-hover align-middle">
                                <thead class="table-light">
                                    <tr>
                                        <th>Select</th>
                                        <th>Cliente</th>
                                        <th>Zona</th>
                                        <th>Vendedor</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${clientes.map(c => `
                                    <tr>
                                        <td><input type="checkbox" class="client-check" value="${c.id_cliente}" checked></td>
                                        <td><strong>${c.nombres}</strong><br><span class="text-muted small">${c.celular}</span></td>
                                        <td><span class="badge bg-info text-dark">${c.zona}</span></td>
                                        <td>${c.vendedor}</td>
                                    </tr>`).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            function toggleInputs() {
                const tipo = document.getElementById('tipoMarketing').value;
                document.getElementById('customMsgDiv').classList.toggle('d-none', tipo !== 'personalizado');
            }

            function toggleAll() {
                const check = document.getElementById('selectAll').checked;
                document.querySelectorAll('.client-check').forEach(c => c.checked = check);
            }

            async function enviarCampana() {
                const selected = Array.from(document.querySelectorAll('.client-check:checked')).map(c => c.value);
                if (selected.length === 0) return alert("Selecciona al menos un cliente.");

                const tipo = document.getElementById('tipoMarketing').value;
                const status = document.getElementById('status');
                
                let data = { 
                    clientes: selected,
                    tipo: tipo === 'precios' ? 'precios' : 'promo',
                    subtipo: tipo,
                    mensaje: document.getElementById('msgPersonalizado').value
                };

                status.innerHTML = "⏳ Enviando... Por favor no cierre la ventana.";
                
                try {
                    const response = await fetch('/enviar-marketing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                    if (response.ok) {
                        status.innerHTML = "✅ Envío completado con éxito.";
                        alert("Campaña finalizada.");
                    } else {
                        status.innerHTML = "❌ Error en el envío.";
                    }
                } catch (e) {
                    status.innerHTML = "❌ Error de conexión.";
                }
            }
        </script>
    </body>
    </html>`;
}

module.exports = { 
    obtenerVendedores, 
    obtenerZonas, 
    obtenerClientesMarketing, 
    generarHTMLMarketing 
};
