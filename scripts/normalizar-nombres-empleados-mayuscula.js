"use strict";
// Normaliza a MAYÚSCULA los nombres propios de empleados ya guardados en la
// base de datos (NOMBRE_EMP, APELLIDOS_EMP, CONTACTO_EMERGENCIA_NOMBRE),
// para que el listado quede consistente con el estándar que ya aplica el
// formulario manual (ver formatearNombrePropio / formato "mayus" en
// vscode_project/app.js). Corrige en especial los registros que entraron por
// "Importar Empleados" o "Actualizar datos de Empleados" antes de que esas
// rutas de importación masiva aplicaran el mismo estándar (ver el fix en
// guardarFilasEmpleadosNuevos / guardarFilasContactoEmpleados).
//
// Por defecto corre en modo DRY RUN (solo reporta qué cambiaría). Para
// escribir los cambios: node scripts/normalizar-nombres-empleados-mayuscula.js --apply
//
// Requiere DATABASE_URL en el entorno (igual que el servidor).

const { pool, conActor } = require("../src/db");

const CAMPOS_A_MAYUSCULA = ["NOMBRE_EMP", "APELLIDOS_EMP", "CONTACTO_EMERGENCIA_NOMBRE"];

function formatearNombrePropio(s) {
  return String(s || "").trim().toUpperCase();
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
  const detalle = [];

  for (const fila of rows) {
    let value;
    try {
      value = JSON.parse(fila.valor);
    } catch (e) {
      console.error(`  ! ${fila.propiedad_id}/${fila.clave}: valor no es JSON válido, se omite.`);
      continue;
    }

    const cambios = {};
    for (const campo of CAMPOS_A_MAYUSCULA) {
      if (!(campo in value)) continue;
      const nuevo = formatearNombrePropio(value[campo]);
      if (nuevo !== value[campo]) cambios[campo] = nuevo;
    }

    if (Object.keys(cambios).length === 0) continue;

    cambiados++;
    detalle.push({ propiedad: fila.propiedad_id, clave: fila.clave, cambios });

    if (!aplicar) continue;

    const nuevoValue = Object.assign({}, value, cambios);
    await conActor({ email: "script:normalizar-nombres-empleados-mayuscula" }, async (c) => {
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

  console.log(`Revisados: ${rows.length} empleado(s). ${aplicar ? "Actualizados" : "Cambiarían"}: ${cambiados}.`);
  detalle.forEach((d) => {
    const resumen = Object.entries(d.cambios).map(([k, v]) => `${k} → "${v}"`).join(", ");
    console.log(`  - [${d.propiedad}] ${d.clave}: ${resumen}`);
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
