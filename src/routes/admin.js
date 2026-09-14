const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password || '', admin.password_hash))) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    const token = firmarToken({ role: 'admin', id: admin.id, nombre: admin.nombre });
    res.json({ token, nombre: admin.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

router.use(requireRole('admin'));

// ---------- DASHBOARD / METRICAS ----------
router.get('/metricas', async (req, res) => {
  try {
    const { rows: pedidosHoy } = await db.query(
      `SELECT COUNT(*)::int as total, COALESCE(SUM(monto_total),0)::float as ventas,
              COALESCE(SUM(comision_total),0)::float as comisiones
       FROM pedidos WHERE created_at::date = CURRENT_DATE AND estado NOT IN ('pendiente_pago','pago_rechazado','cancelado')`
    );
    const { rows: pendientes } = await db.query(
      `SELECT COUNT(*)::int as total FROM pagos WHERE estado = 'pendiente'`
    );
    const { rows: porEstado } = await db.query(
      `SELECT estado, COUNT(*)::int as total FROM pedidos GROUP BY estado`
    );
    res.json({
      hoy: pedidosHoy[0],
      pagos_pendientes: pendientes[0].total,
      por_estado: porEstado,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener metricas' });
  }
});

// ---------- PEDIDOS ----------
router.get('/pedidos', async (req, res) => {
  try {
    const { estado } = req.query;
    const params = [];
    let sql = `SELECT p.*, r.nombre as repartidor_nombre
               FROM pedidos p LEFT JOIN repartidores r ON r.id = p.repartidor_id`;
    if (estado) {
      params.push(estado);
      sql += ` WHERE p.estado = $${params.length}`;
    }
    sql += ' ORDER BY p.created_at DESC LIMIT 200';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

router.get('/pedidos/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, r.nombre as repartidor_nombre FROM pedidos p
       LEFT JOIN repartidores r ON r.id = p.repartidor_id WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });

    const { rows: items } = await db.query(
      `SELECT pi.*, t.nombre as tienda_nombre FROM pedido_items pi
       JOIN tiendas t ON t.id = pi.tienda_id WHERE pi.pedido_id = $1`,
      [req.params.id]
    );
    const { rows: pagos } = await db.query(`SELECT * FROM pagos WHERE pedido_id = $1 ORDER BY created_at DESC`, [req.params.id]);

    res.json({ ...rows[0], items, pagos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el pedido' });
  }
});

// ---------- PAGOS (listado, ej. pendientes de confirmar) ----------
router.get('/pagos', async (req, res) => {
  try {
    const { estado } = req.query;
    const params = [];
    let sql = `SELECT pg.*, p.cliente_nombre, p.cliente_telefono, p.monto_total, p.zona_entrega
               FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id`;
    if (estado) {
      params.push(estado);
      sql += ` WHERE pg.estado = $${params.length}`;
    }
    sql += ' ORDER BY pg.created_at ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pagos' });
  }
});

// ---------- CONFIRMAR / RECHAZAR PAGO ----------
router.post('/pagos/:id/confirmar', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM pagos WHERE id = $1', [req.params.id]);
    const pago = rows[0];
    if (!pago) return res.status(404).json({ error: 'Pago no encontrado' });
    if (pago.estado !== 'pendiente') return res.status(400).json({ error: 'Este pago ya fue procesado' });

    await db.query(
      `UPDATE pagos SET estado = 'confirmado', confirmado_por = $1, confirmado_at = now() WHERE id = $2`,
      [req.auth.id, pago.id]
    );
    await db.query(`UPDATE pedidos SET estado = 'pagado' WHERE id = $1`, [pago.pedido_id]);

    res.json({ mensaje: 'Pago confirmado. El pedido pasa a preparacion.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al confirmar el pago' });
  }
});

router.post('/pagos/:id/rechazar', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM pagos WHERE id = $1', [req.params.id]);
    const pago = rows[0];
    if (!pago) return res.status(404).json({ error: 'Pago no encontrado' });
    if (pago.estado !== 'pendiente') return res.status(400).json({ error: 'Este pago ya fue procesado' });

    await db.query(
      `UPDATE pagos SET estado = 'rechazado', confirmado_por = $1, confirmado_at = now() WHERE id = $2`,
      [req.auth.id, pago.id]
    );
    await db.query(`UPDATE pedidos SET estado = 'pago_rechazado' WHERE id = $1`, [pago.pedido_id]);

    res.json({ mensaje: 'Pago rechazado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar el pago' });
  }
});

// ---------- ASIGNAR REPARTIDOR ----------
router.post('/pedidos/:id/asignar', async (req, res) => {
  try {
    const { repartidor_id } = req.body;
    const { rows } = await db.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!['pagado', 'preparando', 'listo_recoger'].includes(rows[0].estado)) {
      return res.status(400).json({ error: 'El pedido no esta listo para asignar repartidor' });
    }

    const { rows: rep } = await db.query('SELECT * FROM repartidores WHERE id = $1 AND activo = true', [repartidor_id]);
    if (!rep[0]) return res.status(404).json({ error: 'Repartidor no encontrado' });

    await db.query(
      `UPDATE pedidos SET repartidor_id = $1, asignado_at = now() WHERE id = $2`,
      [repartidor_id, req.params.id]
    );

    res.json({ mensaje: `Pedido asignado a ${rep[0].nombre}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al asignar repartidor' });
  }
});

// ---------- TIENDAS (CRUD) ----------
router.get('/tiendas', async (req, res) => {
  const { rows } = await db.query('SELECT id, nombre, categoria, subcategoria, zona, dni_titular, comision_pactada, activo, email, contacto_whatsapp, created_at FROM tiendas ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/tiendas', async (req, res) => {
  try {
    const { nombre, categoria, subcategoria, descripcion, dni_titular, contacto_telefono, contacto_whatsapp, zona, comision_pactada, email, password } = req.body;
    if (!nombre || !categoria || !email || !password) {
      return res.status(400).json({ error: 'Nombre, categoria, email y password son obligatorios' });
    }
    if (dni_titular && !/^\d{8}$/.test(dni_titular)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO tiendas (nombre, categoria, subcategoria, descripcion, dni_titular, contacto_telefono, contacto_whatsapp, zona, comision_pactada, email, password_hash, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) RETURNING id`,
      [nombre, categoria, subcategoria || null, descripcion || null, dni_titular || null, contacto_telefono || null, contacto_whatsapp || null,
        zona || null, comision_pactada || 12.0, email, hash]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la tienda (verifica que el email no este en uso)' });
  }
});

router.put('/tiendas/:id', async (req, res) => {
  try {
    const { nombre, categoria, subcategoria, descripcion, dni_titular, contacto_telefono, contacto_whatsapp, zona, comision_pactada, activo } = req.body;
    if (dni_titular && !/^\d{8}$/.test(dni_titular)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    await db.query(
      `UPDATE tiendas SET nombre=$1, categoria=$2, subcategoria=$3, descripcion=$4, dni_titular=$5, contacto_telefono=$6,
        contacto_whatsapp=$7, zona=$8, comision_pactada=$9, activo=$10 WHERE id=$11`,
      [nombre, categoria, subcategoria || null, descripcion || null, dni_titular || null, contacto_telefono || null, contacto_whatsapp || null,
        zona || null, comision_pactada, activo, req.params.id]
    );
    res.json({ mensaje: 'Tienda actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la tienda' });
  }
});

router.post('/tiendas/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password debe tener al menos 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE tiendas SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ mensaje: 'Password actualizado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar password' });
  }
});

// ---------- REPARTIDORES (CRUD) ----------
router.get('/repartidores', async (req, res) => {
  const { rows } = await db.query('SELECT id, nombre, dni, telefono, email, disponible, pago_pendiente, activo FROM repartidores ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/repartidores', async (req, res) => {
  try {
    const { nombre, dni, telefono, email, password } = req.body;
    if (!nombre || !dni || !telefono || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO repartidores (nombre, dni, telefono, email, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [nombre, dni, telefono, email, hash]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear repartidor (verifica DNI/email duplicado)' });
  }
});

router.put('/repartidores/:id', async (req, res) => {
  try {
    const { nombre, telefono, activo, disponible } = req.body;
    await db.query(
      `UPDATE repartidores SET nombre=$1, telefono=$2, activo=$3, disponible=$4 WHERE id=$5`,
      [nombre, telefono, activo, disponible, req.params.id]
    );
    res.json({ mensaje: 'Repartidor actualizado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar repartidor' });
  }
});

router.post('/repartidores/:id/liquidar', async (req, res) => {
  try {
    await db.query('UPDATE repartidores SET pago_pendiente = 0 WHERE id = $1', [req.params.id]);
    res.json({ mensaje: 'Pago liquidado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al liquidar pago' });
  }
});

// ---------- PRODUCTOS (gestion global, ej. moderacion) ----------
router.get('/productos', async (req, res) => {
  const { tienda_id } = req.query;
  const params = [];
  let sql = `SELECT p.*, t.nombre as tienda_nombre FROM productos p JOIN tiendas t ON t.id = p.tienda_id`;
  if (tienda_id) {
    params.push(tienda_id);
    sql += ` WHERE p.tienda_id = $${params.length}`;
  }
  sql += ' ORDER BY p.created_at DESC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

module.exports = router;
