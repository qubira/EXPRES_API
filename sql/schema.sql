-- ============================================================
-- Express Ancon - Esquema de base de datos (PostgreSQL / Neon)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- USUARIOS (clientes; login opcional para ver su historial) ----------
CREATE TABLE IF NOT EXISTS usuarios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        VARCHAR(120) NOT NULL,
  email         VARCHAR(160),
  telefono      VARCHAR(20)  NOT NULL,
  password_hash VARCHAR(255),
  zona          VARCHAR(160),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(160);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS zona VARCHAR(160);
DROP INDEX IF EXISTS idx_usuarios_telefono_unico;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_unico ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_telefono ON usuarios(telefono);

-- ---------- ADMIN (dueño de la plataforma) ----------
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nombre        VARCHAR(120) NOT NULL DEFAULT 'Admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- TIENDAS / AMBULANTES SOCIOS ----------
CREATE TABLE IF NOT EXISTS tiendas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre             VARCHAR(120) NOT NULL,
  categoria          VARCHAR(40)  NOT NULL, -- tipo de negocio: tienda, ferreteria, heladeria, bazar, minimarket, etc
  subcategoria       VARCHAR(100), -- que vende: ropa, helados, libros, bikinis, etc (texto libre)
  descripcion        TEXT,
  logo_url           TEXT,
  contacto_telefono  VARCHAR(20),
  contacto_whatsapp  VARCHAR(20),
  zona               VARCHAR(80), -- ej: "Playa Ancon - Malecon"
  comision_pactada   NUMERIC(5,2) NOT NULL DEFAULT 12.00, -- % comision de la plataforma
  email              VARCHAR(160) UNIQUE,
  password_hash      VARCHAR(255) NOT NULL,
  activo             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS subcategoria VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_tiendas_categoria ON tiendas(categoria);
CREATE INDEX IF NOT EXISTS idx_tiendas_activo ON tiendas(activo);

-- ---------- PRODUCTOS ----------
CREATE TABLE IF NOT EXISTS productos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tienda_id    UUID NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
  nombre       VARCHAR(140) NOT NULL,
  marca        VARCHAR(100),
  descripcion  TEXT,
  categoria    VARCHAR(40) NOT NULL,
  subcategoria VARCHAR(80),
  precio       NUMERIC(10,2) NOT NULL CHECK (precio >= 0),
  unidad       VARCHAR(20) NOT NULL DEFAULT 'unidad',
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  foto_url     TEXT,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS marca VARCHAR(100);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS subcategoria VARCHAR(80);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidad VARCHAR(20) NOT NULL DEFAULT 'unidad';
CREATE INDEX IF NOT EXISTS idx_productos_tienda ON productos(tienda_id);
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria);
CREATE INDEX IF NOT EXISTS idx_productos_subcategoria ON productos(subcategoria);

-- ---------- REPARTIDORES ----------
CREATE TABLE IF NOT EXISTS repartidores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         VARCHAR(120) NOT NULL,
  dni            VARCHAR(15) NOT NULL UNIQUE,
  telefono       VARCHAR(20) NOT NULL,
  email          VARCHAR(160) UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  disponible     BOOLEAN NOT NULL DEFAULT true,
  pago_pendiente NUMERIC(10,2) NOT NULL DEFAULT 0, -- tarifas acumuladas por pagar al repartidor
  activo         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- PEDIDOS ----------
-- estado: pendiente_pago -> pagado -> preparando -> listo_recoger -> recogido -> entregado
--         (o cancelado / pago_rechazado en cualquier punto antes de recogido)
CREATE TABLE IF NOT EXISTS pedidos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id         UUID REFERENCES usuarios(id),
  cliente_nombre     VARCHAR(120) NOT NULL,
  cliente_telefono   VARCHAR(20) NOT NULL,
  zona_entrega       VARCHAR(160) NOT NULL, -- ej: "Playa Ancon, sombrilla azul #12"
  referencia_entrega TEXT,
  estado             VARCHAR(20) NOT NULL DEFAULT 'pendiente_pago',
  monto_productos    NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_fee       NUMERIC(10,2) NOT NULL DEFAULT 5.00,
  comision_total     NUMERIC(10,2) NOT NULL DEFAULT 0, -- suma de comisiones de todas las tiendas del pedido
  monto_total        NUMERIC(10,2) NOT NULL DEFAULT 0, -- monto_productos + delivery_fee
  pin_entrega        CHAR(4) NOT NULL,
  repartidor_id      UUID REFERENCES repartidores(id),
  asignado_at        TIMESTAMPTZ,
  recogido_at        TIMESTAMPTZ,
  entregado_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_estado CHECK (estado IN (
    'pendiente_pago','pago_rechazado','pagado','preparando',
    'listo_recoger','recogido','entregado','cancelado'
  ))
);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_repartidor ON pedidos(repartidor_id);

-- ---------- ITEMS DE PEDIDO (permite carrito multi-tienda) ----------
CREATE TABLE IF NOT EXISTS pedido_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id      UUID NOT NULL REFERENCES productos(id),
  tienda_id        UUID NOT NULL REFERENCES tiendas(id),
  nombre_producto  VARCHAR(140) NOT NULL, -- snapshot al momento de compra
  precio_unitario  NUMERIC(10,2) NOT NULL,
  cantidad         INTEGER NOT NULL CHECK (cantidad > 0),
  subtotal         NUMERIC(10,2) NOT NULL,
  comision_pct     NUMERIC(5,2) NOT NULL, -- snapshot de la comision pactada
  comision_monto   NUMERIC(10,2) NOT NULL,
  estado_tienda    VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- pendiente -> preparando -> listo
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido ON pedido_items(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_items_tienda ON pedido_items(tienda_id);

-- ---------- PAGOS ----------
CREATE TABLE IF NOT EXISTS pagos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo            VARCHAR(20) NOT NULL, -- yape, plin, tarjeta
  estado          VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- pendiente, confirmado, rechazado
  comprobante_url TEXT, -- captura de pantalla (Yape/Plin)
  referencia      VARCHAR(120),
  confirmado_por  UUID REFERENCES admin_users(id),
  confirmado_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pago_estado CHECK (estado IN ('pendiente','confirmado','rechazado'))
);
CREATE INDEX IF NOT EXISTS idx_pagos_pedido ON pagos(pedido_id);

-- Trigger simple para updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tiendas_updated ON tiendas;
CREATE TRIGGER trg_tiendas_updated BEFORE UPDATE ON tiendas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_productos_updated ON productos;
CREATE TRIGGER trg_productos_updated BEFORE UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_pedidos_updated ON pedidos;
CREATE TRIGGER trg_pedidos_updated BEFORE UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
