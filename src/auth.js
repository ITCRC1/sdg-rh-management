"use strict";
// Contraseñas y sesiones.
//
// Hash con scrypt del módulo `crypto` de Node — no hace falta bcrypt/argon2:
// scrypt es de la misma familia (memory-hard) y viene en la biblioteca
// estándar, así que no agrega dependencias nativas que compilar en el deploy.
//
// Las sesiones viven en Postgres, no en un JWT. Un JWT no se puede revocar
// antes de que expire; aquí desactivar a alguien lo saca de inmediato, que es
// justo lo que se necesita cuando una persona deja la empresa.

const crypto = require("crypto");
const { query } = require("./db");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const DURACION_SESION_HORAS = Number(process.env.SESION_HORAS) || 12;

// --------------------------------------------------------------------------
// Contraseñas
// --------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

function verificarPassword(password, almacenado) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(almacenado).split("$");
    if (alg !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const esperado = Buffer.from(hashB64, "base64");
    const calculado = crypto.scryptSync(password, salt, esperado.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    // Comparación en tiempo constante: no filtra cuántos bytes coincidieron.
    return crypto.timingSafeEqual(esperado, calculado);
  } catch (e) {
    return false;
  }
}

function validarPassword(password) {
  if (typeof password !== "string" || password.length < 10) {
    return "La contraseña debe tener al menos 10 caracteres.";
  }
  if (password.length > 200) return "La contraseña es demasiado larga.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "La contraseña debe combinar letras y números.";
  }
  return null;
}

// --------------------------------------------------------------------------
// Credenciales autogeneradas para el alta automática del rol "empleado"
//
// Usuario = primera letra del nombre (mayúscula) + primer apellido completo.
// Clave temporal = número de empleado (planilla), con ceros a la izquierda.
// La clave resultante (solo dígitos) a propósito NO pasa por validarPassword
// — es de un solo uso, forzada a cambiar en el primer ingreso
// (debe_cambiar_password = true), no una clave elegida por una persona.
// --------------------------------------------------------------------------
function limpiarParaUsuario(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]/g, "");
}

function generarUsuarioEmpleado(nombre, apellidos) {
  const inicial = limpiarParaUsuario(nombre).slice(0, 1).toUpperCase();
  const primerApellido = limpiarParaUsuario(String(apellidos || "").trim().split(/\s+/)[0]);
  if (!inicial || !primerApellido) return "";
  return inicial + primerApellido.charAt(0).toUpperCase() + primerApellido.slice(1).toLowerCase();
}

function generarClaveTemporalEmpleado(numeroEmpleado) {
  return String(numeroEmpleado || "").replace(/\D/g, "").padStart(8, "0");
}

// --------------------------------------------------------------------------
// Sesiones
// --------------------------------------------------------------------------
// En la BD se guarda solo el hash del token. Si alguien lograra leer la tabla
// `sesiones`, no obtendría tokens usables.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function crearSesion(usuarioId, ip, userAgent) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = new Date(Date.now() + DURACION_SESION_HORAS * 3600 * 1000);
  await query(
    `INSERT INTO sesiones (token_hash, usuario_id, expira_en, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), usuarioId, expira, ip || null, (userAgent || "").slice(0, 500)]
  );
  return { token, expira };
}

async function buscarSesion(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT s.token_hash, s.expira_en,
            u.id, u.email, u.nombre, u.cedula, u.puesto,
            u.propiedad_id, u.rol, u.activo, u.debe_cambiar_password, u.empleado_clave,
            u.puede_firmar_contratos
       FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash = $1
        AND s.revocada_en IS NULL
        AND s.expira_en > now()`,
    [hashToken(token)]
  );
  const s = rows[0];
  if (!s) return null;
  // Desactivar a alguien invalida su sesión en el acto, sin esperar a que expire.
  if (!s.activo) return null;
  return s;
}

async function revocarSesion(token) {
  if (!token) return;
  await query(
    "UPDATE sesiones SET revocada_en = now() WHERE token_hash = $1 AND revocada_en IS NULL",
    [hashToken(token)]
  );
}

async function revocarSesionesDe(usuarioId) {
  await query(
    "UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND revocada_en IS NULL",
    [usuarioId]
  );
}

async function tocarSesion(tokenHash) {
  query("UPDATE sesiones SET ultima_vez = now() WHERE token_hash = $1", [tokenHash]).catch(
    () => {}
  );
}

// --------------------------------------------------------------------------
// Bitácora e intentos fallidos
// --------------------------------------------------------------------------
async function registrarAcceso({ email, usuarioId, evento, exito, detalle, ip, userAgent }) {
  try {
    await query(
      `INSERT INTO bitacora_accesos (email, usuario_id, evento, exito, detalle, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        email || null,
        usuarioId || null,
        evento,
        !!exito,
        detalle || null,
        ip || null,
        (userAgent || "").slice(0, 500),
      ]
    );
  } catch (e) {
    console.error("No se pudo escribir en bitácora:", e.message);
  }
}

const BITACORA_DIAS_RETENCION = 30;

// El panel de Empleador solo muestra los últimos 5 eventos (ver
// GET /api/auth/bitacora) — el resto se guarda igual, pero solo por un mes:
// pasado ese tiempo se borra sola. No hace falta consultarla más atrás de
// eso, y no tiene sentido acumular un historial de accesos indefinido.
async function limpiarBitacoraVieja() {
  try {
    const { rowCount } = await query(
      `DELETE FROM bitacora_accesos WHERE creado_en < now() - ($1 || ' days')::interval`,
      [String(BITACORA_DIAS_RETENCION)]
    );
    if (rowCount) console.log(`Bitácora: se borraron ${rowCount} evento(s) de más de ${BITACORA_DIAS_RETENCION} días.`);
  } catch (e) {
    console.error("No se pudo limpiar la bitácora vieja:", e.message);
  }
}

const DIAS_GRACIA_ARCHIVADO = 90;

// Cuando RRHH archiva a alguien (salida de la empresa), su cuenta de acceso
// (rol "empleado") sigue activa 3 meses — por si necesita bajar alguna
// colilla o documento propio antes de irse del todo — y pasado ese tiempo se
// desactiva sola (nunca se borra: sigue siendo reactivable a mano desde el
// panel de Empleador, igual que cualquier otra cuenta desactivada). Si
// alguien vuelve a activar el expediente antes de esos 3 meses
// (reactivarEmpleado en el front), la cuenta se reactiva sola en el mismo
// guardado — ver sincronizarCuentaEmpleado en rutas-datos.js.
async function archivarUsuariosDeEmpleadosVencidos() {
  try {
    const { rows } = await query(
      `SELECT propiedad_id, clave, valor_json->>'FECHA_ARCHIVADO' AS fecha_archivado
         FROM documentos
        WHERE tipo = 'cat_empleado' AND eliminado_en IS NULL
          AND valor_json->>'ARCHIVADO' = 'true'`
    );
    const ahora = Date.now();
    let desactivadas = 0;
    for (const fila of rows) {
      // FECHA_ARCHIVADO se guarda como texto "DD/MM/AAAA" (ver
      // confirmarArchivarEmpleado en app.js, fmtFecha), no ISO.
      const partes = String(fila.fecha_archivado || "").split("/");
      if (partes.length !== 3) continue;
      const fechaArchivado = new Date(Number(partes[2]), Number(partes[1]) - 1, Number(partes[0]));
      if (Number.isNaN(fechaArchivado.getTime())) continue;

      const diasTranscurridos = (ahora - fechaArchivado.getTime()) / 86400000;
      if (diasTranscurridos < DIAS_GRACIA_ARCHIVADO) continue;

      const actualizado = await query(
        `UPDATE usuarios SET activo = false, desactivado_en = now()
          WHERE propiedad_id = $1 AND empleado_clave = $2 AND rol = 'empleado' AND activo = true
          RETURNING id`,
        [fila.propiedad_id, fila.clave]
      );
      if (actualizado.rows[0]) {
        await revocarSesionesDe(actualizado.rows[0].id);
        desactivadas++;
      }
    }
    if (desactivadas) console.log(`Cuentas de empleado: se desactivaron ${desactivadas} por llevar más de ${DIAS_GRACIA_ARCHIVADO} días archivadas.`);
  } catch (e) {
    console.error("No se pudo revisar las cuentas de empleados archivados:", e.message);
  }
}

// Sin bloqueo temporal a propósito (se quitó a pedido) — solo cuenta los
// intentos fallidos para la bitácora, nunca pone bloqueado_hasta ni impide
// el siguiente intento.
async function marcarIntentoFallido(usuarioId) {
  const { rows } = await query(
    `UPDATE usuarios
        SET intentos_fallidos = intentos_fallidos + 1
      WHERE id = $1
      RETURNING intentos_fallidos, bloqueado_hasta`,
    [usuarioId]
  );
  return rows[0];
}

async function limpiarIntentos(usuarioId) {
  await query(
    `UPDATE usuarios
        SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = now()
      WHERE id = $1`,
    [usuarioId]
  );
}

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------
function leerCookie(req, nombre) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const parte of raw.split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) {
      return decodeURIComponent(parte.slice(i + 1).trim());
    }
  }
  return null;
}

const COOKIE = "sdg_sesion";

function ponerCookie(res, token, expira) {
  const partes = [
    COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=" + expira.toUTCString(),
  ];
  // Railway siempre sirve por HTTPS; en local (http://localhost) Secure
  // impediría que la cookie se guardara.
  if (process.env.NODE_ENV === "production") partes.push("Secure");
  res.setHeader("Set-Cookie", partes.join("; "));
}

function borrarCookie(res) {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function ipDe(req) {
  // Railway va detrás de proxy; el primer valor de X-Forwarded-For es el cliente.
  const xff = req.headers["x-forwarded-for"];
  const ip = xff ? String(xff).split(",")[0].trim() : req.socket?.remoteAddress || "";
  return ip.replace(/^::ffff:/, "") || null;
}

// Exige sesión válida. Deja el usuario en req.usuario.
async function requiereSesion(req, res, next) {
  try {
    const token = leerCookie(req, COOKIE);
    const sesion = await buscarSesion(token);
    if (!sesion) {
      borrarCookie(res);
      return res.status(401).json({ error: "No hay sesión activa.", codigo: "sin_sesion" });
    }
    tocarSesion(sesion.token_hash);
    req.usuario = {
      id: sesion.id,
      email: sesion.email,
      nombre: sesion.nombre,
      cedula: sesion.cedula,
      puesto: sesion.puesto,
      propiedadId: sesion.propiedad_id,
      rol: sesion.rol,
      debeCambiarPassword: sesion.debe_cambiar_password,
      empleadoClave: sesion.empleado_clave,
      puedeFirmarContratos: sesion.puede_firmar_contratos,
      ip: ipDe(req),
    };
    req.sesionToken = token;
    next();
  } catch (e) {
    next(e);
  }
}

// --------------------------------------------------------------------------
// Roles
//
//   master       lee, edita, sube archivos Y administra usuarios (ve todas
//                las propiedades — antes se llamaba 'admin')
//   gerente      lee, edita, sube archivos, solo su propiedad
//   jefatura     solo lectura, MÁS puede aprobar/editar/rechazar horas extra
//                — pero SOLO las de su propio equipo (los empleados cuyo
//                puesto tiene como Jefatura inmediata el puesto que ocupa
//                esta cuenta, en usuarios.puesto). Ese alcance no lo decide
//                este archivo: lo aplica rutas-datos.js clave por clave,
//                porque requiere resolver empleado→puesto.
//   empleado     solo lectura de su PROPIO expediente (no el de los demás,
//                ni el resto de "la página de RH"). La cuenta se crea sola
//                al guardar el empleado en RRHH (ver rutas-datos.js);
//                usuarios.empleado_clave guarda a cuál expediente queda
//                amarrada. Ese alcance tampoco lo decide este archivo: lo
//                aplica rutas-datos.js clave por clave. Es el único rol para
//                trabajadores fuera de RRHH — no existe un rol de solo
//                lectura de TODOS los empleados (se quitó "colaborador" a
//                propósito: nadie ajeno a RRHH/gerencia debía ver el
//                expediente de otros).
//   consultor    cuentas del grupo externo "Consultants" que administra SDG
//                RH Management (RRHH, planillas, contador jefe) — a
//                diferencia de gerente/jefatura/empleado no queda atado a
//                una sola propiedad (propiedad_id puede ser NULL, igual que
//                master: ve cualquiera de las 5). A diferencia de master, NO
//                administra usuarios (requiereAdmin sigue siendo solo
//                master) y es de SOLO LECTURA en todo — planillas,
//                expedientes, datos y documentos de empleados, horas extra
//                y días libres/vacaciones por empleado, incapacidades —
//                nunca crea ni edita nada de eso (no está en
//                PUEDEN_ESCRIBIR). usuarios.puede_firmar_contratos marca,
//                dentro de este rol, a la única cuenta (el contador jefe)
//                que además podrá firmar/rechazar contratos — esa es una
//                capacidad angosta y aparte (bandeja de firma, todavía sin
//                construir), nunca escritura general.
//
// Estas comprobaciones son las que de verdad mandan. Que el front esconda
// botones es comodidad visual: quien manipule la petición choca aquí.
// --------------------------------------------------------------------------
const ROLES = ["master", "gerente", "jefatura", "empleado", "consultor"];
const PUEDEN_ESCRIBIR = new Set(["master", "gerente"]);

function rolValido(rol) {
  return ROLES.includes(rol);
}

function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== "master") {
    return res.status(403).json({
      error: "Requiere permisos de master.",
      codigo: "requiere_admin",
    });
  }
  next();
}

// Bloquea a las cuentas de solo lectura (jefatura, empleado) en todo lo que
// modifique o suba algo — salvo las excepciones puntuales que rutas-datos.js
// resuelve clave por clave (ej. jefatura aprobando horas extra de su equipo).
function requiereEscritura(req, res, next) {
  if (!PUEDEN_ESCRIBIR.has(req.usuario?.rol)) {
    return res.status(403).json({
      error: "Tu cuenta es de solo lectura. Pide a un administrador o gerente que haga este cambio.",
      codigo: "solo_lectura",
    });
  }
  next();
}

// Mientras la contraseña temporal no se cambie, solo se permite cambiarla.
function exigeCambioPassword(req, res, next) {
  if (req.usuario?.debeCambiarPassword) {
    return res.status(403).json({
      error: "Debes cambiar tu contraseña temporal antes de continuar.",
      codigo: "cambio_password_requerido",
    });
  }
  next();
}

module.exports = {
  COOKIE,
  hashPassword,
  verificarPassword,
  validarPassword,
  generarUsuarioEmpleado,
  generarClaveTemporalEmpleado,
  crearSesion,
  buscarSesion,
  revocarSesion,
  revocarSesionesDe,
  registrarAcceso,
  limpiarBitacoraVieja,
  archivarUsuariosDeEmpleadosVencidos,
  marcarIntentoFallido,
  limpiarIntentos,
  leerCookie,
  ponerCookie,
  borrarCookie,
  ipDe,
  requiereSesion,
  requiereAdmin,
  requiereEscritura,
  exigeCambioPassword,
  rolValido,
  ROLES,
  PUEDEN_ESCRIBIR,
};
