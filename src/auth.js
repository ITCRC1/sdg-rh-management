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
const MAX_INTENTOS = 8;
const BLOQUEO_MINUTOS = 15;

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
            u.propiedad_id, u.rol, u.activo, u.debe_cambiar_password
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

async function marcarIntentoFallido(usuarioId) {
  const { rows } = await query(
    `UPDATE usuarios
        SET intentos_fallidos = intentos_fallidos + 1,
            bloqueado_hasta = CASE
              WHEN intentos_fallidos + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
              ELSE bloqueado_hasta END
      WHERE id = $1
      RETURNING intentos_fallidos, bloqueado_hasta`,
    [usuarioId, MAX_INTENTOS, String(BLOQUEO_MINUTOS)]
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
//   jefatura     como colaborador (solo lectura), MÁS puede aprobar/editar/
//                rechazar horas extra — pero SOLO las de su propio equipo
//                (los empleados cuyo puesto tiene como Jefatura inmediata el
//                puesto que ocupa esta cuenta, en usuarios.puesto). Ese
//                alcance no lo decide este archivo: lo aplica rutas-datos.js
//                clave por clave, porque requiere resolver empleado→puesto.
//   colaborador  solo lectura, solo su propiedad
//
// Estas comprobaciones son las que de verdad mandan. Que el front esconda
// botones es comodidad visual: quien manipule la petición choca aquí.
// --------------------------------------------------------------------------
const ROLES = ["master", "gerente", "jefatura", "colaborador"];
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

// Bloquea a los colaboradores en todo lo que modifique o suba algo.
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
  crearSesion,
  buscarSesion,
  revocarSesion,
  revocarSesionesDe,
  registrarAcceso,
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
  MAX_INTENTOS,
};
