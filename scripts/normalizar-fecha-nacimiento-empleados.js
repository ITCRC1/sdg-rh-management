"use strict";
// Normaliza FECHA_NACIMIENTO_EMP a "DD/MM/AAAA" en los expedientes que por un
// bug ya corregido del selector de fecha (ver type "date_nacimiento_emp" en
// catalogFieldHtml, vscode_project/app.js) quedaron guardados en ISO
// "AAAA-MM-DD". Mientras el dato siga así, /api/auth/autorecuperar-clave
// rechazaba a esas personas aunque escribieran bien su fecha de nacimiento
// (ver fechaEmpleadoAIso en src/auth.js, ya tolera leer ambos formatos — este
// script deja el dato guardado consistente de una vez, en vez de depender
// para siempre de esa tolerancia al comparar).
//
// Los formularios de alta/edición y de importación masiva (normalizarFechaImportada
// en app.js) ya guardan siempre DD/MM/AAAA — este script es solo para poner al
// día lo que quedó mal de antes; ningún expediente nuevo necesita esto.
//
// Por defecto corre en modo DRY RUN (solo reporta qué cambiaría). Para
// escribir los cambios: node scripts/normalizar-fecha-nacimiento-empleados.js --apply
//
// Requiere DATABASE_URL en el entorno (igual que el servidor).

const { pool, conActor } = require("../src/db");

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoADdMmAaaa(texto) {
  const m = ISO.exec(String(texto || "").trim());
  if (!m) return null;
  const [, y, mm, dd] = m;
  // Valida que de verdad sea una fecha real (ej. rechaza 2026-02-30), no
  // solo que tenga la forma correcta.
  const d = new Date(Number(y), Number(mm) - 1, Number(dd));
  if (d.getFullYear() !== Number(y) || d.getMonth() !== Number(mm) - 1 || d.getDate() !== Number(dd)) return null;
  return `${dd}/${mm}/${y}`;
}

async function main() {
  const aplicar = process.argv.includes("--apply");

  const { rows } = await pool.query(
    `SELECT propiedad_id, clave, valor, version
       FROM documentos
      WHERE clave LIKE 'cat_empleado:%' AND eliminado_en IS NULL
      ORDER BY propiedad_id, clave`
  );

  let cambiados = 0;
  let invalidas = 0;
  const detalle = [];

  for (const fila of rows) {
    let value;
    try {
      value = JSON.parse(fila.valor);
    } catch (e) {
      console.error(`  ! ${fila.propiedad_id}/${fila.clave}: valor no es JSON válido, se omite.`);
      continue;
    }

    const original = value.FECHA_NACIMIENTO_EMP;
    if (!original || !ISO.test(String(original).trim())) continue;

    const nuevo = isoADdMmAaaa(original);
    if (!nuevo) {
      invalidas++;
      console.error(`  ! ${fila.propiedad_id}/${fila.clave}: "${original}" parece ISO pero no es una fecha válida, se omite.`);
      continue;
    }

    cambiados++;
    detalle.push({ propiedad: fila.propiedad_id, clave: fila.clave, original, nuevo });

    if (!aplicar) continue;

    const nuevoValue = Object.assign({}, value, { FECHA_NACIMIENTO_EMP: nuevo });
    await conActor({ email: "script:normalizar-fecha-nacimiento-empleados" }, async (c) => {
      await c.query(
        `UPDATE documentos
            SET valor = $1,
                version = version + 1,
                actualizado_en = now()
          WHERE propiedad_id = $2 AND clave = $3 AND version = $4`,
        [JSON.stringify(nuevoValue), fila.propiedad_id, fila.clave, fila.version]
      );
    });
  }

  console.log(`Revisados: ${rows.length} empleado(s). ${aplicar ? "Actualizados" : "Cambiarían"}: ${cambiados}.${invalidas ? ` ${invalidas} con fecha ISO inválida, omitida(s).` : ""}`);
  detalle.forEach((d) => {
    console.log(`  - [${d.propiedad}] ${d.clave}: "${d.original}" → "${d.nuevo}"`);
  });
  if (!aplicar && cambiados > 0) {
    console.log("\nEsto fue un DRY RUN — no se escribió nada. Vuelve a correr con --apply para guardar los cambios.");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
