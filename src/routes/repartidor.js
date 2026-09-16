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

// ---------- SUBIR FOTO DE PERFIL ----------
router.post('/upload', upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibio ninguna imagen' });
    const resultado = await subirImagen(req.file.buffer, 'express-ancon/repartidores');
    res.json({ url: resultado.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir la imagen' });
  }
});

// ---------- MI PERFIL ----------
router.get('/perfil', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, nombre, telefono, zona, foto_url, disponible, pago_pendiente FROM repartidores WHERE id = $1',
    [req.auth.id]
  );
  res.json(rows[0]);
});

router.put('/perfil', async (req, res) => {
  try {
    const { nombre, telefono, zona, foto_url } = req.body;
    if (!nombre || !telefono) {
      return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    }
    const { rows } = await db.query(
      `UPDATE repartidores SET nombre=$1, telefono=$2, zona=$3, foto_url=$4
       WHERE id=$5
       RETURNING id, nombre, telefono, zona, foto_url`,
      [nombre, telefono, zona || null, foto_url || null, req.auth.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el perfil' });
  }
});

router.post('/perfil/password', async (req, res) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva) {
      return res.status(400).json({ error: 'Ingresa tu contraseña actual y la nueva' });
    }
    if (password_nueva.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }
    const { rows } = await db.query('SELECT password_hash FROM repartidores WHERE id = $1', [req.auth.id]);
    const rep = rows[0];
    if (!rep || !(await bcrypt.compare(password_actual, rep.password_hash))) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }
    const hash = await bcrypt.hash(password_nueva, 10);
    await db.query('UPDATE repartidores SET password_hash = $1 WHERE id = $2', [hash, req.auth.id]);
    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
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
              monto_total, delivery_fee, asignado_at, recogido_at, entregado_at, created_at,
              lat_entrega, lng_entrega
       FROM pedidos
       WHERE repartidor_id = $1 AND estado NOT IN ('entregado','cancelado','pago_rechazado','rechazado_en_entrega')
       ORDER BY created_at ASC`,
      [req.auth.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// ---------- PEDIDOS DISPONIBLES PARA TOMAR (sin repartidor asignado, en mi zona) ----------
router.get('/pedidos/disponibles', async (req, res) => {
  try {
    const { rows: repRows } = await db.query('SELECT zona FROM repartidores WHERE id = $1', [req.auth.id]);
    const zona = repRows[0] && repRows[0].zona;
    if (!zona) return res.json([]); // sin zona configurada en su perfil, no le mostramos nada aun

    const { rows } = await db.query(
      `SELECT id, cliente_nombre, zona_entrega, referencia_entrega, estado,
              monto_total, delivery_fee, created_at, lat_entrega, lng_entrega
       FROM pedidos
       WHERE repartidor_id IS NULL AND estado IN ('pagado','preparando','listo_recoger')
         AND zona_entrega ILIKE '%' || $1 || '%'
       ORDER BY created_at ASC`,
      [zona]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos disponibles' });
  }
});

// ---------- TOMAR UN PEDIDO DEL POOL ----------
router.post('/pedidos/:id/reclamar', async (req, res) => {
  try {
    const { rows: repRows } = await db.query('SELECT disponible, zona FROM repartidores WHERE id = $1', [req.auth.id]);
    const rep = repRows[0];
    if (!rep.disponible) return res.status(400).json({ error: 'Debes estar disponible para tomar pedidos' });
    if (!rep.zona) return res.status(400).json({ error: 'Configura tu zona en Mi perfil antes de tomar pedidos' });

    const { rows } = await db.query(
      `UPDATE pedidos SET repartidor_id = $1, asignado_at = now()
       WHERE id = $2 AND repartidor_id IS NULL AND estado IN ('pagado','preparando','listo_recoger')
         AND zona_entrega ILIKE '%' || $3 || '%'
       RETURNING id`,
      [req.auth.id, req.params.id, rep.zona]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Ese pedido ya no está disponible' });

    res.json({ mensaje: 'Pedido tomado. Ya está en Mis entregas.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al tomar el pedido' });
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

// ---------- ENTREGAR SIN PIN VALIDO ----------
// El cliente recibio el producto pero no pudo/quiso dar el codigo. Se marca como
// entregado igual (el repartidor ya hizo su trabajo), pero se observa la entrega
// y se retiene el pago hasta que el admin revise que paso.
router.post('/pedidos/:id/entregar-sin-pin', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM pedidos WHERE id = $1 AND repartidor_id = $2', [req.params.id, req.auth.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.estado !== 'recogido') {
      return res.status(400).json({ error: 'El pedido debe estar recogido antes de entregar' });
    }

    await db.query(
      `UPDATE pedidos
       SET estado = 'entregado', entregado_at = now(), entrega_observada = true, pago_retenido = true
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      mensaje: 'Entrega registrada como observada. Tu pago por este pedido quedara retenido hasta que el administrador lo revise.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al confirmar la entrega' });
  }
});

// ---------- CLIENTE RECHAZO EL PEDIDO ----------
// El cliente no acepto el producto al momento de la entrega (p. ej. llego danado
// o no es lo que pidio). No hay desembolso para el repartidor en este caso.
router.post('/pedidos/:id/rechazado', async (req, res) => {
  try {
    const { motivo } = req.body;
    const { rows } = await db.query('SELECT * FROM pedidos WHERE id = $1 AND repartidor_id = $2', [req.params.id, req.auth.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.estado !== 'recogido') {
      return res.status(400).json({ error: 'El pedido debe estar recogido para poder marcarlo como rechazado' });
    }

    await db.query(
      `UPDATE pedidos SET estado = 'rechazado_en_entrega', entregado_at = now() WHERE id = $1`,
      [req.params.id]
    );
    if (motivo) {
      await db.query(
        `INSERT INTO reclamos (pedido_id, motivo, descripcion) VALUES ($1,$2,$3)`,
        [req.params.id, 'otro', `Rechazado por el cliente en la entrega: ${motivo}`]
      );
    }

    res.json({ mensaje: 'Pedido marcado como rechazado por el cliente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el rechazo' });
  }
});

// ---------- COMPARTIR UBICACION EN VIVO (mientras esta "recogido") ----------
router.post('/pedidos/:id/ubicacion', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Ubicacion invalida' });
    }
    const { rows } = await db.query('SELECT estado FROM pedidos WHERE id = $1 AND repartidor_id = $2', [req.params.id, req.auth.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.estado !== 'recogido') {
      return res.status(400).json({ error: 'Solo se comparte ubicacion mientras el pedido esta en camino' });
    }
    await db.query(
      `UPDATE pedidos SET lat_repartidor = $1, lng_repartidor = $2, ubicacion_actualizada_at = now() WHERE id = $3`,
      [lat, lng, req.params.id]
    );
    res.json({ mensaje: 'Ubicacion actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la ubicacion' });
  }
});

// ---------- OBSERVACION (tienda entrego mal / cliente se porto mal) ----------
// Queda pendiente de revision: el admin confirma antes de que cuente
// oficialmente (ej. antes de sumar al historial de incidentes del cliente).
const TIPOS_OBSERVACION = ['entrega_incorrecta', 'producto_danado', 'falta_respeto', 'acoso', 'otro'];

router.post('/pedidos/:id/observacion', async (req, res) => {
  try {
    const { dirigido_a, tipo, descripcion } = req.body;
    if (!['tienda', 'cliente'].includes(dirigido_a)) {
      return res.status(400).json({ error: 'dirigido_a debe ser "tienda" o "cliente"' });
    }
    if (!TIPOS_OBSERVACION.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de observacion invalido' });
    }
    const { rows } = await db.query('SELECT id FROM pedidos WHERE id = $1 AND repartidor_id = $2', [req.params.id, req.auth.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });

    const { rows: creado } = await db.query(
      `INSERT INTO observaciones_repartidor (pedido_id, repartidor_id, dirigido_a, tipo, descripcion)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [req.params.id, req.auth.id, dirigido_a, tipo, descripcion || null]
    );
    res.status(201).json({ ...creado[0], mensaje: 'Observación registrada. Un administrador la revisará.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la observación' });
  }
});

// ---------- ENCUESTA DE ENTREGA (obligatoria tras cada entrega, con o sin codigo) ----------
router.post('/pedidos/:id/encuesta', async (req, res) => {
  try {
    const { cliente_amable, hubo_problema, comentario } = req.body;
    const { rows } = await db.query(
      'SELECT estado FROM pedidos WHERE id = $1 AND repartidor_id = $2',
      [req.params.id, req.auth.id]
    );
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.estado !== 'entregado') {
      return res.status(400).json({ error: 'Solo se responde la encuesta despues de entregar el pedido' });
    }
    await db.query(
      `INSERT INTO encuestas_entrega (pedido_id, repartidor_id, cliente_amable, hubo_problema, comentario)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (pedido_id) DO NOTHING`,
      [req.params.id, req.auth.id, cliente_amable !== false, !!hubo_problema, comentario || null]
    );
    res.status(201).json({ mensaje: 'Gracias, encuesta registrada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la encuesta' });
  }
});

module.exports = router;
