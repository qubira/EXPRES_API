const db = require('../db');

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

module.exports = { verificarEstadoCuenta };
