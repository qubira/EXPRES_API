const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- REGISTRO ----------
router.post('/registro', async (req, res) => {
  try {
    const { nombre, email, telefono, password } = req.body;
    if (!nombre || !email || !telefono || !password) {
      return res.status(400).json({ error: 'Nombre, correo, teléfono y contraseña son obligatorios' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Ingresa un correo electrónico válido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const { rows: existente } = await db.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existente[0]) {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese correo electrónico' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO usuarios (nombre, email, telefono, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, nombre`,
      [nombre, email, telefono, hash]
    );
    const usuario = rows[0];
    const token = firmarToken({ role: 'cliente', id: usuario.id, nombre: usuario.nombre });
    res.status(201).json({ token, nombre: usuario.nombre });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese correo electrónico' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    const usuario = rows[0];
    if (!usuario || !usuario.password_hash || !(await bcrypt.compare(password || '', usuario.password_hash))) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }
    const token = firmarToken({ role: 'cliente', id: usuario.id, nombre: usuario.nombre });
    res.json({ token, nombre: usuario.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

router.use(requireRole('cliente'));

// ---------- MI PERFIL ----------
router.get('/perfil', async (req, res) => {
  const { rows } = await db.query('SELECT id, nombre, email, telefono FROM usuarios WHERE id = $1', [req.auth.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(rows[0]);
});

// ---------- ACTUALIZAR DATOS ----------
router.put('/perfil', async (req, res) => {
  try {
    const { nombre, email, telefono } = req.body;
    if (!nombre || !email || !telefono) {
      return res.status(400).json({ error: 'Nombre, correo y teléfono son obligatorios' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Ingresa un correo electrónico válido' });
    }

    const { rows } = await db.query(
      `UPDATE usuarios SET nombre = $1, email = $2, telefono = $3 WHERE id = $4 RETURNING id, nombre, email, telefono`,
      [nombre, email, telefono, req.auth.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar tus datos' });
  }
});

// ---------- CAMBIAR CONTRASEÑA ----------
router.post('/perfil/password', async (req, res) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva) {
      return res.status(400).json({ error: 'Ingresa tu contraseña actual y la nueva' });
    }
    if (password_nueva.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const { rows } = await db.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.auth.id]);
    const usuario = rows[0];
    if (!usuario || !(await bcrypt.compare(password_actual, usuario.password_hash))) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }

    const hash = await bcrypt.hash(password_nueva, 10);
    await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, req.auth.id]);
    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// ---------- ELIMINAR CUENTA ----------
router.delete('/perfil', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { password } = req.body;
    const { rows } = await db.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.auth.id]);
    const usuario = rows[0];
    if (!usuario || !(await bcrypt.compare(password || '', usuario.password_hash))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    await client.query('BEGIN');
    // Los pedidos ya realizados se conservan como historial del negocio,
    // solo se desvinculan de la cuenta que se elimina.
    await client.query('UPDATE pedidos SET usuario_id = NULL WHERE usuario_id = $1', [req.auth.id]);
    await client.query('DELETE FROM usuarios WHERE id = $1', [req.auth.id]);
    await client.query('COMMIT');

    res.json({ mensaje: 'Cuenta eliminada' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar la cuenta' });
  } finally {
    client.release();
  }
});

// ---------- MIS PEDIDOS ----------
router.get('/pedidos', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, estado, monto_total, zona_entrega, pin_entrega, created_at, entregado_at
       FROM pedidos WHERE usuario_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.auth.id]
    );
    const pedidos = rows.map((p) => {
      const pinVisible = ['pagado', 'preparando', 'listo_recoger', 'recogido'].includes(p.estado);
      return { ...p, pin_entrega: pinVisible ? p.pin_entrega : null };
    });
    res.json(pedidos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tus pedidos' });
  }
});

module.exports = router;
