const db = require('../db');

function obtenerIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

// Registra un intento de login (exitoso o fallido) para poder rastrear
// desde que IP/equipo se conecto cada cuenta del equipo (admin/tienda/repartidor).
// Nunca lanza: un fallo al auditar no debe romper el login real.
async function registrarLogin({ rol, referenciaId, nombre, req, exito }) {
  try {
    await db.query(
      `INSERT INTO auditoria (rol, referencia_id, nombre, accion, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [rol, referenciaId || null, nombre || null, exito ? 'login_ok' : 'login_fallido',
        obtenerIp(req), req.headers['user-agent'] || null]
    );
  } catch (err) {
    console.error('Error registrando auditoria:', err.message);
  }
}

module.exports = { registrarLogin, obtenerIp };
