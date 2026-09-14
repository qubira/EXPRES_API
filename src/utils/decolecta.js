// Consulta de datos RENIEC (DNI) via Decolecta.
// La API key vive solo en el servidor (DECOLECTA_API_KEY); nunca se expone al frontend.

async function consultarDni(numero) {
  const resp = await fetch(`https://api.decolecta.com/v1/reniec/dni?numero=${numero}`, {
    headers: { Authorization: `Bearer ${process.env.DECOLECTA_API_KEY}` },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const err = new Error('No se pudo consultar el DNI en este momento');
    err.status = resp.status === 429 ? 429 : 502;
    throw err;
  }

  const data = await resp.json();
  return { nombre: data.full_name || null };
}

module.exports = { consultarDni };
