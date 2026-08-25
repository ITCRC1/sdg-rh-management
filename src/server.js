"use strict";
// Punto de entrada: front estático + API, en un solo servicio de Railway.

const express = require("express");
const { migrar, pool, query } = require("./db");
const A = require("./auth");
const rutasAuth = require("./rutas-auth");
const { datos, historial, emitidos } = require("./rutas-datos");
const estatico = require("./estatico");

const PORT = Number(process.env.PORT) || 8000;
const HOST = "0.0.0.0";

const app = express();

// Railway termina TLS en su proxy: sin esto, req.ip y las cookies Secure
// se comportan como si todo llegara por HTTP.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "20mb" }));

// Cabeceras de seguridad. xlsx.js y pdf.js viven en vscode_project/vendor/ (ya no
// se cargan desde un CDN externo, así que no hace falta abrir la CSP para eso —
// un firewall o bloqueador de anuncios que frenara cdnjs.cloudflare.com dejaba a
// algunos usuarios sin poder importar Excel). 'unsafe-inline' sigue siendo
// necesario porque el HTML trae manejadores onclick — quitarlos es una limpieza aparte.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  next();
});

// ---------------------------------------------------------------------------
// Salud — sin tocar la BD para que un Postgres lento no marque el deploy como
// caído, y con /healthz/db aparte para diagnosticar de verdad.
// ---------------------------------------------------------------------------
app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

app.get("/healthz/db", async (req, res) => {
  try {
    const { rows } = await query("SELECT now() AS hora, current_database() AS bd");
    res.json({ ok: true, hora: rows[0].hora, bd: rows[0].bd });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.use("/api/auth", rutasAuth);
app.use("/api/datos", datos);
app.use("/api/historial", historial);
app.use("/api/documentos", emitidos);

app.use("/api", (req, res) => res.status(404).json({ error: "Ruta de API no encontrada." }));

// ---------------------------------------------------------------------------
// Front
// ---------------------------------------------------------------------------
app.use(estatico.servir);

app.use((req, res) => {
  res
    .status(404)
    .type("html")
    .send(
      '<!DOCTYPE html><meta charset="utf-8"><title>No encontrado</title>' +
        '<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:3rem;background:#F6F3EC;color:#3C2B23">' +
        "<h1>404 — Página no encontrada</h1>" +
        '<p><a href="/">Generador de Contratos</a> · <a href="/empleador.html">Panel de Empleador</a></p>'
    );
});

// Manejador de errores: al cliente le llega un mensaje genérico; el detalle
// queda en los logs. Un stack trace en la respuesta es una fuga de información.
app.use((err, req, res, _next) => {
  console.error("Error no controlado:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Error interno del servidor." });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function arrancar() {
  await migrar();
  await crearAdminInicial();

  const servidor = app.listen(PORT, HOST, () => {
    console.log("SDG Generador de Contratos escuchando en http://" + HOST + ":" + PORT);
  });

  const cerrar = async () => {
    console.log("Cerrando…");
    servidor.close(async () => {
      try {
        await pool.end();
      } catch (_) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", cerrar);
  process.on("SIGINT", cerrar);
}

// Siembra el primer master desde variables de entorno (se llaman ADMIN_* por
// compatibilidad con lo ya documentado en Railway). Solo actúa si no existe
// ningún master todavía: nunca pisa ni reactiva una cuenta existente.
async function crearAdminInicial() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return;

  const { rows } = await query("SELECT count(*)::int AS n FROM usuarios WHERE rol = 'master'");
  if (rows[0].n > 0) return;

  const problema = A.validarPassword(password);
  if (problema) {
    console.error("No se creó el master inicial: " + problema);
    return;
  }

  await query(
    `INSERT INTO usuarios (email, nombre, rol, password_hash, debe_cambiar_password, activo)
     VALUES ($1, $2, 'master', $3, true, true)
     ON CONFLICT DO NOTHING`,
    [email, process.env.ADMIN_NOMBRE || "Administrador", A.hashPassword(password)]
  );
  console.log("Master inicial creado: " + email + " (deberá cambiar la contraseña al entrar).");
}

arrancar().catch((e) => {
  console.error("No se pudo arrancar:", e);
  process.exit(1);
});
