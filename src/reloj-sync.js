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

const PROPIEDAD_RELOJ = rutasReloj.PROPIEDAD_RELOJ;
const OFFSET_MIN = rutasReloj.OFFSET_MIN;
const OFFSET_MS = OFFSET_MIN * 60000;

const HORAS_EXTRA_PREFIX = "horas_extra:";
const EMPLEADO_PREFIX = "cat_empleado:";
const PUESTO_PREFIX = "cat_puesto:";
const RELOJ_ANULACION_PREFIX = "reloj_anulacion:";
const RELOJ_MANUAL_PREFIX = "reloj_manual:";
const SYNC_ESTADO_CLAVE = "config:reloj_sync_estado";

const FECHA_INICIO_SYNC = process.env.RELOJ_SYNC_FECHA_INICIO || "2026-09-10";
const LOOKBACK_DIAS = 2;

const JORNADA_DIARIA_POR_DEFECTO = 8;
const HORAS_POR_MODALIDAD = { turno_continuo_diurno: 8, turno_mixto: 7, turno_nocturno: 6 };
const TOLERANCIA_CORTESIA_HORAS = 20 / 60;
const RELOJ_VENTANA_DUPLICADO_MIN = 5;

const ACTOR_SISTEMA = { id: null, email: "sistema:reloj-marcador (envío automático)", ip: null };

// --------------------------------------------------------------------------
// Helpers de texto/fecha — réplica exacta de sus equivalentes en app.js. Ver
// el comentario de cabecera: si esos cambian allá, deben cambiar aquí igual.
// --------------------------------------------------------------------------
function normalizarNombreParaMatch(nombre) {
  return String(nombre || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizarCodigoEmpleado(v) {
  const digits = String(v == null ? "" : v).replace(/\D/g, "");
  return digits.slice(-4).replace(/^0+/, "");
}
function relojNumeroExacto(v) {
  return String(v == null ? "" : v)
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}
function nombreCompletoEmpleado(emp) {
  if (!emp) return "";
  const nombre = (emp.NOMBRE_EMP || "").trim();
  const apellidos = (emp.APELLIDOS_EMP || "").trim();
  return apellidos ? `${apellidos} ${nombre}`.trim() : nombre;
}
function palabrasDeNombre(s) {
  return new Set(normalizarNombreParaMatch(s).split(" ").filter((t) => t.length > 1));
}
function relojNombresCompatibles(nombreA, nombreB) {
  const a = palabrasDeNombre(nombreA), b = palabrasDeNombre(nombreB);
  const comunes = [...a].filter((t) => b.has(t)).length;
  return comunes >= Math.min(2, a.size, b.size) && comunes > 0;
}
function desempatarFichasPorNombre(candidatos, nombre) {
  const buscado = palabrasDeNombre(nombre);
  if (!buscado.size) return [];
  return candidatos.filter((e) => {
    const deFicha = palabrasDeNombre(nombreCompletoEmpleado(e));
    if (!deFicha.size) return false;
    const [corto, largo] = buscado.size <= deFicha.size ? [buscado, deFicha] : [deFicha, buscado];
    return [...corto].every((t) => largo.has(t));
  });
}
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
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
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
// Réplica de relojIndiceFichas (app.js) — ver ahí la explicación de cada
// prioridad de emparejado (ID_RELOJ explícito, planilla de colones exacta,
// respaldo por últimos 4 dígitos).
// --------------------------------------------------------------------------
function construirIndiceFichas(empleados) {
  const porIdReloj = {}, porNumeroColones = {}, porUltimos4Colones = {};
  empleados.forEach((e) => {
    const idReloj = relojNumeroExacto(e.ID_RELOJ);
    if (idReloj) {
      (porIdReloj[idReloj] = porIdReloj[idReloj] || []).push(e);
      return;
    }
    if (e.MONEDA_SALARIO_EMP === "USD") return;
    const n = relojNumeroExacto(e.NUMERO_EMPLEADO);
    if (n) (porNumeroColones[n] = porNumeroColones[n] || []).push(e);
    const u = normalizarCodigoEmpleado(e.NUMERO_EMPLEADO);
    if (u) (porUltimos4Colones[u] = porUltimos4Colones[u] || []).push(e);
  });

  return (codigo, nombreReloj) => {
    const c = relojNumeroExacto(codigo);
    const explicitas = porIdReloj[c] || [];
    if (explicitas.length === 1) return explicitas[0];
    if (explicitas.length > 1) {
      const porNombre = desempatarFichasPorNombre(explicitas, nombreReloj);
      return porNombre.length === 1 ? porNombre[0] : null;
    }
    const candidatos = porNumeroColones[c] || [];
    if (!candidatos.length) {
      const porCola = (porUltimos4Colones[normalizarCodigoEmpleado(codigo)] || []).filter(
        (e) => nombreReloj && relojNombresCompatibles(nombreReloj, nombreCompletoEmpleado(e))
      );
      return porCola.length === 1 ? porCola[0] : null;
    }
    const compatibles = candidatos.filter((e) => !nombreReloj || relojNombresCompatibles(nombreReloj, nombreCompletoEmpleado(e)));
    if (compatibles.length === 1) return compatibles[0];
    if (compatibles.length > 1) {
      const porNombre = desempatarFichasPorNombre(compatibles, nombreReloj);
      return porNombre.length === 1 ? porNombre[0] : null;
    }
    return null;
  };
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
// Réplica de filasDesdeEventosMarcacion (app.js), incluido el emparejado de
// turnos nocturnos/mixtos que cruzan medianoche.
// --------------------------------------------------------------------------
function filasDesdeEventosMarcacion(eventos, jornadaPorCodigo) {
  if (!eventos.length) return [];

  const porEmpleado = {};
  eventos.forEach((ev) => {
    (porEmpleado[ev.codigo] = porEmpleado[ev.codigo] || { nombre: ev.nombre, marcas: [] }).marcas.push(ev);
  });

  const porDia = {};
  const filasIncompletas = [];
  Object.entries(porEmpleado).forEach(([codigo, info]) => {
    const porFecha = {};
    info.marcas.forEach((ev) => { (porFecha[ev.fecha] = porFecha[ev.fecha] || []).push(ev); });

    const puedeCruzarMedianoche = ["turno_nocturno", "turno_mixto"].includes(jornadaPorCodigo(codigo));
    const fusionaConMañana = new Set();
    const fusionadaDesdeAyer = new Set();
    if (puedeCruzarMedianoche) {
      Object.keys(porFecha).sort().forEach((fecha) => {
        if (porFecha[fecha].length !== 1) return;
        const mañana = relojSumarDias(fecha, 1);
        const marcasMañana = porFecha[mañana];
        if (!marcasMañana || marcasMañana.length !== 1) return;
        const horas = (marcasMañana[0].ts - porFecha[fecha][0].ts) / 3600000;
        if (horas <= 0 || horas > 20) return;
        fusionaConMañana.add(fecha);
        fusionadaDesdeAyer.add(mañana);
      });
    }

    Object.entries(porFecha).forEach(([fecha, marcasDelDiaOriginal]) => {
      if (fusionadaDesdeAyer.has(fecha)) return;
      const marcasDelDia = fusionaConMañana.has(fecha)
        ? [marcasDelDiaOriginal[0], porFecha[relojSumarDias(fecha, 1)][0]]
        : marcasDelDiaOriginal;
      const marcas = marcasDelDia.slice().sort((a, b) => a.ts - b.ts);
      for (let i = 0; i + 1 < marcas.length; i += 2) {
        const horas = (marcas[i + 1].ts - marcas[i].ts) / 3600000;
        if (horas <= 0 || horas > 20) continue;
        const key = codigo + "|" + fecha;
        if (!porDia[key]) porDia[key] = { codigo, nombre: info.nombre, fecha, horas: 0, marcas: [] };
        porDia[key].horas += horas;
        porDia[key].marcas.push({ entrada: formatoFechaHoraCortaUTC(marcas[i].ts), salida: formatoFechaHoraCortaUTC(marcas[i + 1].ts) });
      }
      if (marcas.length % 2 === 1) {
        const suelta = marcas[marcas.length - 1];
        filasIncompletas.push({ CODIGO: codigo, NOMBRE: info.nombre, FECHA: fecha, MARCA_SUELTA: isoLocalDesdeTs(suelta.ts), INCOMPLETO: true });
      }
    });
  });

  const filas = Object.values(porDia)
    .filter((d) => d.horas > 0)
    .map((d) => ({ CODIGO: d.codigo, NOMBRE: d.nombre, FECHA: d.fecha, HORAS_TRABAJADAS: Math.round(d.horas * 100) / 100, MARCAS: d.marcas }));
  return filas.concat(filasIncompletas);
}

// --------------------------------------------------------------------------
// Réplica del tramo relevante de guardarFilasHorasExtra (app.js) para filas
// que YA vienen con FICHA_RELOJ resuelta (o vacía = sin identificar) — no
// hace falta portar el matching genérico por cédula/número/nombre que usan
// los archivos subidos a mano: ese es solo un respaldo para cuando no se
// conoce la ficha de antemano, y las filas del reloj siempre la traen.
// --------------------------------------------------------------------------
async function guardarFilas(filas, porKey, puestoPorKey, nombreArchivo) {
  let creadas = 0, actualizadas = 0, omitidas = 0, sinMatch = 0, confianzaOmitidos = 0;

  for (const fila of filas) {
    const empleado = fila.FICHA_RELOJ ? porKey[fila.FICHA_RELOJ] || null : null;
    if (esEmpleadoConfianza(empleado)) { confianzaOmitidos++; continue; }

    const puesto = empleado && empleado.PUESTO_KEY ? puestoPorKey[empleado.PUESTO_KEY] || null : null;
    const jornada = jornadaDiariaDePuesto(puesto && puesto.MODALIDAD_JORNADA);

    const marcas = fila.MARCAS || [];
    const incompleto = !!fila.INCOMPLETO;
    const marcaSuelta = fila.MARCA_SUELTA || null;
    // Turno con una sola marca: NO se asume la jornada completa del puesto,
    // ni siquiera con el empleado identificado — eso ocultaba que faltó una
    // marca real. Se deja INCOMPLETO/MARCA_SUELTA tal cual, para que la fila
    // pase por "⚠️ Turno sin marcar" en el panel de Horas extras y sea
    // jefatura/gerencia quien decida la hora de salida (ver
    // mostrarModalCompletarTurno en app.js), no el envío automático.

    const horasTrabajadas = fila.HORAS_TRABAJADAS || 0;
    const excedente = horasTrabajadas > jornada ? horasTrabajadas - jornada : 0;
    const horasExtra = aplicarToleranciaCortesia(excedente);
    const huboTrabajo = horasTrabajadas > 0 || marcas.length > 0;
    if (!huboTrabajo && !incompleto) continue;

    const identificador = normalizarCodigoEmpleado(fila.CODIGO) || normalizarNombreParaMatch(fila.NOMBRE) || "";
    const key = HORAS_EXTRA_PREFIX + (empleado ? empleado.key : "sinmatch-" + identificador) + ":" + fila.FECHA;
    const existente = await obtenerDocumento(key);
    if (existente && existente.ESTADO !== "pendiente") { omitidas++; continue; }

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
    await guardarDocumento(key, valor);
    if (!empleado) sinMatch++;
    else if (existente) actualizadas++;
    else creadas++;
  }

  return { creadas, actualizadas, omitidas, sinMatch, confianzaOmitidos };
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

  const [empleadosDocs, puestosDocs, anulacionesDocs, manualesDocs] = await Promise.all([
    listarPorPrefijo(EMPLEADO_PREFIX),
    listarPorPrefijo(PUESTO_PREFIX),
    listarPorPrefijo(RELOJ_ANULACION_PREFIX),
    listarPorPrefijo(RELOJ_MANUAL_PREFIX),
  ]);
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
  const jornadaPorCodigoMap = {};
  Object.entries(usadasPorCodigo).forEach(([codigo, info]) => {
    const ficha = fichasDe(codigo, info.nombreReloj);
    jornadaPorCodigoMap[codigo] = ficha && ficha.PUESTO_KEY ? (puestoPorKey[ficha.PUESTO_KEY] || {}).MODALIDAD_JORNADA || null : null;
    info.usadas.forEach((m) => {
      eventos.push({ codigo, nombre: info.nombreReloj, fecha: m.fecha, ts: Math.floor(m.ts / 60000) * 60000 });
    });
  });
  if (!eventos.length) return { configurado: true, creadas: 0, actualizadas: 0, omitidas: 0, sinMatch: 0, confianzaOmitidos: 0 };

  const filas = filasDesdeEventosMarcacion(eventos, (codigo) => jornadaPorCodigoMap[codigo] || null);
  filas.forEach((f) => {
    const ficha = fichasDe(f.CODIGO, (usadasPorCodigo[f.CODIGO] || {}).nombreReloj);
    f.FICHA_RELOJ = ficha ? ficha.key : "";
  });

  const nombreArchivo = `Reloj marcador (automático) ${desde} a ${hasta}`;
  const resultado = await guardarFilas(filas, porKey, puestoPorKey, nombreArchivo);
  return { configurado: true, ...resultado };
}

// --------------------------------------------------------------------------
// Corrida diaria: calcula la ventana [desde, hasta] a partir del último
// bookmark guardado (o desde FECHA_INICIO_SYNC si es la primera vez) y la
// sincroniza. Pensada para llamarse una vez al arrancar y luego una vez al
// día — ver la programación en server.js.
// --------------------------------------------------------------------------
async function ejecutarSincronizacionDiaria() {
  if (!process.env.RELOJ_MYSQL_URL) return { configurado: false };

  const hasta = fechaCRDeAhora(-1); // "ayer" en hora de Costa Rica
  const estado = await obtenerDocumento(SYNC_ESTADO_CLAVE);
  const ultimaFecha = estado && estado.ULTIMA_FECHA;
  const desdeCatchUp = ultimaFecha ? relojSumarDias(ultimaFecha, 1) : FECHA_INICIO_SYNC;
  const desdeConMargen = ultimaFecha ? relojSumarDias(ultimaFecha, 1 - LOOKBACK_DIAS) : FECHA_INICIO_SYNC;
  const desde = desdeConMargen < FECHA_INICIO_SYNC ? FECHA_INICIO_SYNC : desdeConMargen;

  if (desde > hasta) return { configurado: true, saltado: true };

  const resultado = await sincronizarRango(desde, hasta);
  if (resultado.configurado) await marcarUltimaFechaSincronizada(hasta, resultado);
  return { desde, hasta, catchUpDesde: desdeCatchUp, ...resultado };
}

// Actualiza el bookmark de la corrida diaria (ver arriba) — se expone aparte
// para que un resync manual (ej. scripts/resincronizar-reloj-horas-extra.js)
// pueda dejar la ventana automática apuntando al mismo lugar donde terminó,
// en vez de que la próxima corrida automática vuelva a repetir todo el rango.
async function marcarUltimaFechaSincronizada(hasta, resultado) {
  await guardarDocumento(SYNC_ESTADO_CLAVE, { ULTIMA_FECHA: hasta, ACTUALIZADO_EN: new Date().toISOString(), ULTIMO_RESULTADO: resultado || null });
}

module.exports = { sincronizarRango, ejecutarSincronizacionDiaria, marcarUltimaFechaSincronizada, FECHA_INICIO_SYNC };
