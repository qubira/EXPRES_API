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

-- ---------- LISTAS CONFIGURABLES (tipo de negocio y zonas de entrega) ----------
-- Se pueden ampliar desde el panel de tienda/admin con un boton "+" cuando
-- la opcion que necesitan no esta en la lista.
CREATE TABLE IF NOT EXISTS tipos_negocio (
  id         SERIAL PRIMARY KEY,
  clave      VARCHAR(60) UNIQUE NOT NULL,
  etiqueta   VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO tipos_negocio (clave, etiqueta) VALUES
  ('tienda', 'Tienda'), ('minimarket', 'Minimarket'), ('bazar', 'Bazar'),
  ('ferreteria', 'Ferretería'), ('heladeria', 'Heladería'), ('restaurante', 'Restaurante'),
  ('ambulante', 'Ambulante'), ('boutique', 'Boutique / Ropa'), ('artesanias', 'Artesanías'),
  ('servicios_playa', 'Servicios de playa'), ('otro', 'Otro')
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS zonas (
  id         SERIAL PRIMARY KEY,
  nombre     VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO zonas (nombre) VALUES
  ('Playa Ancón - Malecón Sur'), ('Playa Ancón - Malecón Norte'),
  ('Playa Ancón - Zona Muelle'), ('Playa Ancón - Frente al mar')
ON CONFLICT (nombre) DO NOTHING;

-- ---------- AUDITORIA (control de conexiones: quien entro, desde que IP) ----------
CREATE TABLE IF NOT EXISTS auditoria (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rol            VARCHAR(20) NOT NULL, -- admin | tienda | repartidor
  referencia_id  UUID, -- id de la cuenta (null si el login fallo por credenciales invalidas)
  nombre         VARCHAR(160), -- nombre o email usado en el intento
  accion         VARCHAR(30) NOT NULL, -- login_ok | login_fallido
  ip             VARCHAR(64),
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_created_at ON auditoria(created_at DESC);

-- ---------- SESIONES (conectividad: quien esta conectado, permite cerrar otras) ----------
CREATE TABLE IF NOT EXISTS sesiones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rol              VARCHAR(20) NOT NULL, -- admin | tienda | repartidor | cliente
  referencia_id    UUID NOT NULL,
  ip               VARCHAR(64),
  user_agent       TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  activa           BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_sesiones_cuenta ON sesiones(rol, referencia_id);

-- ---------- TIENDAS / AMBULANTES SOCIOS ----------
CREATE TABLE IF NOT EXISTS tiendas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre             VARCHAR(120) NOT NULL,
  categoria          VARCHAR(40)  NOT NULL, -- tipo de negocio: tienda, ferreteria, heladeria, bazar, minimarket, etc
  subcategoria       VARCHAR(100), -- que vende: ropa, helados, libros, bikinis, etc (texto libre)
  descripcion        TEXT,
  logo_url           TEXT,
  dni_titular        VARCHAR(20), -- DNI del titular/responsable del negocio
  nombre_titular     VARCHAR(150), -- nombre completo del titular (autocompletado via RENIEC)
  contacto_telefono  VARCHAR(20),
  contacto_whatsapp  VARCHAR(20),
  zona               VARCHAR(80), -- ej: "Playa Ancon - Malecon"
  direccion          TEXT, -- direccion del local fisico (ej. restaurantes con mesas para comer ahi)
  comision_pactada   NUMERIC(5,2) NOT NULL DEFAULT 12.00, -- % comision de la plataforma
  email              VARCHAR(160) UNIQUE,
  password_hash      VARCHAR(255) NOT NULL,
  activo             BOOLEAN NOT NULL DEFAULT true, -- activacion/baja: la controla el administrador
  disponible         BOOLEAN NOT NULL DEFAULT true, -- pausa temporal: la controla la propia tienda
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS subcategoria VARCHAR(100);
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS dni_titular VARCHAR(20);
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS nombre_titular VARCHAR(150);
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS disponible BOOLEAN NOT NULL DEFAULT true;
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
  contenido    NUMERIC(10,2), -- cantidad numerica de la unidad, ej: 500 (g), 1.5 (L), 6 (unidades por paquete)
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  foto_url     TEXT,
  activo       BOOLEAN NOT NULL DEFAULT true,
  vistas       INTEGER NOT NULL DEFAULT 0, -- veces que se abrio la ficha del producto
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS marca VARCHAR(100);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS subcategoria VARCHAR(80);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidad VARCHAR(20) NOT NULL DEFAULT 'unidad';
ALTER TABLE productos ADD COLUMN IF NOT EXISTS contenido NUMERIC(10,2);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS vistas INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_productos_tienda ON productos(tienda_id);
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria);
CREATE INDEX IF NOT EXISTS idx_productos_subcategoria ON productos(subcategoria);

-- ---------- REPARTIDORES ----------
CREATE TABLE IF NOT EXISTS repartidores (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                      VARCHAR(120) NOT NULL,
  dni                         VARCHAR(15) NOT NULL UNIQUE, -- numero de DNI o de CE, segun tipo_documento
  tipo_documento              VARCHAR(10) NOT NULL DEFAULT 'dni', -- dni (peruano) | ce (extranjero)
  nacionalidad                VARCHAR(60) DEFAULT 'Peruana',
  edad                        INTEGER,
  telefono                    VARCHAR(20) NOT NULL,
  direccion                   TEXT,
  contacto_emergencia_nombre  VARCHAR(120),
  contacto_emergencia_telefono VARCHAR(20),
  antecedentes_penales        BOOLEAN,
  foto_url                    TEXT,
  email                       VARCHAR(160) UNIQUE,
  password_hash               VARCHAR(255) NOT NULL,
  disponible                  BOOLEAN NOT NULL DEFAULT true,
  pago_pendiente              NUMERIC(10,2) NOT NULL DEFAULT 0, -- tarifas acumuladas por pagar al repartidor
  activo                      BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(10) NOT NULL DEFAULT 'dni';
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS nacionalidad VARCHAR(60) DEFAULT 'Peruana';
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS edad INTEGER;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS contacto_emergencia_nombre VARCHAR(120);
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS contacto_emergencia_telefono VARCHAR(20);
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS antecedentes_penales BOOLEAN;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS foto_url TEXT;

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
  lat_entrega            NUMERIC(10,7), -- ubicacion que marco el cliente en el checkout
  lng_entrega            NUMERIC(10,7),
  lat_repartidor         NUMERIC(10,7), -- ultima posicion GPS del repartidor (solo mientras esta "recogido")
  lng_repartidor         NUMERIC(10,7),
  ubicacion_actualizada_at TIMESTAMPTZ,
  entrega_observada      BOOLEAN NOT NULL DEFAULT false, -- se entrego sin validar el PIN correctamente
  pago_retenido          BOOLEAN NOT NULL DEFAULT false, -- pago del repartidor pendiente de revision del admin
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_estado CHECK (estado IN (
    'pendiente_pago','pago_rechazado','pagado','preparando',
    'listo_recoger','recogido','entregado','cancelado','rechazado_en_entrega'
  ))
);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_repartidor ON pedidos(repartidor_id);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS lat_entrega NUMERIC(10,7);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS lng_entrega NUMERIC(10,7);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS lat_repartidor NUMERIC(10,7);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS lng_repartidor NUMERIC(10,7);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ubicacion_actualizada_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_observada BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_retenido BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS chk_estado;
ALTER TABLE pedidos ADD CONSTRAINT chk_estado CHECK (estado IN (
  'pendiente_pago','pago_rechazado','pagado','preparando',
  'listo_recoger','recogido','entregado','cancelado','rechazado_en_entrega'
));

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
  estado_tienda    VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- pendiente -> confirmado -> listo
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido ON pedido_items(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_items_tienda ON pedido_items(tienda_id);

-- ---------- RECLAMOS (quejas del cliente sobre un pedido) ----------
CREATE TABLE IF NOT EXISTS reclamos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id    UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  usuario_id   UUID REFERENCES usuarios(id),
  motivo       VARCHAR(40) NOT NULL, -- producto_incorrecto | producto_danado | no_recibido | otro
  descripcion  TEXT,
  estado       VARCHAR(20) NOT NULL DEFAULT 'abierto', -- abierto | en_revision | resuelto
  resolucion   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reclamos_pedido ON reclamos(pedido_id);
CREATE INDEX IF NOT EXISTS idx_reclamos_estado ON reclamos(estado);

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
