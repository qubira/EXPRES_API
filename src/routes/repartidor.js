const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');
const { registrarLogin } = require('../utils/auditoria');
const { crearSesion } = require('../utils/sesiones');

const router = express.Router();

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM repartidores WHERE email = $1', [email]);
    const rep = rows[0];
    if (!rep || !(await bcrypt.compare(password || '', rep.password_hash))) {
      registrarLogin({ rol: 'repartidor', nombre: email, req, exito: false });
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    if (!rep.activo) {
      return res.status(403).json({ error: 'Tu cuenta esta inactiva. Contacta al administrador.' });
    }
    registrarLogin({ rol: 'repartidor', referenciaId: rep.id, nombre: rep.nombre, req, exito: true });
    const sid = await crearSesion({ rol: 'repartidor', referenciaId: rep.id, req });
    const token = firmarToken({ role: 'repartidor', id: rep.id, nombre: rep.nombre, sid });
    res.json({ token, nombre: rep.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

router.use(requireRole('repartidor'));

// ---------- MI PERFIL ----------
router.get('/perfil', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, nombre, telefono, disponible, pago_pendiente FROM repartidores WHERE id = $1',
    [req.auth.id]
  );
  res.json(rows[0]);
});

router.post('/disponibilidad', async (req, res) => {
  const { disponible } = req.body;
  await db.query('UPDATE repartidores SET disponible = $1 WHERE id = $2', [!!disponible, req.auth.id]);
  res.json({ mensaje: 'Disponibilidad actualizada' });
});

// ---------- PEDIDOS ASIGNADOS A MI ----------
router.get('/pedidos', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega, estado,
              monto_total, delivery_fee, asignado_at, recogido_at, entregado_at, created_at
       FROM pedidos
       WHERE repartidor_id = $1 AND estado NOT IN ('entregado','cancelado','pago_rechazado')
       ORDER BY created_at ASC`,
      [req.auth.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

router.get('/pedidos/historial', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, cliente_nombre, zona_entrega, monto_total, delivery_fee, entregado_at
     FROM pedidos WHERE repartidor_id = $1 AND estado = 'entregado'
     ORDER BY entregado_at DESC LIMIT 50`,
    [req.auth.id]
  );
  res.json(rows);
});

// Detalle de un pedido asignado (incluye items para saber que recoger donde)
router.get('/pedidos/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM pedidos WHERE id = $1 AND repartidor_id = $2`,
    [req.params.id, req.auth.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });

  const { rows: items } = await db.query(
    `SELECT pi.nombre_producto, pi.cantidad, t.nombre as tienda_nombre, t.zona as tienda_zona, t.contacto_whatsapp
     FROM pedido_items pi JOIN tiendas t ON t.id = pi.tienda_id WHERE pi.pedido_id = $1`,
    [req.params.id]
  );
  res.json({ ...rows[0], pin_entrega: undefined, items });
});

// ---------- MARCAR COMO RECOGIDO ----------
router.post('/pedidos/:id/recogido', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM pedidos WHERE id = $1 AND repartidor_id = $2', [req.params.id, req.auth.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.estado !== 'listo_recoger') {
      return res.status(400).json({ error: 'El pedido aun no esta listo para recoger' });
    }
    await db.query(`UPDATE pedidos SET estado = 'recogido', recogido_at = now() WHERE id = $1`, [req.params.id]);
    res.json({ mensaje: 'Pedido marcado como recogido' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el pedido' });
  }
});

// ---------- MARCAR COMO ENTREGADO (valida PIN) ----------
router.post('/pedidos/:id/entregar', async (req, res) => {
  try {
    const { pin } = req.body;
    const { rows } = await db.query('SELECT * FROM pedidos WHERE id = $1 AND repartidor_id = $2', [req.params.id, req.auth.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.estado !== 'recogido') {
      return res.status(400).json({ error: 'El pedido debe estar recogido antes de entregar' });
    }
    if (String(pin).trim() !== pedido.pin_entrega) {
      return res.status(400).json({ error: 'PIN incorrecto. Pidele al cliente el PIN de 4 digitos.' });
    }

    await db.query(
      `UPDATE pedidos SET estado = 'entregado', entregado_at = now() WHERE id = $1`,
      [req.params.id]
    );
    await db.query(
      `UPDATE repartidores SET pago_pendiente = pago_pendiente + $1 WHERE id = $2`,
      [pedido.delivery_fee, req.auth.id]
    );

    res.json({ mensaje: 'Pedido entregado con exito' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al confirmar la entrega' });
  }
});

module.exports = router;
