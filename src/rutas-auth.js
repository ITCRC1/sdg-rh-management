"use strict";
// Rutas de sesión y administración de usuarios.

const express = require("express");
const { query } = require("./db");
const A = require("./auth");

const router = express.Router();

const CAMPOS_PUBLICOS = `id, email, nombre, cedula, puesto, propiedad_id, rol,
  activo, debe_cambiar_password, creado_en, ultimo_acceso, desactivado_en`;

function aUsuario(r) {
  return {
    id: r.id,
    email: r.email,
    nombre: r.nombre,
    cedula: r.cedula,
    puesto: r.puesto,
    propiedadId: r.propiedad_id,
    rol: r.rol,
    activo: r.activo,
    debeCambiarPassword: r.debe_cambiar_password,
    creadoEn: r.creado_en,
    ultimoAcceso: r.ultimo_acceso,
    desactivadoEn: r.desactivado_en,
  };
}

// --------------------------------------------------------------------------
// POST /api/auth/login
// --------------------------------------------------------------------------
router.post("/login", async (req, res, next) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const ip = A.ipDe(req);
  const ua = req.headers["user-agent"];

  // Mensaje único para credenciales malas: no revela si el correo existe.
  const generico = "Correo o contraseña incorrectos.";

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "Completa correo y contraseña." });
    }

    const { rows } = await query(
      `SELECT id, email, nombre, password_hash, activo, rol, propiedad_id,
              debe_cambiar_password, bloqueado_hasta
         FROM usuarios WHERE lower(email) = $1`,
      [email]
    );
    const u = rows[0];

    if (!u) {
      await A.registrarAcceso({ email, evento: "login", exito: false, detalle: "usuario inexistente", ip, userAgent: ua });
      return res.status(401).json({ error: generico });
    }

    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
      await A.registrarAcceso({ email, usuarioId: u.id, evento: "login", exito: false, detalle: "cuenta bloqueada", ip, userAgent: ua });
      return res.status(429).json({
        error: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.",
      });
    }

    if (!A.verificarPassword(password, u.password_hash)) {
      const estado = await A.marcarIntentoFallido(u.id);
      await A.registrarAcceso({ email, usuarioId: u.id, evento: "login", exito: false, detalle: "contraseña incorrecta", ip, userAgent: ua });
      const restantes = Math.max(0, A.MAX_INTENTOS - (estado?.intentos_fallidos || 0));
      return res.status(401).json({
        error: restantes > 0 && restantes <= 3
          ? generico + " Te quedan " + restantes + " intento(s) antes del bloqueo temporal."
          : generico,
      });
    }

    // Se valida DESPUÉS de la contraseña: así una cuenta desactivada no se
    // distingue de una inexistente para quien no sabe la contraseña.
    if (!u.activo) {
      await A.registrarAcceso({ email, usuarioId: u.id, evento: "login", exito: false, detalle: "cuenta desactivada", ip, userAgent: ua });
      return res.status(403).json({ error: "Esta cuenta está desactivada. Contacta al administrador." });
    }

    await A.limpiarIntentos(u.id);
    const { token, expira } = await A.crearSesion(u.id, ip, ua);
    A.ponerCookie(res, token, expira);
    await A.registrarAcceso({ email, usuarioId: u.id, evento: "login", exito: true, ip, userAgent: ua });

    res.json({
      usuario: {
        id: u.id, email: u.email, nombre: u.nombre, rol: u.rol,
        propiedadId: u.propiedad_id, debeCambiarPassword: u.debe_cambiar_password,
      },
    });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// POST /api/auth/logout · GET /api/auth/me
// --------------------------------------------------------------------------
router.post("/logout", async (req, res, next) => {
  try {
    const token = A.leerCookie(req, A.COOKIE);
    const sesion = await A.buscarSesion(token);
    await A.revocarSesion(token);
    A.borrarCookie(res);
    if (sesion) {
      await A.registrarAcceso({
        email: sesion.email, usuarioId: sesion.id, evento: "logout",
        exito: true, ip: A.ipDe(req), userAgent: req.headers["user-agent"],
      });
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get("/me", A.requiereSesion, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT p.id, p.nombre FROM propiedades p WHERE p.id = $1",
      [req.usuario.propiedadId]
    );
    res.json({ usuario: req.usuario, propiedad: rows[0] || null });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// POST /api/auth/password — cambiar la propia contraseña
// --------------------------------------------------------------------------
router.post("/password", A.requiereSesion, async (req, res, next) => {
  try {
    const actual = String(req.body?.actual || "");
    const nueva = String(req.body?.nueva || "");

    const problema = A.validarPassword(nueva);
    if (problema) return res.status(400).json({ error: problema });
    if (actual === nueva) {
      return res.status(400).json({ error: "La nueva contraseña debe ser distinta de la actual." });
    }

    const { rows } = await query("SELECT password_hash FROM usuarios WHERE id = $1", [req.usuario.id]);
    if (!rows[0] || !A.verificarPassword(actual, rows[0].password_hash)) {
      return res.status(401).json({ error: "La contraseña actual no es correcta." });
    }

    await query(
      `UPDATE usuarios SET password_hash = $2, debe_cambiar_password = false WHERE id = $1`,
      [req.usuario.id, A.hashPassword(nueva)]
    );

    // Cerrar las demás sesiones: si la contraseña se cambió por sospecha de
    // filtración, dejar sesiones vivas anularía el propósito.
    await A.revocarSesionesDe(req.usuario.id);
    const { token, expira } = await A.crearSesion(req.usuario.id, req.usuario.ip, req.headers["user-agent"]);
    A.ponerCookie(res, token, expira);

    await A.registrarAcceso({
      email: req.usuario.email, usuarioId: req.usuario.id,
      evento: "cambio_password", exito: true, ip: req.usuario.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ==========================================================================
// Administración de usuarios (solo master)
// ==========================================================================
router.get("/usuarios", A.requiereSesion, A.requiereAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${CAMPOS_PUBLICOS} FROM usuarios ORDER BY activo DESC, nombre`
    );
    res.json({ usuarios: rows.map(aUsuario) });
  } catch (e) {
    next(e);
  }
});

router.post("/usuarios", A.requiereSesion, A.requiereAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const email = String(b.email || "").trim().toLowerCase();
    const nombre = String(b.nombre || "").trim();
    const rol = String(b.rol || "colaborador");
    const propiedadId = b.propiedadId ? String(b.propiedadId) : null;
    const password = String(b.password || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Correo inválido." });
    }
    if (!nombre) return res.status(400).json({ error: "El nombre es obligatorio." });
    if (!A.rolValido(rol)) {
      return res.status(400).json({ error: "Rol inválido. Debe ser master, gerente, jefatura o colaborador." });
    }
    if (rol !== "master" && !propiedadId) {
      return res.status(400).json({ error: "Gerentes, jefaturas y colaboradores deben tener una propiedad asignada." });
    }
    if (rol === "jefatura" && !String(b.puesto || "").trim()) {
      return res.status(400).json({
        error: "Las cuentas de jefatura necesitan el departamento que lideran (el mismo departamento que el puesto de sus subalternos en el catálogo de Puestos), para saber a quién le aprueban horas.",
      });
    }
    const problema = A.validarPassword(password);
    if (problema) return res.status(400).json({ error: problema });

    if (propiedadId) {
      const p = await query("SELECT 1 FROM propiedades WHERE id = $1", [propiedadId]);
      if (!p.rows[0]) return res.status(400).json({ error: "La propiedad no existe." });
    }

    const { rows } = await query(
      `INSERT INTO usuarios (email, nombre, cedula, puesto, propiedad_id, rol,
                             password_hash, creado_por, debe_cambiar_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING ${CAMPOS_PUBLICOS}`,
      [email, nombre, b.cedula || null, b.puesto || null, propiedadId, rol,
       A.hashPassword(password), req.usuario.id]
    );

    await A.registrarAcceso({
      email: req.usuario.email, usuarioId: req.usuario.id, evento: "crear_usuario",
      exito: true, detalle: "creó " + email, ip: req.usuario.ip,
    });
    res.status(201).json({ usuario: aUsuario(rows[0]) });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "Ya existe un usuario con ese correo." });
    }
    next(e);
  }
});

router.patch("/usuarios/:id", A.requiereSesion, A.requiereAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const id = req.params.id;

    if (id === req.usuario.id && b.activo === false) {
      return res.status(400).json({ error: "No puedes desactivar tu propia cuenta." });
    }
    if (id === req.usuario.id && b.rol && b.rol !== "master") {
      return res.status(400).json({ error: "No puedes quitarte a ti mismo el rol de master." });
    }
    if (b.rol !== undefined && !A.rolValido(String(b.rol))) {
      return res.status(400).json({ error: "Rol inválido. Debe ser master, gerente, jefatura o colaborador." });
    }
    if (b.rol === "jefatura"){
      // El puesto puede venir en este mismo PATCH o ya estar guardado de antes
      // (ej. si ya era jefatura y solo se le cambia otra cosa) — solo falta si
      // ninguno de los dos existe.
      let puestoFinal = b.puesto !== undefined ? String(b.puesto || "").trim() : null;
      if (puestoFinal === null) {
        const actual = await query("SELECT puesto FROM usuarios WHERE id = $1", [id]);
        puestoFinal = (actual.rows[0]?.puesto || "").trim();
      }
      if (!puestoFinal) {
        return res.status(400).json({
          error: "Las cuentas de jefatura necesitan el departamento que lideran (el mismo departamento que el puesto de sus subalternos en el catálogo de Puestos), para saber a quién le aprueban horas.",
        });
      }
    }

    const campos = [];
    const valores = [id];
    const set = (col, val) => {
      valores.push(val);
      campos.push(col + " = $" + valores.length);
    };

    if (b.nombre !== undefined) set("nombre", String(b.nombre).trim());
    if (b.cedula !== undefined) set("cedula", b.cedula || null);
    if (b.puesto !== undefined) set("puesto", b.puesto || null);
    if (b.propiedadId !== undefined) set("propiedad_id", b.propiedadId || null);
    if (b.rol !== undefined) set("rol", String(b.rol));
    if (b.activo !== undefined) {
      set("activo", !!b.activo);
      set("desactivado_en", b.activo ? null : new Date());
    }
    if (b.password !== undefined) {
      const problema = A.validarPassword(String(b.password));
      if (problema) return res.status(400).json({ error: problema });
      set("password_hash", A.hashPassword(String(b.password)));
      set("debe_cambiar_password", true);
    }

    if (!campos.length) return res.status(400).json({ error: "No hay nada que actualizar." });

    const { rows } = await query(
      `UPDATE usuarios SET ${campos.join(", ")} WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`,
      valores
    );
    if (!rows[0]) return res.status(404).json({ error: "Usuario no encontrado." });

    // Desactivar o cambiarle la contraseña a alguien lo saca de inmediato.
    if (b.activo === false || b.password !== undefined) {
      await A.revocarSesionesDe(id);
    }

    await A.registrarAcceso({
      email: req.usuario.email, usuarioId: req.usuario.id, evento: "editar_usuario",
      exito: true, detalle: "modificó " + rows[0].email, ip: req.usuario.ip,
    });
    res.json({ usuario: aUsuario(rows[0]) });
  } catch (e) {
    if (e.code === "23514") {
      return res.status(400).json({
        error: "Datos inválidos: gerentes y colaboradores deben tener una propiedad asignada.",
      });
    }
    next(e);
  }
});

// Bitácora de accesos (solo master)
router.get("/bitacora", A.requiereSesion, A.requiereAdmin, async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 100, 500);
    const { rows } = await query(
      `SELECT email, evento, exito, detalle, host(ip) AS ip, creado_en
         FROM bitacora_accesos ORDER BY creado_en DESC LIMIT $1`,
      [limite]
    );
    res.json({ eventos: rows });
  } catch (e) {
    next(e);
  }
});

router.get("/propiedades", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, nombre FROM propiedades WHERE activa ORDER BY orden, nombre"
    );
    res.json({ propiedades: rows });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
