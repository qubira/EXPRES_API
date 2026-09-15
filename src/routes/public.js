const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { generarPin } = require('../utils/pin');
const { subirImagen } = require('../utils/cloudinary');
const { consultarDni } = require('../utils/decolecta');
const { consultarCe } = require('../utils/jsonpe');
const { registrarLogin } = require('../utils/auditoria');
const { crearSesion } = require('../utils/sesiones');
const { JWT_SECRET, requireAnyRole, firmarToken } = require('../middleware/auth');

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

// ---------- LOGIN UNIFICADO ----------
// Un dueño de tienda o un repartidor no maneja una cuenta aparte para comprar:
// entra por el mismo login del sitio normal con su mismo correo/contraseña.
// Se prueba contra cliente, tienda y repartidor en ese orden; el primero que
// coincide gana. El frontend usa el "rol" devuelto para saber si debe mostrar
// el boton "Dashboard" y a que panel mandarlo.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
    }

    const candidatos = [
      { tabla: 'usuarios', rol: 'cliente' },
      { tabla: 'tiendas', rol: 'tienda' },
      { tabla: 'repartidores', rol: 'repartidor' },
    ];

    for (const { tabla, rol } of candidatos) {
      const { rows } = await db.query(`SELECT * FROM ${tabla} WHERE email = $1`, [email]);
      const cuenta = rows[0];
      if (!cuenta || !cuenta.password_hash) continue;
      if (!(await bcrypt.compare(password, cuenta.password_hash))) continue;

      if ('activo' in cuenta && !cuenta.activo) {
        return res.status(403).json({
          error: rol === 'tienda'
            ? 'Tu tienda aun no esta activada. Contacta al administrador.'
            : 'Tu cuenta esta inactiva. Contacta al administrador.',
        });
      }

      if (rol !== 'cliente') {
        registrarLogin({ rol, referenciaId: cuenta.id, nombre: cuenta.nombre, req, exito: true });
      }
      const sid = await crearSesion({ rol, referenciaId: cuenta.id, req });
      const token = firmarToken({ role: rol, id: cuenta.id, nombre: cuenta.nombre, sid });
      return res.json({ token, nombre: cuenta.nombre, rol, zona: cuenta.zona || null });
    }

    res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ---------- CONECTIVIDAD (sesiones activas de MI cuenta) ----------
const TODOS_LOS_ROLES = ['admin', 'tienda', 'repartidor', 'cliente'];

router.get('/mis-sesiones', requireAnyRole(TODOS_LOS_ROLES), async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, ip, user_agent, creado_en
     FROM sesiones WHERE rol = $1 AND referencia_id = $2 AND activa = true
     ORDER BY creado_en DESC`,
    [req.auth.role, req.auth.id]
  );
  res.json(rows.map((r) => ({ ...r, actual: r.id === req.auth.sid })));
});

router.post('/mis-sesiones/:id/cerrar', requireAnyRole(TODOS_LOS_ROLES), async (req, res) => {
  if (req.params.id === req.auth.sid) {
    return res.status(400).json({ error: 'No puedes cerrar la sesión que estás usando ahora mismo' });
  }
  const { rows } = await db.query(
    `UPDATE sesiones SET activa = false WHERE id = $1 AND rol = $2 AND referencia_id = $3 RETURNING id`,
    [req.params.id, req.auth.role, req.auth.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json({ mensaje: 'Sesión cerrada' });
});

router.post('/mis-sesiones/cerrar-otras', requireAnyRole(TODOS_LOS_ROLES), async (req, res) => {
  const { rowCount } = await db.query(
    `UPDATE sesiones SET activa = false WHERE rol = $1 AND referencia_id = $2 AND id != $3 AND activa = true`,
    [req.auth.role, req.auth.id, req.auth.sid]
  );
  res.json({ mensaje: `${rowCount} sesión(es) cerrada(s)` });
});

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

// ---------- CATEGORIAS DE PRODUCTOS (catalogo publico) ----------
const CATEGORIAS = ['ropa', 'comida', 'bebidas', 'servicios', 'artesanias', 'otros'];
router.get('/categorias', (req, res) => {
  res.json(CATEGORIAS);
});

// ---------- TIPOS DE NEGOCIO (categoria de la tienda, distinto del producto) ----------
// Lista ampliable: admin y tiendas pueden agregar un tipo nuevo si no encuentran el suyo.
function slugify(texto) {
  return texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

router.get('/tipos-negocio', async (req, res) => {
  const { rows } = await db.query('SELECT clave, etiqueta FROM tipos_negocio ORDER BY etiqueta');
  res.json(rows);
});

router.post('/tipos-negocio', requireAnyRole(['admin', 'tienda']), async (req, res) => {
  try {
    const etiqueta = (req.body.etiqueta || '').trim();
    if (!etiqueta) return res.status(400).json({ error: 'Escribe un nombre para el tipo de negocio' });
    const clave = slugify(etiqueta);
    if (!clave) return res.status(400).json({ error: 'Nombre invalido' });

    await db.query('INSERT INTO tipos_negocio (clave, etiqueta) VALUES ($1,$2) ON CONFLICT (clave) DO NOTHING', [clave, etiqueta]);
    const { rows } = await db.query('SELECT clave, etiqueta FROM tipos_negocio WHERE clave = $1', [clave]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al agregar el tipo de negocio' });
  }
});

// ---------- ZONAS DE ENTREGA (playas registradas) ----------
router.get('/zonas', async (req, res) => {
  const { rows } = await db.query('SELECT nombre FROM zonas ORDER BY nombre');
  res.json(rows.map((r) => r.nombre));
});

router.post('/zonas', requireAnyRole(['admin', 'tienda']), async (req, res) => {
  try {
    const nombre = (req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Escribe el nombre de la zona' });

    await db.query('INSERT INTO zonas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre]);
    res.status(201).json({ nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al agregar la zona' });
  }
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
// Nota: el stock NUNCA se expone en las rutas publicas (solo lo ve la tienda
// duena del producto, vía /api/tienda/productos).
const CAMPOS_PRODUCTO_PUBLICO = `p.id, p.nombre, p.marca, p.descripcion, p.categoria, p.subcategoria,
       p.precio, p.unidad, p.contenido, p.foto_url,
       t.id as tienda_id, t.nombre as tienda_nombre, t.zona as tienda_zona, t.contacto_whatsapp as tienda_whatsapp`;

router.get('/productos', async (req, res) => {
  try {
    const { categoria, subcategoria, tienda_id, q } = req.query;
    const params = [];
    let sql = `SELECT ${CAMPOS_PRODUCTO_PUBLICO}
               FROM productos p
               JOIN tiendas t ON t.id = p.tienda_id
               WHERE p.activo = true AND t.activo = true AND p.stock > 0`;
    if (categoria) {
      params.push(categoria);
      sql += ` AND p.categoria = $${params.length}`;
    }
    if (subcategoria) {
      params.push(subcategoria);
      sql += ` AND p.subcategoria = $${params.length}`;
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

// ---------- DETALLE DE UN PRODUCTO + SIMILARES ----------
router.get('/productos/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${CAMPOS_PRODUCTO_PUBLICO}
       FROM productos p JOIN tiendas t ON t.id = p.tienda_id
       WHERE p.id = $1 AND p.activo = true AND t.activo = true`,
      [req.params.id]
    );
    const producto = rows[0];
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });

    let similares = [];
    if (producto.subcategoria) {
      const { rows: relacionados } = await db.query(
        `SELECT ${CAMPOS_PRODUCTO_PUBLICO}
         FROM productos p JOIN tiendas t ON t.id = p.tienda_id
         WHERE p.activo = true AND t.activo = true AND p.stock > 0
           AND p.subcategoria = $1 AND p.id != $2
         ORDER BY p.created_at DESC LIMIT 8`,
        [producto.subcategoria, producto.id]
      );
      similares = relacionados;
    }
    if (similares.length < 4) {
      const { rows: mismaCategoria } = await db.query(
        `SELECT ${CAMPOS_PRODUCTO_PUBLICO}
         FROM productos p JOIN tiendas t ON t.id = p.tienda_id
         WHERE p.activo = true AND t.activo = true AND p.stock > 0
           AND p.categoria = $1 AND p.id != $2
         ORDER BY p.created_at DESC LIMIT 8`,
        [producto.categoria, producto.id]
      );
      const idsExistentes = new Set(similares.map((s) => s.id));
      for (const item of mismaCategoria) {
        if (!idsExistentes.has(item.id) && similares.length < 8) similares.push(item);
      }
    }

    res.json({ ...producto, similares });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el producto' });
  }
});

// ---------- CREAR PEDIDO (checkout) ----------
// Requiere sesion de cliente: no se aceptan pedidos como invitado.
// body: { cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega, items: [{producto_id, cantidad}] }
router.post('/pedidos', async (req, res) => {
  const cliente = clienteOpcional(req);
  if (!cliente) {
    return res.status(401).json({ error: 'Debes iniciar sesión para completar tu compra' });
  }

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

    const { rows: pedidoRows } = await client.query(
      `INSERT INTO pedidos
        (usuario_id, cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega,
         estado, monto_productos, delivery_fee, comision_total, monto_total, pin_entrega)
       VALUES ($1,$2,$3,$4,$5,'pendiente_pago',$6,$7,$8,$9,$10)
       RETURNING id, estado, monto_productos, delivery_fee, monto_total, created_at`,
      [cliente.id, cliente_nombre, cliente_telefono, zona_entrega, referencia_entrega || null,
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
    const { nombre, categoria, subcategoria, contacto_whatsapp, zona, descripcion, dni_titular, nombre_titular } = req.body;
    if (!nombre || !categoria || !contacto_whatsapp || !zona || !dni_titular) {
      return res.status(400).json({ error: 'Nombre, categoria, zona, DNI del titular y WhatsApp son obligatorios' });
    }
    const { rows: tipoValido } = await db.query('SELECT 1 FROM tipos_negocio WHERE clave = $1', [categoria]);
    if (!tipoValido[0]) {
      return res.status(400).json({ error: 'Tipo de negocio invalido' });
    }
    if (!/^\d{8}$/.test(dni_titular)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    // Se guarda inactiva; el admin la activa tras contactar al vendedor y fijar password/comision
    const emailTemporal = `solicitud+${crypto.randomUUID()}@express-ancon.local`;
    const passwordTemporal = crypto.randomBytes(12).toString('hex');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(passwordTemporal, 10);

    await db.query(
      `INSERT INTO tiendas (nombre, categoria, subcategoria, descripcion, dni_titular, nombre_titular, contacto_whatsapp, zona, email, password_hash, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)`,
      [nombre, categoria, subcategoria || null, descripcion || null, dni_titular, nombre_titular || null, contacto_whatsapp, zona, emailTemporal, hash]
    );

    res.status(201).json({ mensaje: 'Solicitud recibida. Te contactaremos por WhatsApp para activar tu tienda.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la solicitud' });
  }
});

// ---------- CONSULTA DNI (RENIEC via Decolecta) - autocompletar nombre del titular ----------
router.get('/consulta-dni/:numero', async (req, res) => {
  try {
    const { numero } = req.params;
    if (!/^\d{8}$/.test(numero)) {
      return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
    }
    const resultado = await consultarDni(numero);
    if (!resultado) return res.status(404).json({ error: 'DNI no encontrado' });
    res.json(resultado);
  } catch (err) {
    console.error(err);
    res.status(err.status === 429 ? 429 : 502).json({
      error: err.status === 429 ? 'Se alcanzó el límite de consultas de DNI. Ingresa el nombre manualmente.' : 'No se pudo consultar el DNI, ingresa el nombre manualmente',
    });
  }
});

// ---------- CONSULTA CE (Migraciones via VerificaID) - autocompletar nombre del extranjero ----------
router.get('/consulta-ce/:numero', async (req, res) => {
  try {
    const { numero } = req.params;
    if (!numero) {
      return res.status(400).json({ error: 'El número de CE es obligatorio' });
    }
    const resultado = await consultarCe(numero);
    if (!resultado) return res.status(404).json({ error: 'CE no encontrado' });
    res.json(resultado);
  } catch (err) {
    console.error(err);
    const status = err.status === 429 || err.status === 402 ? err.status : 502;
    res.status(status).json({
      error: err.status === 402
        ? 'El servicio de consulta de CE no tiene créditos disponibles. Ingresa el nombre manualmente.'
        : err.status === 429
          ? 'Se alcanzó el límite de consultas de CE. Ingresa el nombre manualmente.'
          : 'No se pudo consultar el CE, ingresa el nombre manualmente',
    });
  }
});

module.exports = router;
