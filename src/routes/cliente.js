const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');
const { crearSesion } = require('../utils/sesiones');

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
    const sid = await crearSesion({ rol: 'cliente', referenciaId: usuario.id, req });
    const token = firmarToken({ role: 'cliente', id: usuario.id, nombre: usuario.nombre, sid });
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
    const sid = await crearSesion({ rol: 'cliente', referenciaId: usuario.id, req });
    const token = firmarToken({ role: 'cliente', id: usuario.id, nombre: usuario.nombre, sid });
    res.json({ token, nombre: usuario.nombre, zona: usuario.zona });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

router.use(requireRole('cliente'));

// ---------- MI PERFIL ----------
router.get('/perfil', async (req, res) => {
  const { rows } = await db.query('SELECT id, nombre, email, telefono, zona FROM usuarios WHERE id = $1', [req.auth.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(rows[0]);
});

// ---------- ACTUALIZAR ZONA (ubicacion dentro de la playa) ----------
router.post('/zona', async (req, res) => {
  try {
    const { zona } = req.body;
    if (!zona || !zona.trim()) {
      return res.status(400).json({ error: 'Ingresa tu zona' });
    }
    const { rows } = await db.query(
      'UPDATE usuarios SET zona = $1 WHERE id = $2 RETURNING zona',
      [zona.trim(), req.auth.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar tu zona' });
  }
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
      const pinVisible = ['listo_recoger', 'recogido'].includes(p.estado);
      return { ...p, pin_entrega: pinVisible ? p.pin_entrega : null };
    });
    res.json(pedidos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tus pedidos' });
  }
});

// ---------- CANCELAR PEDIDO ----------
// Solo se puede cancelar antes de que la tienda termine de prepararlo. Una vez
// "listo_recoger" (o mas adelante), ya no hay cancelacion: el cliente puede
// esperar el pedido o rechazarlo cuando el repartidor llegue, sin reembolso.
router.post('/pedidos/:id/cancelar', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM pedidos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.auth.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (['cancelado', 'entregado', 'rechazado_en_entrega'].includes(pedido.estado)) {
      return res.status(400).json({ error: 'Este pedido ya no se puede cancelar' });
    }
    if (!['pendiente_pago', 'pagado', 'preparando'].includes(pedido.estado)) {
      return res.status(400).json({
        error: 'Este pedido ya está listo o en camino y no se puede cancelar. Puedes rechazarlo cuando el repartidor llegue, pero no habrá reembolso.',
      });
    }

    await client.query('BEGIN');
    const { rows: items } = await client.query('SELECT producto_id, cantidad FROM pedido_items WHERE pedido_id = $1', [pedido.id]);
    for (const item of items) {
      await client.query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [item.cantidad, item.producto_id]);
    }
    await client.query(`UPDATE pedidos SET estado = 'cancelado' WHERE id = $1`, [pedido.id]);
    await client.query('COMMIT');

    res.json({
      mensaje: pedido.estado === 'pendiente_pago'
        ? 'Pedido cancelado'
        : 'Pedido cancelado. Si ya realizaste el pago, un administrador se pondrá en contacto para coordinar tu reembolso.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar el pedido' });
  } finally {
    client.release();
  }
});

// ---------- RECLAMOS ----------
const MOTIVOS_RECLAMO = ['producto_incorrecto', 'producto_danado', 'no_recibido', 'otro'];

router.post('/pedidos/:id/reclamo', async (req, res) => {
  try {
    const { motivo, descripcion } = req.body;
    if (!MOTIVOS_RECLAMO.includes(motivo)) {
      return res.status(400).json({ error: 'Motivo de reclamo invalido' });
    }
    const { rows } = await db.query('SELECT id FROM pedidos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.auth.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });

    const { rows: creado } = await db.query(
      `INSERT INTO reclamos (pedido_id, usuario_id, motivo, descripcion) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [req.params.id, req.auth.id, motivo, descripcion || null]
    );
    res.status(201).json({ id: creado[0].id, mensaje: 'Reclamo registrado. Un administrador lo revisará pronto.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el reclamo' });
  }
});

router.get('/pedidos/:id/reclamos', async (req, res) => {
  try {
    const { rows: pedido } = await db.query('SELECT id FROM pedidos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.auth.id]);
    if (!pedido[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const { rows } = await db.query(
      'SELECT id, motivo, descripcion, estado, resolucion, created_at FROM reclamos WHERE pedido_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los reclamos' });
  }
});

module.exports = router;
