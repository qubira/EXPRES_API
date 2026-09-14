const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const { firmarToken, requireRole } = require('../middleware/auth');
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
    const { rows } = await db.query('SELECT * FROM tiendas WHERE email = $1', [email]);
    const tienda = rows[0];
    if (!tienda || !(await bcrypt.compare(password || '', tienda.password_hash))) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    if (!tienda.activo) {
      return res.status(403).json({ error: 'Tu tienda aun no esta activada. Contacta al administrador.' });
    }
    const token = firmarToken({ role: 'tienda', id: tienda.id, nombre: tienda.nombre });
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
    'SELECT id, nombre, categoria, descripcion, zona, comision_pactada, contacto_whatsapp FROM tiendas WHERE id = $1',
    [req.auth.id]
  );
  res.json(rows[0]);
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
    const { nombre, marca, descripcion, categoria, subcategoria, precio, unidad, stock, foto_url } = req.body;
    if (!nombre || !categoria || !subcategoria || precio == null) {
      return res.status(400).json({ error: 'Nombre, categoria, subcategoria y precio son obligatorios' });
    }
    const { rows } = await db.query(
      `INSERT INTO productos (tienda_id, nombre, marca, descripcion, categoria, subcategoria, precio, unidad, stock, foto_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.auth.id, nombre, marca || null, descripcion || null, categoria, subcategoria,
        precio, unidad || 'unidad', stock || 0, foto_url || null]
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

    const { nombre, marca, descripcion, categoria, subcategoria, precio, unidad, stock, foto_url, activo } = req.body;
    await db.query(
      `UPDATE productos SET nombre=$1, marca=$2, descripcion=$3, categoria=$4, subcategoria=$5,
        precio=$6, unidad=$7, stock=$8, foto_url=$9, activo=$10
       WHERE id=$11`,
      [nombre, marca || null, descripcion || null, categoria, subcategoria,
        precio, unidad || 'unidad', stock, foto_url || null, activo, req.params.id]
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
