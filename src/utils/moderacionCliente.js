const db = require('../db');
const { agregarDiasHabiles } = require('./diasHabiles');

// Umbral de incidentes acumulados antes de actuar automaticamente.
const UMBRAL_INCIDENTES = 3;
const DIAS_SUSPENSION = 5;

// Se llama despues de registrar un nuevo incidente confirmado contra un
// cliente. Si acumula suficientes incidentes: la primera vez lo suspende
// preventivamente 5 dias habiles; si ya habia sido suspendido antes y
// reincide, lo bloquea directamente. Devuelve la accion tomada (o null).
async function evaluarEscalamiento(usuarioId) {
  const { rows } = await db.query('SELECT estado_cuenta, alguna_vez_suspendido FROM usuarios WHERE id = $1', [usuarioId]);
  const usuario = rows[0];
  if (!usuario || usuario.estado_cuenta === 'bloqueado') return null;

  const { rows: countRows } = await db.query('SELECT COUNT(*)::int as total FROM incidentes_cliente WHERE usuario_id = $1', [usuarioId]);
  const total = countRows[0].total;
  if (total < UMBRAL_INCIDENTES) return null;

  if (usuario.alguna_vez_suspendido) {
    await db.query(
      `UPDATE usuarios SET estado_cuenta = 'bloqueado', suspendido_hasta = NULL,
              estado_cuenta_motivo = $1, estado_cuenta_actualizado_at = now()
       WHERE id = $2`,
      [`Bloqueo automático: reincidencia tras suspensión previa (${total} incidentes acumulados)`, usuarioId]
    );
    return 'bloqueado';
  }

  if (usuario.estado_cuenta === 'activo') {
    const hasta = agregarDiasHabiles(new Date(), DIAS_SUSPENSION);
    await db.query(
      `UPDATE usuarios SET estado_cuenta = 'suspendido', suspendido_hasta = $1,
              estado_cuenta_motivo = $2, estado_cuenta_actualizado_at = now(), alguna_vez_suspendido = true
       WHERE id = $3`,
      [hasta, `Suspensión automática: acumuló ${total} incidentes registrados`, usuarioId]
    );
    return 'suspendido';
  }
  return null;
}

// Devuelve null si la cuenta puede iniciar sesion, o un mensaje de error si
// esta bloqueada o suspendida. Si la suspension ya vencio, la reactiva
// automaticamente. Las cuentas nunca se eliminan, solo cambian de estado.
async function verificarEstadoCuenta(usuario) {
  if (usuario.estado_cuenta === 'bloqueado') {
    return 'Tu cuenta fue bloqueada. Si crees que es un error, contáctanos.';
  }
  if (usuario.estado_cuenta === 'suspendido') {
    const hasta = usuario.suspendido_hasta ? new Date(usuario.suspendido_hasta) : null;
    if (hasta && hasta <= new Date()) {
      await db.query(
        `UPDATE usuarios SET estado_cuenta = 'activo', suspendido_hasta = NULL, estado_cuenta_motivo = NULL WHERE id = $1`,
        [usuario.id]
      );
      return null;
    }
    const fechaTexto = hasta ? hasta.toLocaleDateString('es-PE') : 'una fecha por confirmar';
    return `Tu cuenta está suspendida hasta el ${fechaTexto}.`;
  }
  return null;
}

module.exports = { verificarEstadoCuenta, evaluarEscalamiento };
