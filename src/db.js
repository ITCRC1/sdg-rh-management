"use strict";
// Conexión a Postgres y ejecutor de migraciones.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const MIGRACIONES_DIR = path.join(__dirname, "..", "migrations");

if (!process.env.DATABASE_URL) {
  console.error(
    "Falta DATABASE_URL. En Railway se inyecta sola al agregar Postgres al proyecto\n" +
      "(Variables → Add Reference → Postgres.DATABASE_URL)."
  );
  process.exit(1);
}

// Railway expone el Postgres por red interna sin TLS; los proveedores externos
// suelen exigirlo. PGSSL=require lo activa sin tener que tocar código.
const ssl =
  process.env.PGSSL === "require" || /\bsslmode=require\b/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  // Una conexión ociosa que se cae no debe tumbar el proceso.
  console.error("Error en conexión ociosa de Postgres:", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Ejecuta fn dentro de una transacción, fijando el actor para que el trigger
// de historial sepa quién hizo el cambio. Sin esto el histórico quedaría sin
// autor, que es justo lo que no queremos.
async function conActor(actor, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actor?.id || ""]);
    await client.query("SELECT set_config('app.actor_email', $1, true)", [actor?.email || ""]);
    await client.query("SELECT set_config('app.actor_ip', $1, true)", [actor?.ip || ""]);
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* la conexión ya estaba perdida */
    }
    throw e;
  } finally {
    client.release();
  }
}

// Migraciones: archivos .sql numerados, aplicados una sola vez y en orden.
// El lock evita que dos réplicas arrancando a la vez las corran en paralelo.
async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migraciones (
      nombre      text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )`);

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(918273645)");

    const aplicadas = new Set(
      (await client.query("SELECT nombre FROM _migraciones")).rows.map((r) => r.nombre)
    );
    const archivos = fs
      .readdirSync(MIGRACIONES_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const archivo of archivos) {
      if (aplicadas.has(archivo)) continue;
      const sql = fs.readFileSync(path.join(MIGRACIONES_DIR, archivo), "utf8");
      console.log("Aplicando migración " + archivo + "…");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migraciones (nombre) VALUES ($1)", [archivo]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error("Migración " + archivo + " falló: " + e.message);
      }
    }
    console.log("Migraciones al día (" + archivos.length + " archivo(s)).");
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(918273645)");
    } catch (_) {}
    client.release();
  }
}

module.exports = { pool, query, conActor, migrar };
