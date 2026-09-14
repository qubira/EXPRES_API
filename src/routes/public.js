const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { generarPin } = require('../utils/pin');
const { subirImagen } = require('../utils/cloudinary');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const DELIVERY_FEE_DEFAULT = Number(process.env.DELIVERY_FEE_DEFAULT || 5.0);

// El checkout es publico (permite invitados), pero si el cliente envia un
// token valido de cuenta, el pedido queda vinculado a su historial.
function clienteOpcional(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.role === 'cliente' ? payload : null;
  } catch (err) {
    return null;
  }
}

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

// ---------- CATEGORIAS ----------
const CATEGORIAS = ['ropa', 'comida', 'bebidas', 'servicios', 'artesanias', 'otros'];
router.get('/categorias', (req, res) => {
  res.json(CATEGORIAS);
});

// ---------- TIENDAS ----------
router.get('/tiendas', async (req, res) => {
  try {
    const { categoria } = req.query;
    const params = [];
    let sql = `SELECT id, nombre, categoria, descripcion, logo_url, zona, contacto_whatsapp
               FROM tiendas WHERE activo = true`;
    if (categoria) {
      params.push(categoria);
      sql += ` AND categoria = $${params.length}`;
    }
    sql += ' ORDER BY nombre ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tiendas' });
  }
});

router.get('/tiendas/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, categoria, descripcion, logo_url, zona, contacto_whatsapp
       FROM tiendas WHERE id = $1 AND activo = true`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tienda no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la tienda' });
  }
});

// ---------- PRODUCTOS ----------
router.get('/productos', async (req, res) => {
  try {
    const { categoria, tienda_id, q } = req.query;
    const params = [];
    let sql = `SELECT p.id, p.nombre, p.descripcion, p.categoria, p.precio, p.stock, p.foto_url,
                      t.id as tienda_id, t.nombre as tienda_nombre, t.zona as tienda_zona
               FROM productos p
               JOIN tiendas t ON t.id = p.tienda_id
               WHERE p.activo = true AND t.activo = true AND p.stock > 0`;
    if (categoria) {
      params.push(categoria);
      sql += ` AND p.categoria = $${params.length}`;
    }
    if (tienda_id) {
      params.push(tienda_id);
      sql += ` AND p.tienda_id = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND p.nombre ILIKE $${params.length}`;
    }
    sql += ' ORDER BY p.created_at DESC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// ---------- CREAR PEDIDO (checkout) ----------
// body: { cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega, items: [{producto_id, cantidad}] }
router.post('/pedidos', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega, items } = req.body;

    if (!cliente_nombre || !cliente_telefono || !zona_entrega) {
      return res.status(400).json({ error: 'Faltan datos del cliente o de la zona de entrega' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito esta vacio' });
    }

    await client.query('BEGIN');

    // Traer productos reales desde BD (nunca confiar en precios del cliente)
    const productoIds = items.map((i) => i.producto_id);
    const { rows: productos } = await client.query(
      `SELECT p.id, p.nombre, p.precio, p.stock, p.tienda_id, t.comision_pactada
       FROM productos p JOIN tiendas t ON t.id = p.tienda_id
       WHERE p.id = ANY($1::uuid[]) AND p.activo = true AND t.activo = true`,
      [productoIds]
    );

    if (productos.length !== productoIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Uno o mas productos ya no estan disponibles' });
    }

    let montoProductos = 0;
    let comisionTotal = 0;
    const itemsPreparados = [];

    for (const item of items) {
      const producto = productos.find((p) => p.id === item.producto_id);
      const cantidad = Number(item.cantidad) || 0;
      if (cantidad <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cantidad invalida para ${producto.nombre}` });
      }
      if (producto.stock < cantidad) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Stock insuficiente para "${producto.nombre}"` });
      }
      const subtotal = Number(producto.precio) * cantidad;
      const comisionMonto = Number(((subtotal * Number(producto.comision_pactada)) / 100).toFixed(2));
      montoProductos += subtotal;
      comisionTotal += comisionMonto;
      itemsPreparados.push({
        producto_id: producto.id,
        tienda_id: producto.tienda_id,
        nombre: producto.nombre,
        precio: producto.precio,
        cantidad,
        subtotal,
        comision_pct: producto.comision_pactada,
        comision_monto: comisionMonto,
      });
    }

    const deliveryFee = DELIVERY_FEE_DEFAULT;
    const montoTotal = montoProductos + deliveryFee;
    const pin = generarPin();
    const cliente = clienteOpcional(req);

    const { rows: pedidoRows } = await client.query(
      `INSERT INTO pedidos
        (usuario_id, cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega,
         estado, monto_productos, delivery_fee, comision_total, monto_total, pin_entrega)
       VALUES ($1,$2,$3,$4,$5,'pendiente_pago',$6,$7,$8,$9,$10)
       RETURNING id, estado, monto_productos, delivery_fee, monto_total, created_at`,
      [cliente ? cliente.id : null, cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega || null,
        montoProductos, deliveryFee, comisionTotal, montoTotal, pin]
    );
    const pedido = pedidoRows[0];

    for (const item of itemsPreparados) {
      await client.query(
        `INSERT INTO pedido_items
          (pedido_id, producto_id, tienda_id, nombre_producto, precio_unitario, cantidad, subtotal, comision_pct, comision_monto)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pedido.id, item.producto_id, item.tienda_id, item.nombre, item.precio, item.cantidad,
          item.subtotal, item.comision_pct, item.comision_monto]
      );
      await client.query(`UPDATE productos SET stock = stock - $1 WHERE id = $2`, [item.cantidad, item.producto_id]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: pedido.id,
      estado: pedido.estado,
      monto_productos: pedido.monto_productos,
      delivery_fee: pedido.delivery_fee,
      monto_total: pedido.monto_total,
      created_at: pedido.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al crear el pedido' });
  } finally {
    client.release();
  }
});

// ---------- SUBIR COMPROBANTE DE PAGO ----------
router.post('/pedidos/:id/pago', upload.single('comprobante'), async (req, res) => {
  try {
    const { id } = req.params;
    const { tipo, referencia } = req.body;

    if (!['yape', 'plin', 'tarjeta'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de pago invalido' });
    }

    const { rows: pedidoRows } = await db.query(`SELECT id, estado FROM pedidos WHERE id = $1`, [id]);
    if (!pedidoRows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedidoRows[0].estado !== 'pendiente_pago') {
      return res.status(400).json({ error: 'Este pedido ya tiene un pago registrado' });
    }

    if (!req.file && tipo !== 'tarjeta') {
      return res.status(400).json({ error: 'Debes subir la captura del comprobante' });
    }

    let comprobanteUrl = null;
    if (req.file) {
      const resultado = await subirImagen(req.file.buffer, 'express-ancon/comprobantes');
      comprobanteUrl = resultado.secure_url;
    }

    await db.query(
      `INSERT INTO pagos (pedido_id, tipo, estado, comprobante_url, referencia)
       VALUES ($1,$2,'pendiente',$3,$4)`,
      [id, tipo, comprobanteUrl, referencia || null]
    );

    res.status(201).json({ mensaje: 'Comprobante recibido. Tu pago sera confirmado en unos minutos.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el pago' });
  }
});

// ---------- SEGUIMIENTO DE PEDIDO ----------
// El PIN solo se muestra una vez el pago fue confirmado
router.get('/pedidos/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, cliente_nombre, zona_entrega, estado, monto_productos, delivery_fee, monto_total,
              pin_entrega, created_at, asignado_at, recogido_at, entregado_at
       FROM pedidos WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });

    const pedido = rows[0];
    const pinVisible = ['pagado', 'preparando', 'listo_recoger', 'recogido'].includes(pedido.estado);

    const { rows: items } = await db.query(
      `SELECT pi.nombre_producto, pi.cantidad, pi.precio_unitario, pi.subtotal, pi.estado_tienda, t.nombre as tienda_nombre
       FROM pedido_items pi JOIN tiendas t ON t.id = pi.tienda_id
       WHERE pi.pedido_id = $1`,
      [pedido.id]
    );

    res.json({
      ...pedido,
      pin_entrega: pinVisible ? pedido.pin_entrega : null,
      items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el pedido' });
  }
});

// ---------- REGISTRO DE TIENDAS SOCIAS (solicitud) ----------
router.post('/tiendas/solicitud', async (req, res) => {
  try {
    const { nombre, categoria, contacto_whatsapp, zona, descripcion } = req.body;
    if (!nombre || !categoria || !contacto_whatsapp) {
      return res.status(400).json({ error: 'Nombre, categoria y WhatsApp son obligatorios' });
    }
    if (!CATEGORIAS.includes(categoria)) {
      return res.status(400).json({ error: 'Categoria invalida' });
    }
    // Se guarda inactiva; el admin la activa tras contactar al vendedor y fijar password/comision
    const emailTemporal = `solicitud+${crypto.randomUUID()}@express-ancon.local`;
    const passwordTemporal = crypto.randomBytes(12).toString('hex');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(passwordTemporal, 10);

    await db.query(
      `INSERT INTO tiendas (nombre, categoria, descripcion, contacto_whatsapp, zona, email, password_hash, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [nombre, categoria, descripcion || null, contacto_whatsapp, zona || null, emailTemporal, hash]
    );

    res.status(201).json({ mensaje: 'Solicitud recibida. Te contactaremos por WhatsApp para activar tu tienda.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la solicitud' });
  }
});

module.exports = router;
