// Consulta de datos de Migraciones (Carne de Extranjeria) via VerificaID.
// La API key vive solo en el servidor (VERIFICAID_API_KEY); nunca se expone al frontend.

async function consultarCe(numero, fechaNacimiento) {
  const resp = await fetch('https://api.verifica.id/v2/consulta/extranjeros', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VERIFICAID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ document_number: numero, birthdate: fechaNacimiento }),
  });

  const data = await resp.json().catch(() => null);

  if (resp.status === 402) {
    const err = new Error('La cuenta de VerificaID no tiene créditos disponibles');
    err.status = 402;
    throw err;
  }
  if (resp.status === 404 || (data && data.status === 404)) return null;
  if (!resp.ok) {
    const err = new Error((data && data.message) || 'No se pudo consultar el CE en este momento');
    err.status = resp.status === 429 ? 429 : 502;
    throw err;
  }

  const info = data && data.data;
  if (!info) return null;
  const nombre = [info.nombres, info.apellido_paterno, info.apellido_materno].filter(Boolean).join(' ');
  return { nombre: nombre || null, nacionalidad: info.nacionalidad || null };
}

module.exports = { consultarCe };
