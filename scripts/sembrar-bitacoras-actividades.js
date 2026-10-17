"use strict";
// Crea de una sola vez el catálogo inicial del módulo Bitácoras (ver
// renderBitacorasPanel en vscode_project/app.js): los botes, las rutas y las
// máquinas/equipos que el usuario ya dio por chat — para no tener que
// tipearlos uno por uno a mano desde la pantalla. Quedan etiquetados con
// DEPARTAMENTO_MINISTERIO = "ACTIVIDADES" (Bitácoras ahora es por
// departamento, igual que Horarios — ver botePerteneceAEquipo en
// src/rutas-datos.js), que es el departamento real dueño de los botes/rutas/
// maquinaria de esta propiedad.
//
// Idempotente: si un nombre ya existe (comparado sin importar mayúsculas ni
// espacios de más), lo salta en vez de crear un duplicado — se puede correr
// de nuevo sin miedo si se agregan nombres nuevos a las listas de abajo.
//
// Por defecto corre en modo DRY RUN (solo reporta qué crearía). Para
// escribir de verdad: node scripts/sembrar-bitacoras-actividades.js --apply
//
// Requiere DATABASE_URL en el entorno (igual que el servidor) y que la
// propiedad "corcovado" ya exista (siempre existe, es la primera de todas).

const { pool, conActor } = require("../src/db");

const PROPIEDAD_ID = "corcovado";
const DEPARTAMENTO = "ACTIVIDADES";

const BOTES = ["CHULIN", "TIBURON", "TAPIR", "PACA", "TAMANDUA", "COATI"];

// Las 5 rutas quedan con TIENE_HACIENDA = true (confirmado con el usuario) —
// si algún día no aplica, esa columna simplemente queda vacía en la grilla.
// APLICA_REBOTE marca las rutas a puerto (Drake/Sierpe en cualquier
// dirección) — son las únicas que el Reporte de Rebotes muestra (ver
// scripts/marcar-rutas-rebote.js para backfill de rutas ya creadas antes de
// que existiera este campo).
const RUTAS_A_PUERTO = new Set(["SRP-CWL", "CWL-SRP", "CWL-DRAKE"]);
const RUTAS = ["SRP-CWL", "CWL-SRP", "CWL-ISLA", "CWL-DRAKE", "CWL-TRANSB"].map((nombre) => ({
  nombre,
  tieneHacienda: true,
  aplicaRebote: RUTAS_A_PUERTO.has(nombre),
}));

const MAQUINAS = [
  "MOTOSIERRA",
  "MOTOGUARAÑA",
  "BOMBA AGUA CLARO DEL BOSQUE",
  "BOMBA DE AGUA HONDA HOTEL",
  "PLANTA 1 HOTEL",
  "PLANTA 2 HOTEL",
  "CHAPULIN LIMO 1",
  "CHAPULIN LIMO 2",
  "GENERADORES DE EMERGENCIA O ESTATICOS",
  "PLANTA CLARO DEL BOSQUE",
  "GENERADOR BOMBA AGUA CLARO BOSQUE",
  "BUSETA DRAKE - TRANSPORTE CLIENTES",
  "CARROS HILUX - TRANSPORTE INTERNO",
  "MEZCLADORA DE CEMENTO HONDA",
  "CONSTRUCCION",
  "TRABAJOS DE EXTERNOS",
  "MOTORES FUERA DE BORDA 2 TIEMPOS",
  "OTROS",
];

function normalizarNombre(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function claveUnica(prefijo, indice) {
  return `${prefijo}seed${indice}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function nombresExistentes(prefijo) {
  const { rows } = await pool.query(
    `SELECT valor FROM documentos
      WHERE propiedad_id = $1 AND clave LIKE $2 ESCAPE '\\' AND eliminado_en IS NULL`,
    [PROPIEDAD_ID, prefijo.replace(/([\\%_])/g, "\\$1") + "%"]
  );
  const nombres = new Set();
  rows.forEach((r) => {
    try {
      const v = JSON.parse(r.valor);
      if (v && v.NOMBRE) nombres.add(normalizarNombre(v.NOMBRE));
    } catch (e) {
      /* fila rara, se ignora */
    }
  });
  return nombres;
}

async function sembrarCatalogoSimple(etiqueta, prefijo, nombres, aplicar) {
  const existentes = await nombresExistentes(prefijo);
  let creados = 0, omitidos = 0, indice = 0;
  for (const nombre of nombres) {
    indice++;
    if (existentes.has(normalizarNombre(nombre))) {
      console.log(`  [${etiqueta}] "${nombre}" ya existe — se omite.`);
      omitidos++;
      continue;
    }
    console.log(`  [${etiqueta}] "${nombre}" ${aplicar ? "creado." : "se crearía."}`);
    creados++;
    if (!aplicar) continue;
    const clave = claveUnica(prefijo, indice);
    await conActor({ email: "script:sembrar-bitacoras-actividades" }, async (c) => {
      await c.query(
        `INSERT INTO documentos (propiedad_id, clave, valor)
         VALUES ($1, $2, $3)
         ON CONFLICT (propiedad_id, clave) DO NOTHING`,
        [PROPIEDAD_ID, clave, JSON.stringify({ NOMBRE: nombre, DEPARTAMENTO_MINISTERIO: DEPARTAMENTO })]
      );
    });
  }
  console.log(`[${etiqueta}] ${creados} creado(s), ${omitidos} ya existían.\n`);
}

async function sembrarRutas(aplicar) {
  const existentes = await nombresExistentes("cat_ruta_bote:");
  let creados = 0, omitidos = 0, indice = 0;
  for (const { nombre, tieneHacienda, aplicaRebote } of RUTAS) {
    indice++;
    if (existentes.has(normalizarNombre(nombre))) {
      console.log(`  [Rutas] "${nombre}" ya existe — se omite.`);
      omitidos++;
      continue;
    }
    console.log(`  [Rutas] "${nombre}" (Hacienda: ${tieneHacienda ? "sí" : "no"}, Rebotes: ${aplicaRebote ? "sí" : "no"}) ${aplicar ? "creada." : "se crearía."}`);
    creados++;
    if (!aplicar) continue;
    const clave = claveUnica("cat_ruta_bote:", indice);
    await conActor({ email: "script:sembrar-bitacoras-actividades" }, async (c) => {
      await c.query(
        `INSERT INTO documentos (propiedad_id, clave, valor)
         VALUES ($1, $2, $3)
         ON CONFLICT (propiedad_id, clave) DO NOTHING`,
        [PROPIEDAD_ID, clave, JSON.stringify({ NOMBRE: nombre, TIENE_HACIENDA: tieneHacienda, APLICA_REBOTE: aplicaRebote, DEPARTAMENTO_MINISTERIO: DEPARTAMENTO })]
      );
    });
  }
  console.log(`[Rutas] ${creados} creada(s), ${omitidos} ya existían.\n`);
}

async function main() {
  const aplicar = process.argv.includes("--apply");
  console.log(aplicar ? "Modo real — se va a escribir en la base de datos.\n" : "DRY RUN — no se escribe nada todavía, solo se reporta.\n");

  await sembrarCatalogoSimple("Botes", "cat_bote:", BOTES, aplicar);
  await sembrarRutas(aplicar);
  await sembrarCatalogoSimple("Máquinas", "cat_maquina:", MAQUINAS, aplicar);

  if (!aplicar) {
    console.log("Esto fue un DRY RUN — no se creó nada. Vuelve a correr con --apply para guardar de verdad:");
    console.log("  node scripts/sembrar-bitacoras-actividades.js --apply");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
