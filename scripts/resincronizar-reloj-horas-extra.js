"use strict";
// Fuerza una resincronización manual del Reloj marcador hacia Horas extra
// para un rango de fechas explícito — mismo resultado que el botón "📤
// Enviar a Horas extras" del panel Reloj marcador (ver relojEnviarAHorasExtras
// en vscode_project/app.js), pero corrida desde la terminal, para un rango
// más amplio o para forzar un reintento sin depender del navegador.
//
// Es seguro volver a correrlo las veces que haga falta: cualquier día que ya
// tenga una decisión (ESTADO "aprobada" o "rechazada" — incluye vacaciones y
// días libres ya aprobados) se salta y nunca se pisa (ver guardarFilas en
// src/reloj-sync.js). Solo los días que siguen "pendiente" se actualizan.
//
// Uso:
//   node scripts/resincronizar-reloj-horas-extra.js --desde=2026-09-10 --hasta=2026-09-25
//
// Requiere en el entorno (igual que el servidor):
//   DATABASE_URL       (Postgres)
//   RELOJ_MYSQL_URL    (MySQL del reloj — si falta, el script avisa y no hace nada)

const { sincronizarRango, marcarUltimaFechaSincronizada, FECHA_INICIO_SYNC } = require("../src/reloj-sync");
const { pool } = require("../src/db");

function leerArgFecha(nombre, porDefecto) {
  const arg = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  const valor = arg ? arg.slice(nombre.length + 3) : porDefecto;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor || "")) {
    throw new Error(`--${nombre} debe ser una fecha AAAA-MM-DD (recibido: "${valor}").`);
  }
  return valor;
}

async function main() {
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = leerArgFecha("desde", FECHA_INICIO_SYNC);
  const hasta = leerArgFecha("hasta", hoy);
  if (hasta < desde) throw new Error("--hasta no puede ser anterior a --desde.");

  if (!process.env.RELOJ_MYSQL_URL) {
    console.error("Falta RELOJ_MYSQL_URL en el entorno — no se puede leer el reloj marcador.");
    process.exit(1);
  }

  console.log(`Sincronizando Reloj marcador → Horas extra: ${desde} a ${hasta}…`);
  const r = await sincronizarRango(desde, hasta);
  if (!r.configurado) {
    console.error("El reloj marcador no está configurado en este entorno.");
    process.exit(1);
  }

  console.log(
    `Listo. ${r.creadas} día(s) nuevo(s), ${r.actualizadas} actualizado(s), ${r.omitidas} omitido(s) ` +
      `(ya tenían una decisión), ${r.sinMatch} sin empleado identificado, ${r.confianzaOmitidos} de puesto(s) de confianza.`
  );

  // Deja el marcador de la corrida automática apuntando a "hasta", para que
  // la próxima medianoche no repita innecesariamente todo este rango.
  await marcarUltimaFechaSincronizada(hasta, r);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
