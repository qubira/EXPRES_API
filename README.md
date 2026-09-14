# Express Ancón — API

Backend en Node.js + Express + PostgreSQL (Neon), pensado para desplegarse en **Render**.

## 1. Configurar la base de datos (Neon) y el almacenamiento de imágenes (Cloudinary)

1. Crea una cuenta en [neon.tech](https://neon.tech) y un proyecto nuevo (ej. `express-ancon`).
2. Copia la cadena de conexión (`postgresql://usuario:password@ep-xxxx.neon.tech/dbname?sslmode=require`).
3. Crea una cuenta en [cloudinary.com](https://cloudinary.com) y copia tu `Cloud name`, `API Key` y `API Secret` desde **Settings > API Keys**.
4. Copia `.env.example` a `.env` y completa `DATABASE_URL` y las variables `CLOUDINARY_*`.

## 2. Instalar dependencias y sembrar datos

```bash
npm install
npm run seed     # crea las tablas (sql/schema.sql) + admin, tiendas y repartidor de prueba
```

Credenciales de prueba tras el seed:

| Rol | Email | Password |
|---|---|---|
| Admin | admin@express-ancon.pe | admin123 |
| Tienda (ejemplo) | rosa@express-ancon.pe | tienda123 |
| Repartidor (ejemplo) | carlos@express-ancon.pe | reparto123 |

**Cambia estas contraseñas antes de ir a producción** (desde el panel admin, o con `npm run hash "nuevaPassword"` + un UPDATE directo).

## 3. Correr en local

```bash
npm run dev       # http://localhost:4000
```

## 4. Desplegar en Render

1. Sube esta carpeta como el repositorio Git dedicado a la API (Root Directory = raíz del repo).
2. En Render: **New > Web Service**, conecta el repo, y configura:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** agrega `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN` (dominio de Vercel), `DELIVERY_FEE_DEFAULT`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
3. Una vez desplegado, corre el seed una sola vez apuntando `DATABASE_URL` de Neon (puedes correrlo desde tu máquina local con el `.env` apuntando a Neon, no hace falta hacerlo desde Render).
4. Copia la URL pública de Render (ej. `https://express-ancon-api.onrender.com`) — la necesitarás en el frontend (`WEB/js/config.js`).

## Notas importantes

- **Comprobantes de pago y fotos de productos**: se suben directo a Cloudinary (no se guardan en disco), así que no dependen del almacenamiento efímero de Render.
- **CORS**: `CORS_ORIGIN` debe incluir el dominio exacto de Vercel (con `https://`), separado por comas si hay varios (ej. preview + producción).
- **PIN de entrega**: se genera automáticamente al crear el pedido, pero solo se revela al cliente cuando el pago es confirmado por el admin.
