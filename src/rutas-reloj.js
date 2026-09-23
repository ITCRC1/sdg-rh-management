"use strict";
// Reloj marcador (SmartPSS) — lectura directa de su base MySQL.
//
// Los relojes de Corcovado (COMEDOR, CLARO DEL BOSQUE, HACIENDA) escriben
// cada marca en la tabla AttendanceRecordInfo de una base MySQL aparte. Esta
// ruta la lee tal cual, SOLO LECTURA: nunca escribe ahí. Las correcciones
// (anular una marca, agregar una manual) se guardan en el Postgres de SDG
// como cualquier otro dato (claves reloj_anulacion:/reloj_manual:), así
// quedan con su histórico y autor igual que el resto.
//
// Se lee la tabla de origen de SmartPSS y no la copia que mantenía el
// sistema Django anterior (marcas_marcareloj): así SDG no depende de que ese
// servicio siga corriendo — basta con que la base siga recibiendo marcas.
//
// Sobre el tiempo: AttendanceDateTime (ms) guarda la HORA DE PARED de Costa
// Rica codificada como si fuera UTC — el mismo formato que ya usa app.js
// para las marcas importadas de PDF (Date.UTC con la hora local). Se usa
// esa columna y no AttendanceUtcTime porque esta última solo viene bien en
// una parte de las filas (las más viejas traen otro valor).
//
// Variables de entorno:
//   RELOJ_MYSQL_URL   mysql://usuario:clave@host:puerto/base (usuario de solo lectura)
//   RELOJ_PROPIEDAD   propiedad de SDG a la que pertenecen los relojes (por defecto corcovado)

const express = require("express");
const A = require("./auth");
const { propiedadDe } = require("./rutas-datos");

const PROPIEDAD_RELOJ = process.env.RELOJ_PROPIEDAD || "corcovado";
const MAX_DIAS_RANGO = 62;
const ROLES_LECTURA = new Set(["master", "gerente", "consultor"]);

let pool = null;
function obtenerPool() {
  if (!process.env.RELOJ_MYSQL_URL) return null;
  if (!pool) {
    // Se carga aquí y no arriba: un despliegue sin reloj configurado no
    // necesita ni abrir el módulo.
    const mysql = require("mysql2/promise");
    pool = mysql.createPool({
      uri: process.env.RELOJ_MYSQL_URL,
      connectionLimit: 3,
      connectTimeout: 10000,
      timezone: "Z",
    });
  }
  return pool;
}

async function consultar(sql, params) {
  const p = obtenerPool();
  const conexion = await p.getConnection();
  try {
    // Defensa extra además del usuario de solo lectura: aunque alguien
    // configurara root por error, esta sesión no puede escribir.
    await conexion.query("SET SESSION TRANSACTION READ ONLY");
    const [filas] = await conexion.query(sql, params);
    return filas;
  } finally {
    conexion.release();
  }
}

const router = express.Router();
router.use(A.requiereSesion, A.exigeCambioPassword);

// Solo quien ve la planilla completa. jefatura y empleado quedan fuera: el
// reloj trae las marcas de toda la propiedad, sin filtro por equipo.
router.use((req, res, next) => {
  if (!ROLES_LECTURA.has(req.usuario.rol)) {
    return res.status(403).json({ error: "Tu cuenta no tiene acceso al reloj marcador.", codigo: "sin_permiso" });
  }
  next();
});

// El reloj pertenece a una sola propiedad. Pedirlo desde otra devuelve un
// error claro en vez de mostrar marcas de Corcovado como si fueran de Oxygen.
router.use((req, res, next) => {
  if (!obtenerPool()) {
    return res.status(503).json({ error: "El reloj marcador no está configurado en este servidor.", codigo: "sin_configurar" });
  }
  if (propiedadDe(req) !== PROPIEDAD_RELOJ) {
    return res.status(409).json({
      error: "El reloj marcador solo está conectado a la propiedad " + PROPIEDAD_RELOJ + ".",
      codigo: "otra_propiedad",
      propiedadReloj: PROPIEDAD_RELOJ,
    });
  }
  next();
});

function fechaValida(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
}

function errorConexion(e, res, next) {
  // Errores de red/credenciales de MySQL: mensaje útil al cliente, detalle
  // solo en los logs (nunca la URL ni el usuario).
  if (e && (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND" ||
            e.code === "ER_ACCESS_DENIED_ERROR" || e.code === "PROTOCOL_CONNECTION_LOST")) {
    console.error("Reloj marcador — no se pudo conectar a MySQL:", e.code);
    return res.status(502).json({ error: "No se pudo conectar con la base del reloj marcador.", codigo: "reloj_inaccesible" });
  }
  next(e);
}

// GET /api/reloj/estado — ¿está vivo el reloj? Última marca y dispositivos.
router.get("/estado", async (req, res, next) => {
  try {
    const dispositivos = await consultar(
      `SELECT DeviceName AS nombre, COUNT(*) AS marcas, MAX(AttendanceDateTime) AS ultima
         FROM AttendanceRecordInfo GROUP BY DeviceName ORDER BY marcas DESC`
    );
    const ultima = dispositivos.reduce((m, d) => Math.max(m, Number(d.ultima) || 0), 0);
    res.json({
      propiedad: PROPIEDAD_RELOJ,
      ultimaMarca: ultima || null,
      dispositivos: dispositivos.map((d) => ({ nombre: d.nombre || "(sin nombre)", marcas: Number(d.marcas), ultima: Number(d.ultima) || null })),
    });
  } catch (e) {
    errorConexion(e, res, next);
  }
});

// GET /api/reloj/marcas?desde=AAAA-MM-DD&hasta=AAAA-MM-DD — marcas crudas del rango.
router.get("/marcas", async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    if (!fechaValida(desde) || !fechaValida(hasta)) {
      return res.status(400).json({ error: "Indica un rango de fechas válido (desde y hasta)." });
    }
    const ini = Date.parse(desde + "T00:00:00Z");
    const fin = Date.parse(hasta + "T00:00:00Z") + 24 * 60 * 60 * 1000; // exclusivo
    if (fin <= ini) return res.status(400).json({ error: "La fecha final debe ser igual o posterior a la inicial." });
    if ((fin - ini) / 86400000 > MAX_DIAS_RANGO) {
      return res.status(400).json({ error: "El rango máximo es de " + MAX_DIAS_RANGO + " días." });
    }

    const filas = await consultar(
      `SELECT PersonID AS codigo, PersonName AS nombre, AttendanceDateTime AS ts, DeviceName AS dispositivo
         FROM AttendanceRecordInfo
        WHERE AttendanceDateTime >= ? AND AttendanceDateTime < ?
        ORDER BY AttendanceDateTime`,
      [ini, fin]
    );
    res.json({
      desde,
      hasta,
      marcas: filas.map((f) => ({
        codigo: String(f.codigo),
        nombre: String(f.nombre || "").trim(),
        ts: Number(f.ts),
        dispositivo: f.dispositivo || "",
      })),
    });
  } catch (e) {
    errorConexion(e, res, next);
  }
});

// GET /api/reloj/personas — cada persona registrada en el reloj, para
// detectar quién todavía no tiene ficha en SDG.
router.get("/personas", async (req, res, next) => {
  try {
    const filas = await consultar(
      `SELECT PersonID AS codigo, MAX(PersonName) AS nombre, COUNT(*) AS marcas, MAX(AttendanceDateTime) AS ultima
         FROM AttendanceRecordInfo GROUP BY PersonID ORDER BY nombre`
    );
    res.json({
      personas: filas.map((f) => ({
        codigo: String(f.codigo),
        nombre: String(f.nombre || "").trim(),
        marcas: Number(f.marcas),
        ultima: Number(f.ultima) || null,
      })),
    });
  } catch (e) {
    errorConexion(e, res, next);
  }
});

module.exports = { reloj: router, PROPIEDAD_RELOJ };
