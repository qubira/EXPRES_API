const db = require('../db');
const { obtenerIp } = require('./auditoria');

// Cada login crea una fila aqui; el id queda embebido en el JWT (claim "sid").
// Permite listar "donde estoy conectado" y cerrar sesiones desde otro dispositivo.
async function crearSesion({ rol, referenciaId, req }) {
  const { rows } = await db.query(
    `INSERT INTO sesiones (rol, referencia_id, ip, user_agent) VALUES ($1,$2,$3,$4) RETURNING id`,
    [rol, referenciaId, obtenerIp(req), req.headers['user-agent'] || null]
  );
  return rows[0].id;
}

async function sesionActiva(sid) {
  if (!sid) return true; // tokens emitidos antes de este cambio no tienen sid: no se invalidan
  const { rows } = await db.query('SELECT activa FROM sesiones WHERE id = $1', [sid]);
  return !!rows[0] && rows[0].activa;
}

module.exports = { crearSesion, sesionActiva };
