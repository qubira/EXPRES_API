const jwt = require('jsonwebtoken');
const { sesionActiva } = require('../utils/sesiones');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambiar';

function firmarToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function requireRole(role) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role !== role) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a este recurso' });
      }
      if (!(await sesionActiva(payload.sid))) {
        return res.status(401).json({ error: 'Tu sesión fue cerrada desde otro dispositivo' });
      }
      req.auth = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token invalido o expirado' });
    }
  };
}

function requireAnyRole(roles) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (!roles.includes(payload.role)) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a este recurso' });
      }
      if (!(await sesionActiva(payload.sid))) {
        return res.status(401).json({ error: 'Tu sesión fue cerrada desde otro dispositivo' });
      }
      req.auth = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token invalido o expirado' });
    }
  };
}

module.exports = { firmarToken, requireRole, requireAnyRole, JWT_SECRET };
