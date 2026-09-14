const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- REGISTRO ----------
router.post('/registro', async (req, res) => {
  try {
    const { nombre, telefono, password } = req.body;
    if (!nombre || !telefono || !password) {
      return res.status(400).json({ error: 'Nombre, teléfono y contraseña son obligatorios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const { rows: existente } = await db.query('SELECT id FROM usuarios WHERE telefono = $1', [telefono]);
    if (existente[0]) {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese número de celular' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO usuarios (nombre, telefono, password_hash) VALUES ($1,$2,$3) RETURNING id, nombre`,
      [nombre, telefono, hash]
    );
    const usuario = rows[0];
    const token = firmarToken({ role: 'cliente', id: usuario.id, nombre: usuario.nombre });
    res.status(201).json({ token, nombre: usuario.nombre });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese número de celular' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  try {
    const { telefono, password } = req.body;
    const { rows } = await db.query('SELECT * FROM usuarios WHERE telefono = $1', [telefono]);
    const usuario = rows[0];
    if (!usuario || !usuario.password_hash || !(await bcrypt.compare(password || '', usuario.password_hash))) {
      return res.status(401).json({ error: 'Teléfono o contraseña incorrectos' });
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
  const { rows } = await db.query('SELECT id, nombre, telefono FROM usuarios WHERE id = $1', [req.auth.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(rows[0]);
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
