// Consulta de Carne de Extranjeria via json.pe (plan gratuito: 100 creditos / 30 dias).
// La API key vive solo en el servidor (JSONPE_API_KEY); nunca se expone al frontend.

async function consultarCe(numero) {
  const resp = await fetch('https://api.json.pe/api/ce', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.JSONPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ce: numero }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || !data || data.success === false) {
    if (resp.status === 404 || (data && /no encontr/i.test(data.message || ''))) return null;
    const err = new Error((data && data.message) || 'No se pudo consultar el CE en este momento');
    err.status = resp.status === 429 ? 429 : resp.status === 402 ? 402 : 502;
    throw err;
  }

  const info = data.data;
  if (!info) return null;
  const nombre = [info.nombres, info.apellido_paterno, info.apellido_materno].filter(Boolean).join(' ');
  return { nombre: nombre || null };
}

module.exports = { consultarCe };
