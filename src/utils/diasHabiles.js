// Lunes a viernes cuentan, sabado y domingo no.
function agregarDiasHabiles(desde, dias) {
  const fecha = new Date(desde);
  let agregados = 0;
  while (agregados < dias) {
    fecha.setDate(fecha.getDate() + 1);
    const diaSemana = fecha.getDay(); // 0 = domingo, 6 = sabado
    if (diaSemana !== 0 && diaSemana !== 6) agregados++;
  }
  return fecha;
}

function diasHabilesRestantes(hasta) {
  if (!hasta) return null;
  const fin = new Date(hasta);
  const ahora = new Date();
  if (fin <= ahora) return 0;
  let dias = 0;
  const cursor = new Date(ahora);
  while (cursor < fin) {
    cursor.setDate(cursor.getDate() + 1);
    const diaSemana = cursor.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) dias++;
  }
  return dias;
}

module.exports = { agregarDiasHabiles, diasHabilesRestantes };
