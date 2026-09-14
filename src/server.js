require('dotenv').config();
const express = require('express');
const cors = require('cors');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const tiendaRoutes = require('./routes/tienda');
const repartidorRoutes = require('./routes/repartidor');
const clienteRoutes = require('./routes/cliente');

const app = express();
app.set('trust proxy', true); // Render esta detras de un proxy; necesario para leer la IP real del cliente

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('No permitido por CORS'));
  },
}));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ ok: true, servicio: 'Express Ancon API', version: '1.0.0' });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tienda', tiendaRoutes);
app.use('/api/repartidor', repartidorRoutes);
app.use('/api/cliente', clienteRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Recurso no encontrado' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Express Ancon API escuchando en puerto ${PORT}`);
});
