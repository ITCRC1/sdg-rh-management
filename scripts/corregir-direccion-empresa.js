"use strict";
// Corrige las faltas de ortografía/mayúsculas en la dirección de la empresa
// "SDG RH MANAGEMENT S.R.L" (cat_empresa:) — detectadas en Despido/
// Amonestación/Constancias, que imprimen DIRECCION_EMPRESA tal cual está
// guardada. No es un bug de código: es texto que quedó guardado así al
// crear la empresa en Contratos → Empresas.
//
//   "Puntarenas, Osa, Bahía ballena, Uvita, 450m ne del bcr de uvita,
//    contiguo a cervecería artesanal whale tail"
// pasa a:
//   "Puntarenas, Osa, Bahía Ballena, Uvita, 450m NE del BCR de Uvita,
//    contiguo a cervecería artesanal Whale Tail"
//
// Busca en TODAS las propiedades (el catálogo de Empresas es por
// propiedad), por si "SDG RH MANAGEMENT S.R.L" está registrada en más de
// una. Solo toca el registro si el texto coincide EXACTO con la versión mal
// escrita de arriba — si alguien ya la corrigió a mano o el texto es
// distinto, no la toca (para no pisar una corrección manual ya hecha).
//
// Por defecto corre en modo DRY RUN (solo reporta qué cambiaría). Para
// escribir de verdad: node scripts/corregir-direccion-empresa.js --apply
//
// Requiere DATABASE_URL en el entorno (igual que el servidor) — correr con
// `railway run node scripts/corregir-direccion-empresa.js` si no hay una
// variable local.

const { pool, conActor } = require("../src/db");

const DIRECCION_VIEJA = "Puntarenas, Osa, Bahía ballena, Uvita, 450m ne del bcr de uvita, contiguo a cervecería artesanal whale tail";
const DIRECCION_NUEVA = "Puntarenas, Osa, Bahía Ballena, Uvita, 450m NE del BCR de Uvita, contiguo a cervecería artesanal Whale Tail";

async function main() {
  const aplicar = process.argv.includes("--apply");
  console.log(aplicar ? "Modo real — se va a escribir en la base de datos.\n" : "DRY RUN — no se escribe nada todavía, solo se reporta.\n");

  const { rows } = await pool.query(
    `SELECT propiedad_id, clave, valor, version FROM documentos
      WHERE clave LIKE 'cat_empresa:%' AND eliminado_en IS NULL`
  );

  let corregidas = 0, yaEstaba = 0, sinCoincidencia = 0;

  for (const fila of rows) {
    let valor;
    try {
      valor = JSON.parse(fila.valor);
    } catch (e) {
      continue;
    }
    const nombre = (valor.EMPRESA || "").trim().toUpperCase();
    if (nombre !== "SDG RH MANAGEMENT S.R.L") continue;

    if (valor.DIRECCION_EMPRESA === DIRECCION_NUEVA) {
      console.log(`  [${fila.propiedad_id}] "${valor.EMPRESA}" — ya tiene la dirección corregida, se omite.`);
      yaEstaba++;
      continue;
    }
    if (valor.DIRECCION_EMPRESA !== DIRECCION_VIEJA) {
      console.log(`  [${fila.propiedad_id}] "${valor.EMPRESA}" — la dirección guardada no coincide con el texto esperado, se omite (revisar a mano):\n    "${valor.DIRECCION_EMPRESA}"`);
      sinCoincidencia++;
      continue;
    }

    console.log(`  [${fila.propiedad_id}] "${valor.EMPRESA}" ${aplicar ? "corregida." : "se corregiría."}`);
    corregidas++;
    if (!aplicar) continue;

    const nuevoValor = Object.assign({}, valor, { DIRECCION_EMPRESA: DIRECCION_NUEVA });
    await conActor({ email: "script:corregir-direccion-empresa" }, async (c) => {
      await c.query(
        `UPDATE documentos
            SET valor = $1, version = version + 1, actualizado_en = now()
          WHERE propiedad_id = $2 AND clave = $3 AND version = $4`,
        [JSON.stringify(nuevoValor), fila.propiedad_id, fila.clave, fila.version]
      );
    });
  }

  console.log(`\n${corregidas} corregida(s), ${yaEstaba} ya estaban bien, ${sinCoincidencia} sin coincidencia exacta (revisar a mano).`);
  if (!aplicar && corregidas > 0) {
    console.log("\nEsto fue un DRY RUN — no se escribió nada. Volvé a correr con --apply para guardar los cambios.");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
