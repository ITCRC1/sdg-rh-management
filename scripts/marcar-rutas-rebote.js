"use strict";
// Marca las rutas de puerto (Drake/Sierpe) ya creadas como APLICA_REBOTE —
// el Reporte de Operación de Rebotes ahora solo muestra rutas marcadas así
// (ver renderBitacorasPanel en vscode_project/app.js). Las rutas que ya
// existían (creadas antes de este campo) no lo tienen, así que sin este
// script el Reporte de Rebotes quedaría vacío hasta marcarlas a mano una
// por una.
//
// Por defecto corre en modo DRY RUN (solo reporta qué cambiaría). Para
// escribir de verdad: node scripts/marcar-rutas-rebote.js --apply
//
// Requiere DATABASE_URL en el entorno (igual que el servidor).

const { pool, conActor } = require("../src/db");

const PROPIEDAD_ID = "corcovado";

// Nombres exactos de las rutas que van a puerto (confirmadas con el
// usuario) — comparación sin acentos, mayúsculas ni espacios de más, por si
// quedaron tipeadas con alguna variación menor.
const RUTAS_DE_PUERTO = ["CWL-SRP", "SRP-CWL", "CWL-DRAKE"];

function normalizarNombre(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

async function main() {
  const aplicar = process.argv.includes("--apply");
  console.log(aplicar ? "Modo real — se va a escribir en la base de datos.\n" : "DRY RUN — no se escribe nada todavía, solo se reporta.\n");

  const objetivo = new Set(RUTAS_DE_PUERTO.map(normalizarNombre));

  const { rows } = await pool.query(
    `SELECT clave, valor, version FROM documentos
      WHERE propiedad_id = $1 AND clave LIKE 'cat_ruta_bote:%' AND eliminado_en IS NULL`,
    [PROPIEDAD_ID]
  );

  let marcadas = 0, yaEstaban = 0, noEncontradas = new Set(objetivo);

  for (const fila of rows) {
    let valor;
    try {
      valor = JSON.parse(fila.valor);
    } catch (e) {
      continue;
    }
    const nombre = normalizarNombre(valor.NOMBRE);
    if (!objetivo.has(nombre)) continue;
    noEncontradas.delete(nombre);

    if (valor.APLICA_REBOTE === true) {
      console.log(`  [Rutas] "${valor.NOMBRE}" ya estaba marcada — se omite.`);
      yaEstaban++;
      continue;
    }

    console.log(`  [Rutas] "${valor.NOMBRE}" ${aplicar ? "marcada." : "se marcaría."}`);
    marcadas++;
    if (!aplicar) continue;

    const nuevoValor = Object.assign({}, valor, { APLICA_REBOTE: true });
    await conActor({ email: "script:marcar-rutas-rebote" }, async (c) => {
      await c.query(
        `UPDATE documentos
            SET valor = $1, version = version + 1, actualizado_en = now()
          WHERE propiedad_id = $2 AND clave = $3 AND version = $4`,
        [JSON.stringify(nuevoValor), PROPIEDAD_ID, fila.clave, fila.version]
      );
    });
  }

  console.log(`\n${marcadas} marcada(s), ${yaEstaban} ya estaban.`);
  if (noEncontradas.size) {
    console.log(`⚠️ No se encontraron estas rutas (revisá el nombre exacto en el catálogo): ${Array.from(noEncontradas).join(", ")}`);
  }
  if (!aplicar && marcadas > 0) {
    console.log("\nEsto fue un DRY RUN — no se escribió nada. Volvé a correr con --apply para guardar los cambios.");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
