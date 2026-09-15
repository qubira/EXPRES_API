const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');
const { subirImagen } = require('../utils/cloudinary');
const { registrarLogin } = require('../utils/auditoria');
const { crearSesion } = require('../utils/sesiones');

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
    const { rows } = await db.query('SELECT * FROM tiendas WHERE email = $1', [email]);
    const tienda = rows[0];
    if (!tienda || !(await bcrypt.compare(password || '', tienda.password_hash))) {
      registrarLogin({ rol: 'tienda', nombre: email, req, exito: false });
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    if (!tienda.activo) {
      return res.status(403).json({ error: 'Tu tienda aun no esta activada. Contacta al administrador.' });
    }
    registrarLogin({ rol: 'tienda', referenciaId: tienda.id, nombre: tienda.nombre, req, exito: true });
    const sid = await crearSesion({ rol: 'tienda', referenciaId: tienda.id, req });
    const token = firmarToken({ role: 'tienda', id: tienda.id, nombre: tienda.nombre, sid });
    res.json({ token, nombre: tienda.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

router.use(requireRole('tienda'));

// ---------- MI PERFIL ----------
router.get('/perfil', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, nombre, categoria, subcategoria, descripcion, zona, direccion, dni_titular, nombre_titular, comision_pactada, contacto_telefono,
            contacto_whatsapp, logo_url, email, disponible
     FROM tiendas WHERE id = $1`,
    [req.auth.id]
  );
  res.json(rows[0]);
});

// ---------- DISPONIBILIDAD (pausa temporal: mientras esta apagada, sus
// productos no se muestran a los clientes, sin tocar la activacion del admin) ----------
router.post('/disponibilidad', async (req, res) => {
  const { disponible } = req.body;
  await db.query('UPDATE tiendas SET disponible = $1 WHERE id = $2', [!!disponible, req.auth.id]);
  res.json({ mensaje: disponible ? 'Ahora estás disponible' : 'Ya no estás disponible', disponible: !!disponible });
});

// ---------- ACTUALIZAR PERFIL ----------
// La comision, el email y la activacion los controla el administrador, no la tienda.
router.put('/perfil', async (req, res) => {
  try {
    const { nombre, categoria, subcategoria, descripcion, zona, direccion, dni_titular, nombre_titular, contacto_telefono, contacto_whatsapp, logo_url } = req.body;
    if (!nombre || !categoria || !zona) {
      return res.status(400).json({ error: 'Nombre, categoría y zona son obligatorios' });
    }
    if (dni_titular && !/^\d{8}$/.test(dni_titular)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    const { rows } = await db.query(
      `UPDATE tiendas SET nombre=$1, categoria=$2, subcategoria=$3, descripcion=$4, zona=$5,
        dni_titular=$6, nombre_titular=$7, contacto_telefono=$8, contacto_whatsapp=$9, logo_url=$10, direccion=$11
       WHERE id=$12
       RETURNING id, nombre, categoria, subcategoria, descripcion, zona, direccion, dni_titular, nombre_titular, contacto_telefono, contacto_whatsapp, logo_url`,
      [nombre, categoria, subcategoria || null, descripcion || null, zona, dni_titular || null, nombre_titular || null,
        contacto_telefono || null, contacto_whatsapp || null, logo_url || null, direccion || null, req.auth.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el perfil' });
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

    const { rows } = await db.query('SELECT password_hash FROM tiendas WHERE id = $1', [req.auth.id]);
    const tienda = rows[0];
    if (!tienda || !(await bcrypt.compare(password_actual, tienda.password_hash))) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }

    const hash = await bcrypt.hash(password_nueva, 10);
    await db.query('UPDATE tiendas SET password_hash = $1 WHERE id = $2', [hash, req.auth.id]);
    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// ---------- SUBIR FOTO DE PRODUCTO ----------
router.post('/upload', upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibio ninguna imagen' });
    const resultado = await subirImagen(req.file.buffer, 'express-ancon/productos');
    res.json({ url: resultado.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir la imagen' });
  }
});

// ---------- MIS PRODUCTOS ----------
router.get('/productos', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM productos WHERE tienda_id = $1 ORDER BY created_at DESC', [req.auth.id]);
  res.json(rows);
});

router.post('/productos', async (req, res) => {
  try {
    const { nombre, marca, descripcion, categoria, subcategoria, precio, unidad, contenido, stock, foto_url } = req.body;
    if (!nombre || !categoria || !subcategoria || precio == null) {
      return res.status(400).json({ error: 'Nombre, categoria, subcategoria y precio son obligatorios' });
    }
    const { rows } = await db.query(
      `INSERT INTO productos (tienda_id, nombre, marca, descripcion, categoria, subcategoria, precio, unidad, contenido, stock, foto_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.auth.id, nombre, marca || null, descripcion || null, categoria, subcategoria,
        precio, unidad || 'unidad', contenido || null, stock || 0, foto_url || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el producto' });
  }
});

router.put('/productos/:id', async (req, res) => {
  try {
    const { rows: owned } = await db.query('SELECT id FROM productos WHERE id = $1 AND tienda_id = $2', [req.params.id, req.auth.id]);
    if (!owned[0]) return res.status(404).json({ error: 'Producto no encontrado' });

    const { nombre, marca, descripcion, categoria, subcategoria, precio, unidad, contenido, stock, foto_url, activo } = req.body;
    await db.query(
      `UPDATE productos SET nombre=$1, marca=$2, descripcion=$3, categoria=$4, subcategoria=$5,
        precio=$6, unidad=$7, contenido=$8, stock=$9, foto_url=$10, activo=$11
       WHERE id=$12`,
      [nombre, marca || null, descripcion || null, categoria, subcategoria,
        precio, unidad || 'unidad', contenido || null, stock, foto_url || null, activo, req.params.id]
    );
    res.json({ mensaje: 'Producto actualizado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el producto' });
  }
});

router.delete('/productos/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM productos WHERE id = $1 AND tienda_id = $2', [req.params.id, req.auth.id]);
    if (!rowCount) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ mensaje: 'Producto eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el producto' });
  }
});

// ---------- MIS PEDIDOS (items vendidos por esta tienda) ----------
router.get('/pedidos', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT pi.id as item_id, pi.nombre_producto, pi.cantidad, pi.subtotal, pi.estado_tienda,
              p.id as pedido_id, p.estado as pedido_estado, p.zona_entrega, p.created_at
       FROM pedido_items pi
       JOIN pedidos p ON p.id = pi.pedido_id
       WHERE pi.tienda_id = $1 AND p.estado NOT IN ('pendiente_pago','pago_rechazado','cancelado')
       ORDER BY p.created_at DESC`,
      [req.auth.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// ---------- MARCAR ITEM COMO LISTO PARA RECOGER ----------
router.post('/pedidos/:pedidoId/items/:itemId/listo', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { pedidoId, itemId } = req.params;
    const { rows: item } = await client.query(
      'SELECT * FROM pedido_items WHERE id = $1 AND pedido_id = $2 AND tienda_id = $3',
      [itemId, pedidoId, req.auth.id]
    );
    if (!item[0]) return res.status(404).json({ error: 'Item no encontrado' });

    await client.query('BEGIN');
    await client.query(`UPDATE pedido_items SET estado_tienda = 'listo' WHERE id = $1`, [itemId]);

    // Si el pedido esta 'pagado', pasa a 'preparando' automaticamente
    await client.query(
      `UPDATE pedidos SET estado = 'preparando' WHERE id = $1 AND estado = 'pagado'`,
      [pedidoId]
    );

    // Si TODOS los items del pedido estan listos, el pedido pasa a 'listo_recoger'
    const { rows: pendientes } = await client.query(
      `SELECT COUNT(*)::int as total FROM pedido_items WHERE pedido_id = $1 AND estado_tienda != 'listo'`,
      [pedidoId]
    );
    if (pendientes[0].total === 0) {
      await client.query(
        `UPDATE pedidos SET estado = 'listo_recoger' WHERE id = $1 AND estado NOT IN ('recogido','entregado')`,
        [pedidoId]
      );
    }

    await client.query('COMMIT');
    res.json({ mensaje: 'Item marcado como listo' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el item' });
  } finally {
    client.release();
  }
});

module.exports = router;
