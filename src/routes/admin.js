const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');
const { registrarLogin } = require('../utils/auditoria');
const { crearSesion } = require('../utils/sesiones');
const { subirImagen } = require('../utils/cloudinary');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|jpg)$/.test(file.mimetype)) {
      return cb(new Error('Solo se permiten imagenes (jpg, png, webp)'));
    }
    cb(null, true);
  },
});

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password || '', admin.password_hash))) {
      registrarLogin({ rol: 'admin', nombre: email, req, exito: false });
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    registrarLogin({ rol: 'admin', referenciaId: admin.id, nombre: admin.nombre, req, exito: true });
    const sid = await crearSesion({ rol: 'admin', referenciaId: admin.id, req });
    const token = firmarToken({ role: 'admin', id: admin.id, nombre: admin.nombre, sid });
    res.json({ token, nombre: admin.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

router.use(requireRole('admin'));

// ---------- SUBIR IMAGEN (ej. foto de repartidor) ----------
router.post('/upload', upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibio ninguna imagen' });
    const carpetasPermitidas = { tiendas: 'express-ancon/tiendas', repartidores: 'express-ancon/repartidores' };
    const carpeta = carpetasPermitidas[req.query.carpeta] || 'express-ancon/repartidores';
    const resultado = await subirImagen(req.file.buffer, carpeta);
    res.json({ url: resultado.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir la imagen' });
  }
});

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
    let sql = `SELECT pg.*, p.cliente_nombre, p.cliente_telefono, p.monto_productos, p.delivery_fee, p.monto_total, p.zona_entrega,
               (
                 SELECT json_agg(json_build_object(
                   'nombre_producto', pi.nombre_producto,
                   'cantidad', pi.cantidad,
                   'subtotal', pi.subtotal,
                   'tienda_nombre', t.nombre
                 ) ORDER BY t.nombre, pi.nombre_producto)
                 FROM pedido_items pi JOIN tiendas t ON t.id = pi.tienda_id
                 WHERE pi.pedido_id = p.id
               ) as items
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
  const { rows } = await db.query('SELECT id, nombre, categoria, subcategoria, zona, direccion, dni_titular, nombre_titular, comision_pactada, activo, disponible, email, contacto_whatsapp, logo_url, created_at FROM tiendas ORDER BY created_at DESC');
  res.json(rows);
});

// ---------- PRODUCTOS DE UNA TIENDA CON METRICAS (vistas, pedidos, ventas, cancelados) ----------
router.get('/tiendas/:id/productos', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.nombre, p.categoria, p.subcategoria, p.unidad, p.contenido, p.precio, p.stock, p.activo, p.vistas,
              COUNT(pi.id)::int as total_pedidos,
              COUNT(pi.id) FILTER (WHERE pd.estado = 'entregado')::int as ventas,
              COUNT(pi.id) FILTER (WHERE pd.estado IN ('cancelado','pago_rechazado','rechazado_en_entrega'))::int as cancelados
       FROM productos p
       LEFT JOIN pedido_items pi ON pi.producto_id = p.id
       LEFT JOIN pedidos pd ON pd.id = pi.pedido_id
       WHERE p.tienda_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los productos de la tienda' });
  }
});

router.post('/tiendas', async (req, res) => {
  try {
    const { nombre, categoria, subcategoria, descripcion, dni_titular, nombre_titular, contacto_telefono, contacto_whatsapp, zona, direccion, comision_pactada, email, password, logo_url } = req.body;
    if (!nombre || !categoria || !email || !password) {
      return res.status(400).json({ error: 'Nombre, categoria, email y password son obligatorios' });
    }
    if (dni_titular && !/^\d{8}$/.test(dni_titular)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO tiendas (nombre, categoria, subcategoria, descripcion, dni_titular, nombre_titular, contacto_telefono, contacto_whatsapp, zona, direccion, comision_pactada, email, password_hash, logo_url, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true) RETURNING id`,
      [nombre, categoria, subcategoria || null, descripcion || null, dni_titular || null, nombre_titular || null, contacto_telefono || null, contacto_whatsapp || null,
        zona || null, direccion || null, comision_pactada || 12.0, email, hash, logo_url || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la tienda (verifica que el email no este en uso)' });
  }
});

router.put('/tiendas/:id', async (req, res) => {
  try {
    const { nombre, categoria, subcategoria, descripcion, dni_titular, nombre_titular, contacto_telefono, contacto_whatsapp, zona, direccion, comision_pactada, activo, logo_url } = req.body;
    if (dni_titular && !/^\d{8}$/.test(dni_titular)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    await db.query(
      `UPDATE tiendas SET nombre=$1, categoria=$2, subcategoria=$3, descripcion=$4, dni_titular=$5, nombre_titular=$6, contacto_telefono=$7,
        contacto_whatsapp=$8, zona=$9, comision_pactada=$10, activo=$11, logo_url=$12, direccion=$13 WHERE id=$14`,
      [nombre, categoria, subcategoria || null, descripcion || null, dni_titular || null, nombre_titular || null, contacto_telefono || null, contacto_whatsapp || null,
        zona || null, comision_pactada, activo, logo_url || null, direccion || null, req.params.id]
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
  const { rows } = await db.query(
    `SELECT id, nombre, dni, tipo_documento, nacionalidad, edad, telefono, direccion,
            contacto_emergencia_nombre, contacto_emergencia_telefono, antecedentes_penales,
            foto_url, email, disponible, pago_pendiente, activo
     FROM repartidores ORDER BY created_at DESC`
  );
  res.json(rows);
});

router.post('/repartidores', async (req, res) => {
  try {
    const {
      nombre, dni, tipo_documento, nacionalidad, edad, telefono, email, password,
      direccion, contacto_emergencia_nombre, contacto_emergencia_telefono,
      antecedentes_penales, foto_url,
    } = req.body;

    if (!nombre || !dni || !telefono || !email || !password) {
      return res.status(400).json({ error: 'Nombre, documento, teléfono, email y contraseña son obligatorios' });
    }
    const tipoDoc = tipo_documento === 'ce' ? 'ce' : 'dni';
    if (tipoDoc === 'dni' && !/^\d{8}$/.test(dni)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO repartidores (
        nombre, dni, tipo_documento, nacionalidad, edad, telefono, email, password_hash,
        direccion, contacto_emergencia_nombre, contacto_emergencia_telefono,
        antecedentes_penales, foto_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [nombre, dni, tipoDoc, nacionalidad || (tipoDoc === 'dni' ? 'Peruana' : null), edad || null,
        telefono, email, hash, direccion || null, contacto_emergencia_nombre || null,
        contacto_emergencia_telefono || null, antecedentes_penales === true, foto_url || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear repartidor (verifica DNI/CE o email duplicado)' });
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

// ---------- CUENTAS DE USUARIO (clientes) ----------
router.get('/usuarios', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.email, u.telefono, u.zona, u.created_at,
             COUNT(p.id)::int as total_pedidos,
             COALESCE(SUM(p.monto_total) FILTER (WHERE p.estado = 'entregado'), 0) as total_gastado
      FROM usuarios u
      LEFT JOIN pedidos p ON p.usuario_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las cuentas de usuario' });
  }
});

router.put('/usuarios/:id', async (req, res) => {
  try {
    const { nombre, email, telefono, zona } = req.body;
    if (!nombre || !telefono) {
      return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    }
    await db.query(
      `UPDATE usuarios SET nombre = $1, email = $2, telefono = $3, zona = $4 WHERE id = $5`,
      [nombre, email || null, telefono, zona || null, req.params.id]
    );
    res.json({ mensaje: 'Cuenta actualizada' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la cuenta' });
  }
});

router.post('/usuarios/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la contraseña' });
  }
});

// ---------- RECLAMOS ----------
router.get('/reclamos', async (req, res) => {
  const { estado } = req.query;
  const params = [];
  let sql = `
    SELECT r.id, r.pedido_id, r.motivo, r.descripcion, r.estado, r.resolucion, r.created_at, r.resuelto_at,
           p.cliente_nombre, p.estado as pedido_estado
    FROM reclamos r JOIN pedidos p ON p.id = r.pedido_id`;
  if (estado) {
    params.push(estado);
    sql += ` WHERE r.estado = $${params.length}`;
  }
  sql += ' ORDER BY r.created_at DESC LIMIT 200';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

router.post('/reclamos/:id/resolver', async (req, res) => {
  try {
    const { resolucion, estado } = req.body;
    const nuevoEstado = estado === 'en_revision' ? 'en_revision' : 'resuelto';
    const { rows } = await db.query(
      `UPDATE reclamos SET estado = $1, resolucion = $2,
              resuelto_at = CASE WHEN $1 = 'resuelto' THEN now() ELSE resuelto_at END
       WHERE id = $3 RETURNING id`,
      [nuevoEstado, resolucion || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Reclamo no encontrado' });
    res.json({ mensaje: 'Reclamo actualizado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el reclamo' });
  }
});

// ---------- PAGOS RETENIDOS (entregas observadas: se recibio el pedido sin validar el PIN) ----------
router.get('/pedidos-retenidos', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.cliente_nombre, p.zona_entrega, p.delivery_fee, p.entregado_at,
            r.id as repartidor_id, r.nombre as repartidor_nombre
     FROM pedidos p JOIN repartidores r ON r.id = p.repartidor_id
     WHERE p.pago_retenido = true ORDER BY p.entregado_at DESC`
  );
  res.json(rows);
});

router.post('/pedidos/:id/liberar-pago', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!pedido.pago_retenido) {
      return res.status(400).json({ error: 'Este pedido no tiene un pago retenido' });
    }

    await client.query('BEGIN');
    await client.query('UPDATE pedidos SET pago_retenido = false WHERE id = $1', [pedido.id]);
    await client.query(
      'UPDATE repartidores SET pago_pendiente = pago_pendiente + $1 WHERE id = $2',
      [pedido.delivery_fee, pedido.repartidor_id]
    );
    await client.query('COMMIT');

    res.json({ mensaje: 'Pago liberado al repartidor' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al liberar el pago' });
  } finally {
    client.release();
  }
});

// ---------- AUDITORIA (conexiones del equipo: admin/tienda/repartidor) ----------
router.get('/auditoria', async (req, res) => {
  const { rol } = req.query;
  const params = [];
  let sql = 'SELECT id, rol, referencia_id, nombre, accion, ip, user_agent, created_at FROM auditoria';
  if (rol) {
    params.push(rol);
    sql += ` WHERE rol = $${params.length}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT 300';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

module.exports = router;
