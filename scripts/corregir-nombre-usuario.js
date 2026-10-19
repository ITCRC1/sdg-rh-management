"use strict";
// Corrige el nombre completo guardado en una cuenta de usuario (tabla
// usuarios) — es el mismo nombre que Constancia Salarial/Laboral (y
// Permiso/Vacaciones/Amonestación cuando firma la propia sesión) usan en el
// bloque de firma, tal cual está en la cuenta con la que se entra al
// sistema. Identifica la cuenta por CÉDULA (no por email, para no fallar si
// el correo cambió) y solo la toca si el nombre actual coincide EXACTO con
// el que se espera corregir — si ya se corrigió a mano (ver botón "✏️
// Nombre" en Gestión de Usuarios), no la vuelve a tocar.
//
// Por defecto corre en modo DRY RUN (solo reporta qué cambiaría). Para
// escribir de verdad: node scripts/corregir-nombre-usuario.js --apply
//
// Requiere DATABASE_URL en el entorno — correr con
// `railway run node scripts/corregir-nombre-usuario.js` si no hay una
// variable local.

const { pool } = require("../src/db");

const CEDULA = "604170766";
const NOMBRE_VIEJO = "Andrey Flores";
const NOMBRE_NUEVO = "Andrey Alberto Flores Pizarro";

async function main() {
  const aplicar = process.argv.includes("--apply");
  console.log(aplicar ? "Modo real — se va a escribir en la base de datos.\n" : "DRY RUN — no se escribe nada todavía, solo se reporta.\n");

  const { rows } = await pool.query(
    `SELECT id, email, nombre, propiedad_id, rol FROM usuarios WHERE cedula = $1`,
    [CEDULA]
  );

  if (!rows.length) {
    console.log(`No se encontró ninguna cuenta con cédula ${CEDULA}.`);
    await pool.end();
    return;
  }

  for (const u of rows) {
    if (u.nombre === NOMBRE_NUEVO) {
      console.log(`  [${u.email}] ya tiene el nombre corregido — se omite.`);
      continue;
    }
    if (u.nombre !== NOMBRE_VIEJO) {
      console.log(`  [${u.email}] el nombre guardado no es "${NOMBRE_VIEJO}" (es "${u.nombre}") — se omite, revisar a mano.`);
      continue;
    }
    console.log(`  [${u.email}] "${u.nombre}" → "${NOMBRE_NUEVO}" ${aplicar ? "(corregido)" : "(se corregiría)"}`);
    if (!aplicar) continue;
    await pool.query(`UPDATE usuarios SET nombre = $1 WHERE id = $2`, [NOMBRE_NUEVO, u.id]);
  }

  if (!aplicar) {
    console.log("\nEsto fue un DRY RUN — no se escribió nada. Volvé a correr con --apply para guardar el cambio.");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
