require('dotenv').config();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function main() {
  console.log('Aplicando esquema (schema.sql)...');
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'schema.sql'), 'utf8');
  await db.query(schema);

  console.log('Creando usuario admin...');
  const adminPass = await bcrypt.hash('admin123', 10);
  await db.query(
    `INSERT INTO admin_users (email, password_hash, nombre)
     VALUES ('admin@express-ancon.pe', $1, 'Administrador Express')
     ON CONFLICT (email) DO NOTHING`,
    [adminPass]
  );

  console.log('Creando tiendas de ejemplo...');
  const tiendaPass = await bcrypt.hash('tienda123', 10);
  const tiendas = [
    ['Anticuchos Doña Rosa', 'comida', 'Los mejores anticuchos y choripan de la playa', '987111222', '987111222', 'Playa Ancon - Malecon Sur', 12, 'rosa@express-ancon.pe'],
    ['Bebidas El Coco Frio', 'bebidas', 'Jugos, cocteles sin alcohol, agua y gaseosas heladas', '987222333', '987222333', 'Playa Ancon - Zona Muelle', 10, 'coco@express-ancon.pe'],
    ['Ropa de Playa Sol y Mar', 'ropa', 'Trajes de baño, pareos y sombreros', '987333444', '987333444', 'Playa Ancon - Malecon Norte', 15, 'solymar@express-ancon.pe'],
    ['Sombrillas y Camas Ancon', 'servicios', 'Alquiler de sombrillas, camas y coolers', '987444555', '987444555', 'Playa Ancon - Frente al mar', 10, 'sombrillas@express-ancon.pe'],
  ];
  const tiendaIds = [];
  for (const t of tiendas) {
    const { rows } = await db.query(
      `INSERT INTO tiendas (nombre, categoria, descripcion, contacto_telefono, contacto_whatsapp, zona, comision_pactada, email, password_hash, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING id`,
      [...t, tiendaPass]
    );
    tiendaIds.push(rows[0].id);
  }

  console.log('Creando productos de ejemplo...');
  // [tienda, nombre, marca, descripcion, categoria, subcategoria, precio, unidad, stock]
  const productos = [
    [tiendaIds[0], 'Anticucho x3 palitos', null, 'Con papa y choclo', 'comida', 'anticuchos', 18.0, 'unidad', 30],
    [tiendaIds[0], 'Choripan', null, 'Chorizo parrillero con pan artesanal', 'comida', 'parrilla', 12.0, 'unidad', 25],
    [tiendaIds[1], 'Jugo de maracuya 1L', 'Natural', 'Recien exprimido', 'bebidas', 'jugos', 10.0, 'l', 40],
    [tiendaIds[1], 'Agua mineral 625ml', 'San Luis', 'Bien helada', 'bebidas', 'agua', 3.5, 'ml', 100],
    [tiendaIds[2], 'Traje de baño mujer', null, 'Varios modelos y tallas', 'ropa', 'trajes de baño', 45.0, 'unidad', 15],
    [tiendaIds[2], 'Sombrero de paja', null, 'Proteccion UV', 'ropa', 'sombreros', 25.0, 'unidad', 20],
    [tiendaIds[3], 'Alquiler sombrilla (dia)', null, 'Incluye instalacion', 'servicios', 'sombrillas', 20.0, 'unidad', 10],
    [tiendaIds[3], 'Alquiler cama playera (dia)', null, 'Con toalla', 'servicios', 'camas', 15.0, 'unidad', 15],
  ];
  for (const p of productos) {
    await db.query(
      `INSERT INTO productos (tienda_id, nombre, marca, descripcion, categoria, subcategoria, precio, unidad, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      p
    );
  }

  console.log('Creando repartidor de ejemplo...');
  const repPass = await bcrypt.hash('reparto123', 10);
  await db.query(
    `INSERT INTO repartidores (nombre, dni, telefono, email, password_hash)
     VALUES ('Carlos Bike', '45678912', '987555666', 'carlos@express-ancon.pe', $1)
     ON CONFLICT (dni) DO NOTHING`,
    [repPass]
  );

  console.log('\nListo. Credenciales de prueba:');
  console.log('  Admin      -> admin@express-ancon.pe / admin123');
  console.log('  Tienda     -> rosa@express-ancon.pe / tienda123 (y las demas tiendas de ejemplo)');
  console.log('  Repartidor -> carlos@express-ancon.pe / reparto123');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error en seed:', err);
  process.exit(1);
});
