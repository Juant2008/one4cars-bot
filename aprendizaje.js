/**
 * Aprendizaje del bot: guarda preguntas fallidas y respuestas enseñadas
 * por el administrador, para responder sin IA la próxima vez.
 */
let poolRef = null;

function init(pool) {
    poolRef = pool;
}

function norm(s) {
    return String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9ñ\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function initTablas() {
    try {
        await poolRef.query(`CREATE TABLE IF NOT EXISTS bot_aprendizaje (
            id INT AUTO_INCREMENT PRIMARY KEY,
            patron VARCHAR(255) NOT NULL,
            patron_norm VARCHAR(255) NOT NULL,
            respuesta TEXT NOT NULL,
            autor VARCHAR(100) NULL,
            veces INT NOT NULL DEFAULT 0,
            activo TINYINT NOT NULL DEFAULT 1,
            creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_patron (patron_norm),
            INDEX idx_activo (activo)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        await poolRef.query(`CREATE TABLE IF NOT EXISTS bot_dudas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            telefono VARCHAR(100) NULL,
            pregunta TEXT NOT NULL,
            motivo VARCHAR(60) NULL,
            atendida TINYINT NOT NULL DEFAULT 0,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_atendida (atendida, fecha)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
    } catch (e) {
        console.log('[APRENDER] Error creando tablas:', e.message);
    }
}

const STOP = new Set(['el','la','los','las','de','del','que','cual','cuales','es','son','me','mi','por','favor','para','un','una','unos','unas','y','o','en','con','al','se','le','les','lo','su','sus','como','cuando','donde','cuanto','cuanta','dice','dime','dame','quiero','necesito','saber','porfa','usted','ustedes','yo','tu','te','nos','fue','ser','esta','este','hay','tiene','tienen']);

function keywords(s) {
    return new Set(
        norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w))
    );
}

function similitud(a, b) {
    const A = keywords(a);
    const B = keywords(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
}

async function buscar(texto) {
    const t = norm(texto);
    if (!t) return null;
    const qk = keywords(texto);
    try {
        const [rows] = await poolRef.query(
            "SELECT id, patron, patron_norm, respuesta, veces FROM bot_aprendizaje WHERE activo = 1"
        );
        if (!rows || !rows.length) return null;
        let mejor = null, mejorScore = 0;
        for (const r of rows) {
            const p = r.patron_norm;
            const pk = keywords(r.patron);
            let score = 0;
            if (t === p) score = 1;
            else if (p.length >= 6 && (t.includes(p) || p.includes(t))) score = 0.9;
            else {
                // Si la pregunta contiene TODAS las palabras clave del patrón.
                let inter = 0;
                for (const w of pk) if (qk.has(w)) inter++;
                if (pk.size && inter === pk.size) score = 0.86;
                else score = similitud(t, p);
            }
            if (score > mejorScore) { mejorScore = score; mejor = r; }
        }
        if (mejor && mejorScore >= 0.65) {
            try { await poolRef.query("UPDATE bot_aprendizaje SET veces = veces + 1 WHERE id = ?", [mejor.id]); } catch (e) {}
            return mejor;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function guardar(patron, respuesta, autor) {
    const pn = norm(patron);
    if (!pn || !respuesta) throw new Error('Patrón y respuesta son obligatorios');
    await poolRef.query(
        `INSERT INTO bot_aprendizaje (patron, patron_norm, respuesta, autor)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE respuesta = VALUES(respuesta), autor = VALUES(autor), activo = 1`,
        [String(patron).slice(0, 250), pn.slice(0, 250), String(respuesta).slice(0, 4000), autor || 'admin']
    );
    const [r] = await poolRef.query("SELECT id FROM bot_aprendizaje WHERE patron_norm = ? LIMIT 1", [pn.slice(0, 250)]);
    return r && r[0] ? r[0].id : null;
}

async function registrarDuda(telefono, pregunta, motivo) {
    try {
        const p = String(pregunta || '').trim();
        if (!p) return;
        const [dup] = await poolRef.query(
            "SELECT id FROM bot_dudas WHERE pregunta = ? AND atendida = 0 AND fecha > DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 1",
            [p.slice(0, 500)]
        );
        if (dup && dup.length) return;
        await poolRef.query(
            "INSERT INTO bot_dudas (telefono, pregunta, motivo) VALUES (?, ?, ?)",
            [String(telefono || '').slice(0, 90), p.slice(0, 500), String(motivo || '').slice(0, 50)]
        );
    } catch (e) {}
}

async function listar(limite = 30) {
    const [rows] = await poolRef.query(
        `SELECT id, patron, respuesta, veces, autor, creado FROM bot_aprendizaje
         WHERE activo = 1 ORDER BY veces DESC, id DESC LIMIT ?`,
        [Number(limite) || 30]
    );
    return rows || [];
}

async function dudas(limite = 15) {
    const [rows] = await poolRef.query(
        `SELECT id, telefono, pregunta, motivo, fecha FROM bot_dudas
         WHERE atendida = 0 ORDER BY fecha DESC LIMIT ?`,
        [Number(limite) || 15]
    );
    return rows || [];
}

async function ensenarDuda(id, respuesta) {
    const [r] = await poolRef.query("SELECT pregunta FROM bot_dudas WHERE id = ? LIMIT 1", [Number(id)]);
    if (!r || !r[0]) return null;
    await guardar(r[0].pregunta, respuesta, 'admin');
    await poolRef.query("UPDATE bot_dudas SET atendida = 1 WHERE id = ?", [Number(id)]);
    return r[0].pregunta;
}

async function olvidar(id) {
    const [r] = await poolRef.query("UPDATE bot_aprendizaje SET activo = 0 WHERE id = ?", [Number(id)]);
    return r ? r.affectedRows : 0;
}

/** Parse "pregunta => respuesta" o "pregunta | respuesta". */
function parsePar(texto) {
    const t = String(texto || '');
    const m = t.split(/\s*(?:=>|->|\|)\s*/);
    if (m.length < 2) return null;
    const patron = m[0].trim();
    const respuesta = m.slice(1).join(' | ').trim();
    if (!patron || !respuesta) return null;
    return { patron, respuesta };
}

module.exports = { init, initTablas, buscar, guardar, registrarDuda, listar, dudas, ensenarDuda, olvidar, parsePar, norm };
