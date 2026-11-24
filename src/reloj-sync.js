"use strict";
// Envío automático diario: Reloj marcador → Horas extra.
//
// Mismo resultado que el botón "📤 Enviar a Horas extras" del panel Reloj
// marcador (relojEnviarAHorasExtras en vscode_project/app.js), pero corrido
// solo cada noche desde el servidor en vez de depender de que alguien lo
// dispare a mano. ESTE ARCHIVO DEBE PRODUCIR EXACTAMENTE EL MISMO RESULTADO
// que ese botón para el mismo rango de fechas — cualquier cambio en el
// emparejado o el matching de empleados allá (filasDesdeEventosMarcacion,
// guardarFilasHorasExtra, relojIndiceFichas, relojArmarDia) debe reflejarse
// aquí también, o las dos vías divergen con el tiempo.
//
// Ventana de sincronización: en vez de guardar "hasta dónde ya se sincronizó"
// y nunca volver a mirar atrás, cada corrida vuelve a procesar los últimos
// LOOKBACK_DIAS ya sincronizados además del día nuevo. Esto es lo que permite
// que un turno nocturno que cruza medianoche (entra el día D, sale muy
// temprano el día D+1) se corrija solo la noche siguiente: la corrida que
// procesó D todavía no conocía la marca de salida de D+1 (esa noche ni había
// ocurrido), así que D quedó con la jornada autocompletada a ciegas (ver
// guardarFilasHorasExtra); la corrida de la noche siguiente sí ve D+1 completo,
// arma el turno real, y como D sigue "pendiente" (nadie lo ha aprobado
// todavía) lo puede corregir sin pisar ninguna decisión ya tomada.
// Reprocesar un día ya sincronizado es seguro: los días con ESTADO distinto
// de "pendiente" (aprobados, rechazados, o vacaciones/incapacidades que
// ocuparon esa clave) simplemente se saltan, igual que al reimportar un
// archivo (ver guardarFilasHorasExtra en app.js).

const { query, conActor } = require("./db");
const rutasReloj = require("./rutas-reloj");
const {
  normalizarNombreParaMatch,
  normalizarCodigoEmpleado,
  nombreCompletoEmpleado,
  construirIndiceFichas,
} = require("./reloj-matching");

const PROPIEDAD_RELOJ = rutasReloj.PROPIEDAD_RELOJ;
const OFFSET_MIN = rutasReloj.OFFSET_MIN;
const OFFSET_MS = OFFSET_MIN * 60000;

const HORAS_EXTRA_PREFIX = "horas_extra:";
const EMPLEADO_PREFIX = "cat_empleado:";
const PUESTO_PREFIX = "cat_puesto:";
const SOLICITUD_AUSENCIA_PREFIX = "solicitud_ausencia:";
const RELOJ_ANULACION_PREFIX = "reloj_anulacion:";
const RELOJ_MANUAL_PREFIX = "reloj_manual:";
const SYNC_ESTADO_CLAVE = "config:reloj_sync_estado";

const FECHA_INICIO_SYNC = process.env.RELOJ_SYNC_FECHA_INICIO || "2026-09-10";
// 7 días (antes 2): un terminal que se queda sin batería guarda las marcas en
// su memoria interna y las sube al servidor varios días después, cuando se
// recarga — con solo 2 días de margen esa marca tardía llegaba después de que
// el marcador ya hubiera avanzado más allá de esa fecha, y el día se quedaba
// congelado con el cálculo viejo e incompleto para siempre (ver
// ejecutarRevisionProfunda más abajo para el caso de marcas que ni con 7 días
// alcanzan).
const LOOKBACK_DIAS = 7;
// Red de seguridad aparte de LOOKBACK_DIAS: una corrida mucho más generosa
// hacia atrás, pero solo una vez al día (no cada 5 minutos como la normal),
// para el caso extremo de una marca que llega más tarde incluso que los 7
// días de arriba (ej. un terminal varias semanas sin batería). Ver
// ejecutarRevisionProfunda.
const REVISION_PROFUNDA_DIAS = 30;

const JORNADA_DIARIA_POR_DEFECTO = 8;
const HORAS_POR_MODALIDAD = { turno_continuo_diurno: 8, turno_mixto: 7, turno_nocturno: 6 };
const TOLERANCIA_CORTESIA_HORAS = 20 / 60;
const RELOJ_VENTANA_DUPLICADO_MIN = 5;

// Jornada automática por horario real marcado (Art. 136 CT) — réplica exacta
// de minutosDiurnosYNocturnosEntre/jornadaAutomaticaDesdeMinutos/
// esPuestoDeSeguridad en app.js. La noche legal va de 7pm a 5am: si 3.5h
// (210min) o más del turno cae ahí, todo el turno es jornada nocturna (6h
// ordinarias); si cae algo pero menos, es mixta (7h); si no cae nada, diurna
// (8h). Por ahora acotado solo a los puestos de seguridad (ver el comentario
// de esPuestoDeSeguridad en app.js) — el resto sigue con la
// MODALIDAD_JORNADA fija del puesto.
const MINUTOS_NOCTURNOS_PARA_JORNADA_NOCTURNA = 210; // 3.5h

function minutosDiurnosYNocturnosEntre(tsIni, tsFin) {
  let diurnos = 0, nocturnos = 0;
  let cursor = tsIni;
  while (cursor < tsFin) {
    const d = new Date(cursor);
    const inicioDiaCivil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const horaActual = (cursor - inicioDiaCivil) / 3600000;
    const esNocturno = horaActual >= 19 || horaActual < 5;
    const siguienteCorteHora = esNocturno ? (horaActual < 5 ? 5 : 24) : 19;
    const siguienteCorte = inicioDiaCivil + siguienteCorteHora * 3600000;
    const fin = Math.min(tsFin, siguienteCorte);
    const minutos = (fin - cursor) / 60000;
    if (esNocturno) nocturnos += minutos; else diurnos += minutos;
    cursor = fin;
  }
  return { diurnos, nocturnos };
}

function jornadaAutomaticaDesdeMinutos(minutosDiurnos, minutosNocturnos) {
  if (minutosNocturnos <= 0) return "turno_continuo_diurno";
  if (minutosDiurnos <= 0 || minutosNocturnos >= MINUTOS_NOCTURNOS_PARA_JORNADA_NOCTURNA) return "turno_nocturno";
  return "turno_mixto";
}

function esPuestoDeSeguridad(puesto) {
  return !!(puesto && typeof puesto.PUESTO === "string" && /oficial\s+de\s+seguridad/i.test(puesto.PUESTO));
}

const ACTOR_SISTEMA = { id: null, email: "sistema:reloj-marcador (envío automático)", ip: null };

// Feriados de ley de Costa Rica (Arts. 147-148 CT) — réplica exacta de
// FERIADOS_LEY_CR_FIJOS en app.js (sin los facultativos/no obligatorios,
// que no llevan recargo garantizado por ley). Si esa lista cambia allá,
// debe cambiar aquí también.
const FERIADOS_LEY_CR_FIJOS = [
  { mes: 1, dia: 1 },
  { mes: 4, dia: 11 },
  { mes: 5, dia: 1 },
  { mes: 7, dia: 25 },
  { mes: 8, dia: 15 },
  { mes: 9, dia: 15 },
  { mes: 12, dia: 25 },
];
// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher, calendario
// gregoriano) — de ahí salen Jueves y Viernes Santo, réplica exacta de
// domingoDePascua/feriadosDeLeyDelAnio en app.js. Sin esto, un Jueves/
// Viernes Santo sin marcar quedaría sin crear en la corrida automática
// (aunque el botón manual sí lo detectaría, porque ese sí usa la versión
// completa de app.js) — justo el tipo de divergencia entre las dos vías que
// este archivo existe para evitar (ver comentario de cabecera).
function domingoDePascuaISO(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(anio, mes - 1, dia);
}
function isoDeFecha(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function feriadosFijosEnRango(desdeISO, hastaISO) {
  const fechas = [];
  const anioDesde = Number(desdeISO.slice(0, 4)), anioHasta = Number(hastaISO.slice(0, 4));
  for (let anio = anioDesde; anio <= anioHasta; anio++) {
    FERIADOS_LEY_CR_FIJOS.forEach((f) => {
      const fecha = `${anio}-${String(f.mes).padStart(2, "0")}-${String(f.dia).padStart(2, "0")}`;
      if (fecha >= desdeISO && fecha <= hastaISO) fechas.push(fecha);
    });
    const pascua = domingoDePascuaISO(anio);
    const juevesSanto = new Date(pascua); juevesSanto.setDate(pascua.getDate() - 3);
    const viernesSanto = new Date(pascua); viernesSanto.setDate(pascua.getDate() - 2);
    [juevesSanto, viernesSanto].forEach((d) => {
      const fecha = isoDeFecha(d);
      if (fecha >= desdeISO && fecha <= hastaISO) fechas.push(fecha);
    });
  }
  return fechas;
}
// Réplica mínima de parsearFechaDDMMYYYY (app.js) — solo el caso normal
// DD/MM/AAAA; el respaldo de fechas de Excel mal importadas no aplica aquí
// (FECHA_INGRESO_EMP casi siempre llega ya bien guardada a este punto).
function fechaDDMMYYYYaISO(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str || "").trim());
  if (!m) return null;
  let dia = Number(m[1]), mes = Number(m[2]);
  const anio = Number(m[3]);
  if (mes > 12 && dia <= 12) [dia, mes] = [mes, dia];
  if (mes < 1 || mes > 12) return null;
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

// --------------------------------------------------------------------------
// Helpers de fecha propios de este archivo (los de texto/emparejado de
// nombre ahora viven en reloj-matching.js, compartidos con rutas-reloj.js).
// --------------------------------------------------------------------------
function relojFechaDeTs(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function relojClaveMarca(codigo, ts) {
  return String(codigo) + ":" + String(ts);
}
function relojSumarDias(fecha, n) {
  const d = new Date(fecha + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function formatoFechaHoraCortaUTC(ts) {
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const h24 = d.getUTCHours();
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  const ap = h24 >= 12 ? "PM" : "AM";
  return `${dd}/${mm} ${h12}:${mi} ${ap}`;
}
function isoLocalDesdeTs(ts) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
function jornadaDiariaDePuesto(modalidad) {
  return HORAS_POR_MODALIDAD[modalidad] || JORNADA_DIARIA_POR_DEFECTO;
}
function aplicarToleranciaCortesia(excedenteHoras) {
  const minutos = Math.round(excedenteHoras * 60);
  return minutos > 20 ? excedenteHoras : 0;
}
function esEmpleadoConfianza(emp) {
  return !!(emp && (emp.EMPLEADO_CONFIANZA === true || emp.EMPLEADO_CONFIANZA === "true"));
}
function fechaCRDeAhora(offsetDias) {
  const d = new Date(Date.now() + OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + (offsetDias || 0));
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Lectura de catálogos y correcciones desde Postgres (equivalente a
// window.storage.list en app.js, pero directo contra la tabla).
// --------------------------------------------------------------------------
async function listarPorPrefijo(prefijo) {
  const like = prefijo.replace(/([\\%_])/g, "\\$1") + "%";
  const { rows } = await query(
    `SELECT clave, valor FROM documentos
      WHERE propiedad_id = $1 AND eliminado_en IS NULL AND clave LIKE $2 ESCAPE '\\'`,
    [PROPIEDAD_RELOJ, like]
  );
  return rows
    .map((r) => {
      try {
        return { clave: r.clave, valor: JSON.parse(r.valor) };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

async function obtenerDocumento(clave) {
  const { rows } = await query(
    `SELECT valor FROM documentos WHERE propiedad_id = $1 AND clave = $2 AND eliminado_en IS NULL`,
    [PROPIEDAD_RELOJ, clave]
  );
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].valor);
  } catch (e) {
    return null;
  }
}

async function guardarDocumento(clave, valorObjeto) {
  await conActor(ACTOR_SISTEMA, (c) =>
    c.query(
      `INSERT INTO documentos (propiedad_id, clave, valor, creado_por, actualizado_por)
       VALUES ($1, $2, $3, NULL, NULL)
       ON CONFLICT (propiedad_id, clave) DO UPDATE
         SET valor = EXCLUDED.valor, version = documentos.version + 1,
             actualizado_en = now(), actualizado_por = NULL,
             eliminado_en = NULL, eliminado_por = NULL`,
      [PROPIEDAD_RELOJ, clave, JSON.stringify(valorObjeto)]
    )
  );
}

// --------------------------------------------------------------------------
// Réplica del primer tramo de relojConstruirVista/relojArmarDia (app.js):
// marcas del reloj + manuales no duplicadas, sin las anuladas, dedupe de
// repetidas a menos de 5 minutos — el resultado ("usadas") es exactamente lo
// mismo que ve la jefatura en pantalla y lo que manda relojEnviarAHorasExtras.
// --------------------------------------------------------------------------
function marcasUsadasPorEmpleado(marcasReloj, anulaciones, manuales, desde, hasta) {
  const clavesReloj = new Set();
  const todas = [];
  marcasReloj.forEach((m) => {
    clavesReloj.add(relojClaveMarca(m.codigo, m.ts));
    todas.push({ codigo: String(m.codigo), nombre: m.nombre, ts: m.ts, fecha: relojFechaDeTs(m.ts) });
  });
  manuales.forEach((mm) => {
    if (!mm.FECHA || mm.FECHA < desde || mm.FECHA > hasta) return;
    if (clavesReloj.has(relojClaveMarca(mm.CODIGO, mm.TS))) return;
    todas.push({ codigo: String(mm.CODIGO), nombre: mm.NOMBRE || "", ts: Number(mm.TS), fecha: mm.FECHA });
  });
  const anuladas = new Set(Object.keys(anulaciones));
  todas.sort((a, b) => a.ts - b.ts);

  const porCodigo = {};
  todas.forEach((m) => {
    if (!porCodigo[m.codigo]) porCodigo[m.codigo] = { codigo: m.codigo, nombreReloj: m.nombre, marcas: [] };
    porCodigo[m.codigo].marcas.push(m);
  });

  const usadasPorCodigo = {}; // codigo -> [{codigo, nombre, fecha, ts}]
  Object.values(porCodigo).forEach((p) => {
    const validas = p.marcas.filter((m) => !anuladas.has(relojClaveMarca(m.codigo, m.ts)));
    const minutoDe = (m) => Math.floor(m.ts / 60000);
    const usadas = [];
    let ultima = null;
    validas.forEach((m) => {
      if (ultima !== null && minutoDe(m) - ultima < RELOJ_VENTANA_DUPLICADO_MIN) return;
      usadas.push(m);
      ultima = minutoDe(m);
    });
    usadasPorCodigo[p.codigo] = { nombreReloj: p.nombreReloj, usadas };
  });
  return usadasPorCodigo;
}

// --------------------------------------------------------------------------
// Réplica de filasDesdeEventosMarcacion (app.js): empareja por fecha civil
// primero (una marca entra y otra sale el mismo día), y si eso deja algún
// turno sospechosamente largo (más de UMBRAL_TURNO_SOSPECHOSO_HORAS — típico
// de un turno nocturno/mixto que cruza medianoche), reintenta con el
// emparejado cronológico puro (sin cortar por fecha civil) y se queda con el
// que de verdad resuelve el problema. Ya no depende de conocer de antemano
// la modalidad de jornada de cada persona (jornadaPorCodigo) — la decisión
// sale de las marcas mismas. También acumula los minutos diurnos/nocturnos
// de cada turno (ver minutosDiurnosYNocturnosEntre), que guardarFilas usa
// para clasificar automáticamente la jornada de los puestos de seguridad.
// --------------------------------------------------------------------------
const UMBRAL_TURNO_SOSPECHOSO_HORAS = 12;

function filasDesdeEventosMarcacion(eventos) {
  if (!eventos.length) return [];

  const porEmpleado = {};
  eventos.forEach((ev) => {
    (porEmpleado[ev.codigo] = porEmpleado[ev.codigo] || { nombre: ev.nombre, marcas: [] }).marcas.push(ev);
  });

  const porDia = {};
  const filasIncompletas = [];

  const registrarPar = (codigo, nombre, fecha, marcaIn, marcaOut) => {
    const horas = (marcaOut.ts - marcaIn.ts) / 3600000;
    if (horas <= 0 || horas > 20) return;
    const key = codigo + "|" + fecha;
    if (!porDia[key]) porDia[key] = { codigo, nombre, fecha, horas: 0, marcas: [], minutosDiurnos: 0, minutosNocturnos: 0 };
    porDia[key].horas += horas;
    porDia[key].marcas.push({ entrada: formatoFechaHoraCortaUTC(marcaIn.ts), salida: formatoFechaHoraCortaUTC(marcaOut.ts) });
    const { diurnos, nocturnos } = minutosDiurnosYNocturnosEntre(marcaIn.ts, marcaOut.ts);
    porDia[key].minutosDiurnos += diurnos;
    porDia[key].minutosNocturnos += nocturnos;
  };
  const registrarSuelta = (codigo, nombre, fecha, marca) => {
    filasIncompletas.push({ CODIGO: codigo, NOMBRE: nombre, FECHA: fecha, MARCA_SUELTA: isoLocalDesdeTs(marca.ts), INCOMPLETO: true });
  };

  const paresCiviles = (marcas) => {
    const pares = [], sueltas = [];
    const porFecha = {};
    marcas.forEach((ev) => { (porFecha[ev.fecha] = porFecha[ev.fecha] || []).push(ev); });
    Object.values(porFecha).forEach((marcasDelDiaOriginal) => {
      const dia = marcasDelDiaOriginal.slice().sort((a, b) => a.ts - b.ts);
      for (let i = 0; i + 1 < dia.length; i += 2) pares.push([dia[i], dia[i + 1]]);
      if (dia.length % 2 === 1) sueltas.push(dia[dia.length - 1]);
    });
    return { pares, sueltas };
  };

  const paresCronologicos = (marcas) => {
    const ordenadas = marcas.slice().sort((a, b) => a.ts - b.ts);
    const pares = [], sueltas = [];
    let inicio = 0;
    if (ordenadas.length && new Date(ordenadas[0].ts).getUTCHours() < 12) {
      sueltas.push(ordenadas[0]);
      inicio = 1;
    }
    for (let i = inicio; i + 1 < ordenadas.length; i += 2) pares.push([ordenadas[i], ordenadas[i + 1]]);
    if ((ordenadas.length - inicio) % 2 === 1) sueltas.push(ordenadas[ordenadas.length - 1]);
    return { pares, sueltas };
  };

  const duracionMaximaHoras = (pares) => pares.reduce((max, [a, b]) => Math.max(max, (b.ts - a.ts) / 3600000), 0);

  Object.entries(porEmpleado).forEach(([codigo, info]) => {
    const civil = paresCiviles(info.marcas);
    let elegido = civil;
    if (duracionMaximaHoras(civil.pares) > UMBRAL_TURNO_SOSPECHOSO_HORAS) {
      const cronologico = paresCronologicos(info.marcas);
      if (duracionMaximaHoras(cronologico.pares) < duracionMaximaHoras(civil.pares)) elegido = cronologico;
    }
    elegido.pares.forEach(([entrada, salida]) => registrarPar(codigo, info.nombre, entrada.fecha, entrada, salida));
    elegido.sueltas.forEach((m) => registrarSuelta(codigo, info.nombre, m.fecha, m));
  });

  const filas = Object.values(porDia)
    .filter((d) => d.horas > 0)
    .map((d) => ({ CODIGO: d.codigo, NOMBRE: d.nombre, FECHA: d.fecha, HORAS_TRABAJADAS: Math.round(d.horas * 100) / 100, MARCAS: d.marcas, MINUTOS_DIURNOS: d.minutosDiurnos, MINUTOS_NOCTURNOS: d.minutosNocturnos }));
  return filas.concat(filasIncompletas);
}

// --------------------------------------------------------------------------
// Réplica del tramo relevante de guardarFilasHorasExtra (app.js) para filas
// que YA vienen con FICHA_RELOJ resuelta (o vacía = sin identificar) — no
// hace falta portar el matching genérico por cédula/número/nombre que usan
// los archivos subidos a mano: ese es solo un respaldo para cuando no se
// conoce la ficha de antemano, y las filas del reloj siempre la traen.
// --------------------------------------------------------------------------
// Réplica de marcasComoTexto (app.js) — ver el aviso en guardarFilas.
function marcasComoTexto(marcas) {
  return (Array.isArray(marcas) ? marcas : []).map((m) => `${m.entrada || "?"} → ${m.salida || "?"}`).join(", ");
}

// Réplica de marcasJornadaCompletaDesde (app.js) — arma entrada/salida de
// una jornada completa a partir de UNA marca suelta + la jornada del
// puesto, para autocompletar el "día de salida" (ver guardarFilas). null si
// la marca no se pudo leer.
function marcasJornadaCompletaDesde(marcaSuelta, jornadaHoras) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(marcaSuelta || "");
  if (!m) return null;
  const entradaTs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const salidaTs = entradaTs + Math.round(jornadaHoras * 60) * 60000;
  return { entrada: formatoFechaHoraCortaUTC(entradaTs), salida: formatoFechaHoraCortaUTC(salidaTs) };
}

async function guardarFilas(filas, porKey, puestoPorKey, nombreArchivo, diasSaleAprobados) {
  let creadas = 0, actualizadas = 0, omitidas = 0, sinMatch = 0, confianzaOmitidos = 0;
  diasSaleAprobados = diasSaleAprobados || new Set();

  for (const fila of filas) {
    const empleado = fila.FICHA_RELOJ ? porKey[fila.FICHA_RELOJ] || null : null;
    if (esEmpleadoConfianza(empleado)) { confianzaOmitidos++; continue; }

    const puesto = empleado && empleado.PUESTO_KEY ? puestoPorKey[empleado.PUESTO_KEY] || null : null;
    // Jornada automática por horario real marcado (ver comentario arriba de
    // esPuestoDeSeguridad) — solo para puestos de seguridad; el resto sigue
    // con la MODALIDAD_JORNADA fija del puesto.
    const totalMinutosClasificados = (fila.MINUTOS_DIURNOS || 0) + (fila.MINUTOS_NOCTURNOS || 0);
    const jornada = (esPuestoDeSeguridad(puesto) && totalMinutosClasificados > 0)
      ? jornadaDiariaDePuesto(jornadaAutomaticaDesdeMinutos(fila.MINUTOS_DIURNOS || 0, fila.MINUTOS_NOCTURNOS || 0))
      : jornadaDiariaDePuesto(puesto && puesto.MODALIDAD_JORNADA);

    const marcas = fila.MARCAS || [];
    const incompleto = !!fila.INCOMPLETO;
    const marcaSuelta = fila.MARCA_SUELTA || null;
    // Turno con una sola marca: NO se asume la jornada completa del puesto,
    // ni siquiera con el empleado identificado — eso ocultaba que faltó una
    // marca real. Se deja INCOMPLETO/MARCA_SUELTA tal cual, para que la fila
    // pase por "⚠️ Turno sin marcar" en el panel de Horas extras y sea
    // jefatura/gerencia quien decida la hora de salida (ver
    // mostrarModalCompletarTurno en app.js), no el envío automático —
    // EXCEPTO cuando ese día ya es el "día de salida" de una ausencia
    // aprobada para este mismo empleado (ver diasSaleAprobados, armado en
    // sincronizarReloj más abajo, réplica exacta de guardarFilasHorasExtra
    // en app.js): ahí sí se autocompleta solo, más abajo.

    const horasTrabajadas = fila.HORAS_TRABAJADAS || 0;
    const excedente = horasTrabajadas > jornada ? horasTrabajadas - jornada : 0;
    const horasExtra = aplicarToleranciaCortesia(excedente);
    const huboTrabajo = horasTrabajadas > 0 || marcas.length > 0;
    if (!huboTrabajo && !incompleto) continue;

    const marcasSiSalida = (incompleto && empleado && marcaSuelta
        && diasSaleAprobados.has(empleado.key + "|" + fila.FECHA))
      ? marcasJornadaCompletaDesde(marcaSuelta, jornada)
      : null;

    const identificador = normalizarCodigoEmpleado(fila.CODIGO) || normalizarNombreParaMatch(fila.NOMBRE) || "";
    const key = HORAS_EXTRA_PREFIX + (empleado ? empleado.key : "sinmatch-" + identificador) + ":" + fila.FECHA;
    const existente = await obtenerDocumento(key);
    // Réplica exacta del aviso de guardarFilasHorasExtra (app.js): un
    // registro ya decidido no se toca, pero si el reloj ya trae marcas
    // reales distintas a las que se usaron para decidir (típico de un turno
    // quebrado completado a mano con una sola marca, antes de que llegaran
    // las que faltaban), se prende un aviso sin pisar ESTADO/HORAS_EXTRA.
    if (existente && existente.ESTADO !== "pendiente") {
      omitidas++;
      if (Array.isArray(marcas) && marcas.length) {
        const detalleFresco = marcasComoTexto(marcas);
        if (detalleFresco !== marcasComoTexto(existente.MARCAS) && existente.ALERTA_MARCAS_NUEVAS_DETALLE !== detalleFresco) {
          try {
            existente.ALERTA_MARCAS_NUEVAS = true;
            existente.ALERTA_MARCAS_NUEVAS_DETALLE = detalleFresco;
            existente.ALERTA_MARCAS_NUEVAS_EN = new Date().toISOString();
            await guardarDocumento(key, existente);
          } catch (e) { /* no crítico: se reintenta en la próxima corrida */ }
        }
      }
      continue;
    }

    const valor = {
      CODIGO_ARCHIVO: fila.CODIGO,
      NOMBRE_ARCHIVO: fila.NOMBRE,
      CEDULA: "",
      EMPLEADO_KEY: empleado ? empleado.key : null,
      FECHA: fila.FECHA,
      HORAS_EXTRA: Math.round(horasExtra * 100) / 100,
      MARCAS: marcas,
      INCOMPLETO: incompleto,
      MARCA_SUELTA: marcaSuelta,
      AUTOCOMPLETADO: false,
      TIPO_DIA: incompleto ? null : "laboral",
      ESTADO: "pendiente",
      ORIGEN_ARCHIVO: nombreArchivo,
      IMPORTADO_EN: new Date().toISOString(),
    };
    if (marcasSiSalida) {
      valor.HORAS_EXTRA = 0;
      valor.MARCAS = [marcasSiSalida];
      valor.INCOMPLETO = false;
      valor.MARCA_SUELTA = null;
      valor.AUTOCOMPLETADO = true;
      valor.AUTOCOMPLETADO_DIA_SALIDA = true;
      valor.TIPO_DIA = "laboral";
      valor.ESTADO = "aprobada_jefatura";
      valor.APROBADO_POR = "Sistema (día de salida)";
      valor.FECHA_DECISION = new Date().toISOString();
    }
    await guardarDocumento(key, valor);
    if (!empleado) sinMatch++;
    else if (existente) actualizadas++;
    else creadas++;
  }

  return { creadas, actualizadas, omitidas, sinMatch, confianzaOmitidos };
}

// --------------------------------------------------------------------------
// Feriados de ley sin ninguna marca dentro del rango: a diferencia de una
// importación de archivo completo, el reloj nunca genera un registro para
// un día sin NINGUNA marca (no compara contra un turno esperado) — así que
// un feriado sin marcar quedaba invisible para la planilla en vez de
// presumirse trabajado (réplica de crearFeriadosSinMarcaDelReloj en
// app.js — mismo criterio si esa cambia). Se crea "Día laboral" pendiente
// (0h extra, sin marcas) para cada empleado activo, sin puesto de
// confianza, que ya hubiera ingresado para esa fecha — salvo que YA exista
// cualquier registro ahí (con marca, ya reclasificado, o ya decidido), en
// cuyo caso no se toca.
// --------------------------------------------------------------------------
async function crearFeriadosSinMarcaDelReloj(empleados, desdeISO, hastaISO) {
  const feriadosEnRango = feriadosFijosEnRango(desdeISO, hastaISO);
  if (!feriadosEnRango.length) return { creados: 0 };

  let creados = 0;
  for (const emp of empleados) {
    if (emp.ARCHIVADO || esEmpleadoConfianza(emp)) continue;
    const ingresoISO = fechaDDMMYYYYaISO(emp.FECHA_INGRESO_EMP);
    for (const fecha of feriadosEnRango) {
      if (ingresoISO && fecha < ingresoISO) continue;
      const key = HORAS_EXTRA_PREFIX + emp.key + ":" + fecha;
      const existente = await obtenerDocumento(key);
      if (existente) continue;
      await guardarDocumento(key, {
        EMPLEADO_KEY: emp.key,
        FECHA: fecha,
        HORAS_EXTRA: 0,
        MARCAS: [],
        INCOMPLETO: false,
        MARCA_SUELTA: null,
        TIPO_DIA: "laboral",
        ESTADO: "pendiente",
        ORIGEN: "feriado_sin_marca",
        IMPORTADO_EN: new Date().toISOString(),
      });
      creados++;
    }
  }
  return { creados };
}

// --------------------------------------------------------------------------
// Punto de entrada: sincroniza un rango [desde, hasta] (fechas ISO,
// inclusive) exactamente como lo haría relojEnviarAHorasExtras para ese
// mismo rango.
// --------------------------------------------------------------------------
async function sincronizarRango(desde, hasta) {
  const pool = rutasReloj.obtenerPool();
  if (!pool) return { configurado: false };

  const ini = Date.parse(desde + "T00:00:00Z");
  const fin = Date.parse(hasta + "T00:00:00Z") + 24 * 60 * 60 * 1000;
  const filasMysql = await rutasReloj.consultar(
    `SELECT PersonID AS codigo, PersonName AS nombre, AttendanceDateTime AS ts, DeviceName AS dispositivo
       FROM AttendanceRecordInfo
      WHERE AttendanceDateTime >= ? AND AttendanceDateTime < ?
      ORDER BY AttendanceDateTime`,
    [rutasReloj.aUtc(ini), rutasReloj.aUtc(fin)]
  );
  const marcasReloj = filasMysql.map((f) => ({
    codigo: String(f.codigo),
    nombre: String(f.nombre || "").trim(),
    ts: rutasReloj.aPared(f.ts),
    dispositivo: f.dispositivo || "",
  }));

  const [empleadosDocs, puestosDocs, anulacionesDocs, manualesDocs, solicitudesDocs] = await Promise.all([
    listarPorPrefijo(EMPLEADO_PREFIX),
    listarPorPrefijo(PUESTO_PREFIX),
    listarPorPrefijo(RELOJ_ANULACION_PREFIX),
    listarPorPrefijo(RELOJ_MANUAL_PREFIX),
    listarPorPrefijo(SOLICITUD_AUSENCIA_PREFIX),
  ]);
  // "Día de salida": réplica exacta del cálculo que hace guardarFilasHorasExtra
  // en app.js (y, para la pantalla, etiquetaCalendarioParaDia) — el día antes
  // de que arranque una vacación/día libre/permiso sin goce YA APROBADO, para
  // autocompletar sin esperar a jefatura un turno con una sola marca ese día.
  const diasSaleAprobados = new Set();
  solicitudesDocs.forEach((d) => {
    const s = d.valor;
    if (!s || s.ESTADO !== "aprobada" || !s.FECHA_INICIO || !s.EMPLEADO_KEY) return;
    if (s.TIPO !== "vacaciones" && s.TIPO !== "dia_libre" && s.TIPO !== "permiso_sin_goce") return;
    diasSaleAprobados.add(s.EMPLEADO_KEY + "|" + relojSumarDias(s.FECHA_INICIO, -1));
  });
  const empleados = empleadosDocs.map((d) => ({ key: d.clave.slice(EMPLEADO_PREFIX.length), ...d.valor }));
  const porKey = {};
  empleados.forEach((e) => { porKey[e.key] = e; });
  const puestoPorKey = {};
  puestosDocs.forEach((d) => { puestoPorKey[d.clave.slice(PUESTO_PREFIX.length)] = d.valor; });
  const anulaciones = {};
  anulacionesDocs.forEach((d) => { anulaciones[relojClaveMarca(d.valor.CODIGO, d.valor.TS)] = d.valor; });
  const manuales = manualesDocs.map((d) => d.valor);

  const usadasPorCodigo = marcasUsadasPorEmpleado(marcasReloj, anulaciones, manuales, desde, hasta);
  const fichasDe = construirIndiceFichas(empleados);

  const eventos = [];
  Object.entries(usadasPorCodigo).forEach(([codigo, info]) => {
    info.usadas.forEach((m) => {
      eventos.push({ codigo, nombre: info.nombreReloj, fecha: m.fecha, ts: Math.floor(m.ts / 60000) * 60000 });
    });
  });

  // Corre siempre, tenga o no marcas esta corrida — un feriado sin marcar
  // no depende de que haya habido actividad en el reloj ese rango.
  const { creados: feriadosCreados } = await crearFeriadosSinMarcaDelReloj(empleados, desde, hasta);

  if (!eventos.length) return { configurado: true, creadas: feriadosCreados, actualizadas: 0, omitidas: 0, sinMatch: 0, confianzaOmitidos: 0, feriadosCreados };

  const filasSinFiltrar = filasDesdeEventosMarcacion(eventos);
  // El día de hoy (Costa Rica) sigue en curso — una sola marca todavía NO
  // significa "turno sin marcar" (⚠️), puede ser que la persona simplemente
  // no ha terminado su jornada. Se descartan esas filas incompletas de HOY
  // sin escribir nada (ni "Turno sin marcar" ni, sobre todo, el
  // autocompletado del "día de salida" — ver diasSaleAprobados: aprobar
  // solo una jornada a medio terminar sería peor que no tocarla). Un turno
  // ya completo (entrada+salida) de hoy sí se guarda de una vez, así Horas
  // Extra se actualiza apenas cierra cada turno en vez de esperar a que el
  // día completo termine. Mañana, cuando "hoy" ya sea "ayer", esta misma
  // fila (si sigue sin la marca que falta) se procesa como INCOMPLETO normal.
  const hoyCR = fechaCRDeAhora(0);
  const filas = filasSinFiltrar.filter((f) => !(f.FECHA === hoyCR && f.INCOMPLETO));
  filas.forEach((f) => {
    const ficha = fichasDe(f.CODIGO, (usadasPorCodigo[f.CODIGO] || {}).nombreReloj);
    f.FICHA_RELOJ = ficha ? ficha.key : "";
  });

  const nombreArchivo = `Reloj marcador (automático) ${desde} a ${hasta}`;
  const resultado = await guardarFilas(filas, porKey, puestoPorKey, nombreArchivo, diasSaleAprobados);
  return { configurado: true, ...resultado, creadas: resultado.creadas + feriadosCreados, feriadosCreados };
}

// --------------------------------------------------------------------------
// Corrida periódica: calcula la ventana [desde, hasta] a partir del último
// bookmark guardado (o desde FECHA_INICIO_SYNC si es la primera vez) y la
// sincroniza. "hasta" llega siempre hasta HOY (no solo hasta ayer) para que
// una marca recién caída en el reloj se refleje en minutos — ver la
// programación cada pocos minutos en server.js, y el filtro de turnos de
// hoy que siguen abiertos dentro de sincronizarRango. El bookmark
// (ULTIMA_FECHA) sí sigue anotando solo hasta "ayer": hoy nunca cuenta como
// ya sincronizado del todo mientras siga en curso, así que cada corrida lo
// vuelve a revisar con las marcas más recientes en vez de darlo por hecho.
// --------------------------------------------------------------------------
async function ejecutarSincronizacionDiaria() {
  if (!process.env.RELOJ_MYSQL_URL) return { configurado: false };

  const hastaCerrado = fechaCRDeAhora(-1); // "ayer" — hasta acá avanza el bookmark
  const hoy = fechaCRDeAhora(0);
  const estado = await obtenerDocumento(SYNC_ESTADO_CLAVE);
  const ultimaFecha = estado && estado.ULTIMA_FECHA;
  const desdeCatchUp = ultimaFecha ? relojSumarDias(ultimaFecha, 1) : FECHA_INICIO_SYNC;
  const desdeConMargen = ultimaFecha ? relojSumarDias(ultimaFecha, 1 - LOOKBACK_DIAS) : FECHA_INICIO_SYNC;
  const desde = desdeConMargen < FECHA_INICIO_SYNC ? FECHA_INICIO_SYNC : desdeConMargen;

  if (desde > hoy) return { configurado: true, saltado: true };

  const resultado = await sincronizarRango(desde, hoy);
  // Solo se adelanta el bookmark si de verdad se cubrió algún día ya
  // cerrado (desde <= ayer) — si "desde" cayó después de ayer (ej. ya
  // estaba al día y esta corrida solo repasó hoy), no hay ningún día nuevo
  // que dar por sincronizado.
  if (resultado.configurado && desde <= hastaCerrado) await marcarUltimaFechaSincronizada(hastaCerrado, resultado);
  return { desde, hasta: hoy, catchUpDesde: desdeCatchUp, ...resultado };
}

// Actualiza el bookmark de la corrida diaria (ver arriba) — se expone aparte
// para que un resync manual (ej. scripts/resincronizar-reloj-horas-extra.js)
// pueda dejar la ventana automática apuntando al mismo lugar donde terminó,
// en vez de que la próxima corrida automática vuelva a repetir todo el rango.
async function marcarUltimaFechaSincronizada(hasta, resultado) {
  await guardarDocumento(SYNC_ESTADO_CLAVE, { ULTIMA_FECHA: hasta, ACTUALIZADO_EN: new Date().toISOString(), ULTIMO_RESULTADO: resultado || null });
}

// Revisión profunda (ver REVISION_PROFUNDA_DIAS arriba): repasa los últimos
// REVISION_PROFUNDA_DIAS días completos, sin importar dónde vaya el bookmark
// de la corrida normal. Reprocesar un día ya sincronizado es seguro (ver el
// aviso de guardarFilas): cualquier día con ESTADO distinto de "pendiente" se
// salta tal cual, nunca se pisa una decisión ya tomada — así que esta corrida
// solo puede rellenar huecos, nunca deshacer nada. A propósito NO toca el
// bookmark (ULTIMA_FECHA): es un repaso extra, no la fuente de verdad de
// hasta dónde ya se sincronizó esa ventana normal.
async function ejecutarRevisionProfunda() {
  if (!process.env.RELOJ_MYSQL_URL) return { configurado: false };
  const hoy = fechaCRDeAhora(0);
  const desdeSinTope = relojSumarDias(hoy, -REVISION_PROFUNDA_DIAS);
  const desde = desdeSinTope < FECHA_INICIO_SYNC ? FECHA_INICIO_SYNC : desdeSinTope;
  const resultado = await sincronizarRango(desde, hoy);
  return { desde, hasta: hoy, ...resultado };
}

module.exports = {
  sincronizarRango,
  ejecutarSincronizacionDiaria,
  ejecutarRevisionProfunda,
  marcarUltimaFechaSincronizada,
  FECHA_INICIO_SYNC,
};
