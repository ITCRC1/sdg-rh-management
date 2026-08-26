"use strict";
// API de datos: el KV que reemplaza localStorage, el histórico y los
// documentos congelados.
//
// Regla transversal: la propiedad SIEMPRE sale de la sesión del usuario,
// nunca de un parámetro que mande el navegador. Así el aislamiento entre
// Corcovado / Oxygen / Ojochal / Amarena lo hace el servidor, no el cliente.
// Un master puede mirar otra propiedad pasando ?propiedad=, y solo un master.

const express = require("express");
const crypto = require("crypto");
const { query, conActor } = require("./db");
const A = require("./auth");

const router = express.Router();

const MAX_VALOR_BYTES = 4 * 1024 * 1024; // por documento
const MAX_ARCHIVO_BYTES = 15 * 1024 * 1024; // por documento emitido

router.use(A.requiereSesion, A.exigeCambioPassword);

// Resuelve sobre qué propiedad trabaja esta petición.
function propiedadDe(req) {
  const pedida = req.query.propiedad || req.body?.propiedad;
  if (pedida && req.usuario.rol === "master") return String(pedida);
  return req.usuario.propiedadId;
}

function actorDe(req) {
  return { id: req.usuario.id, email: req.usuario.email, ip: req.usuario.ip };
}

function claveValida(clave) {
  return typeof clave === "string" && clave.length > 0 && clave.length <= 400;
}

// --------------------------------------------------------------------------
// Alcance de "jefatura" sobre horas_extra: — el único dato que ese rol puede
// tocar, y solo el de su propio equipo. Espeja los prefijos que usa el
// cliente (app.js: CATALOGS.empleados.prefix, CATALOGS.puestos.prefix,
// HORAS_EXTRA_PREFIX) — si esos cambian ahí, deben cambiar aquí también.
// --------------------------------------------------------------------------
const HORAS_EXTRA_PREFIX = "horas_extra:";
const EMPLEADO_PREFIX = "cat_empleado:";
const PUESTO_PREFIX = "cat_puesto:";

async function valorDeClave(propiedad, clave) {
  const { rows } = await query(
    `SELECT valor FROM documentos WHERE propiedad_id = $1 AND clave = $2 AND eliminado_en IS NULL`,
    [propiedad, clave]
  );
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].valor);
  } catch (e) {
    return null;
  }
}

// ¿El empleado dueño de esta clave de horas_extra pertenece al departamento
// que lidera esta jefatura? El departamento sale de DEPARTAMENTO_MINISTERIO
// en el puesto del empleado (ej. "COCINA" agrupa Cocinero A, Cocinero B,
// Panadero y Steward — así lo clasifica el catálogo del Ministerio de
// Trabajo). Un registro "sinmatch-" (todavía sin empleado identificado)
// nunca pertenece a ninguna jefatura — esa asignación es trabajo de
// master/gerente.
async function horaExtraPerteneceAEquipo(propiedad, claveHorasExtra, departamentoLider) {
  if (!departamentoLider) return false;
  const empleadoKey = claveHorasExtra.split(":")[1] || "";
  if (!empleadoKey || empleadoKey.startsWith("sinmatch-")) return false;

  const empleado = await valorDeClave(propiedad, EMPLEADO_PREFIX + empleadoKey);
  if (!empleado || !empleado.PUESTO_KEY) return false;

  const puesto = await valorDeClave(propiedad, PUESTO_PREFIX + empleado.PUESTO_KEY);
  if (!puesto) return false;

  return puesto.DEPARTAMENTO_MINISTERIO === departamentoLider;
}

// ¿Puede este usuario escribir en esta clave? master/gerente: todo, como
// siempre. jefatura: solo horas_extra: de su propio departamento (guardado
// en usuarios.puesto — pese al nombre de la columna, para una cuenta de
// jefatura ese campo guarda el departamento que lidera, no un puesto
// puntual). Cualquier otro caso (incluido colaborador) queda fuera.
async function puedeEscribirClave(usuario, propiedad, clave) {
  if (A.PUEDEN_ESCRIBIR.has(usuario.rol)) return true;
  if (usuario.rol === "jefatura" && clave.startsWith(HORAS_EXTRA_PREFIX)) {
    return horaExtraPerteneceAEquipo(propiedad, clave, usuario.puesto);
  }
  return false;
}

// Filtra filas (con o sin `valor`) de horas_extra: dejando solo las del
// equipo de esa jefatura. Secuencial y no en paralelo a propósito: son pocas
// filas por período de 3 días, y evita abrir decenas de conexiones a la vez.
async function filtrarFilasPorEquipo(filas, propiedad, puestoLider) {
  const resultado = [];
  for (const fila of filas) {
    if (await horaExtraPerteneceAEquipo(propiedad, fila.clave, puestoLider)) resultado.push(fila);
  }
  return resultado;
}

// --------------------------------------------------------------------------
// GET /api/datos — lista claves por prefijo (equivale a storage.list)
// --------------------------------------------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });

    const prefijo = String(req.query.prefijo || "");
    const conValores = req.query.valores === "1";

    // El prefijo se pasa como parámetro y se escapa: nunca se concatena SQL.
    const like = prefijo.replace(/([\\%_])/g, "\\$1") + "%";

    // Una jefatura solo ve horas_extra: de su propio equipo — nunca las de
    // otros departamentos, aunque esté pidiendo el mismo prefijo que vería
    // un master/gerente.
    const filtrarPorEquipo = req.usuario.rol === "jefatura" && prefijo.startsWith(HORAS_EXTRA_PREFIX);

    if (conValores) {
      const { rows } = await query(
        `SELECT clave, valor, version, actualizado_en
           FROM documentos
          WHERE propiedad_id = $1 AND eliminado_en IS NULL AND clave LIKE $2 ESCAPE '\\'
          ORDER BY clave`,
        [propiedad, like]
      );
      const items = filtrarPorEquipo
        ? await filtrarFilasPorEquipo(rows, propiedad, req.usuario.puesto)
        : rows;
      return res.json({ propiedad, prefijo, items });
    }

    const { rows } = await query(
      `SELECT clave FROM documentos
        WHERE propiedad_id = $1 AND eliminado_en IS NULL AND clave LIKE $2 ESCAPE '\\'
        ORDER BY clave`,
      [propiedad, like]
    );
    const filas = filtrarPorEquipo
      ? await filtrarFilasPorEquipo(rows, propiedad, req.usuario.puesto)
      : rows;
    res.json({ propiedad, prefijo, claves: filas.map((r) => r.clave) });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// GET /api/datos/:clave — equivale a storage.get
// --------------------------------------------------------------------------
router.get("/:clave(*)", async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    const clave = req.params.clave;
    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });
    if (!claveValida(clave)) return res.status(400).json({ error: "Clave inválida." });

    const { rows } = await query(
      `SELECT clave, valor, version, actualizado_en
         FROM documentos
        WHERE propiedad_id = $1 AND clave = $2 AND eliminado_en IS NULL`,
      [propiedad, clave]
    );
    if (!rows[0]) return res.status(404).json({ error: "No encontrado", clave });

    if (req.usuario.rol === "jefatura" && clave.startsWith(HORAS_EXTRA_PREFIX)) {
      const enSuEquipo = await horaExtraPerteneceAEquipo(propiedad, clave, req.usuario.puesto);
      if (!enSuEquipo) return res.status(403).json({ error: "Ese registro no es de tu equipo.", codigo: "sin_permiso" });
    }
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// PUT /api/datos/:clave — equivale a storage.set
//
// Detecta escritura concurrente: si el cliente manda `version` y ya no es la
// vigente, se rechaza con 409 en vez de pisar el trabajo de otra persona.
//
// No usa A.requiereEscritura porque jefatura SÍ puede escribir, pero solo en
// horas_extra: de su propio equipo — un permiso que depende de la clave, así
// que se resuelve aquí en vez de en un middleware genérico por rol.
// --------------------------------------------------------------------------
router.put("/:clave(*)", async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    const clave = req.params.clave;
    const valor = req.body?.valor;
    const versionEsperada = req.body?.version;

    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });
    if (!claveValida(clave)) return res.status(400).json({ error: "Clave inválida." });
    if (!(await puedeEscribirClave(req.usuario, propiedad, clave))) {
      return res.status(403).json({
        error: "Tu cuenta no tiene permiso para modificar esto.",
        codigo: "sin_permiso",
      });
    }
    if (typeof valor !== "string") {
      return res.status(400).json({ error: "El campo 'valor' debe ser texto." });
    }
    if (Buffer.byteLength(valor, "utf8") > MAX_VALOR_BYTES) {
      return res.status(413).json({
        error: "El documento supera el límite de " + MAX_VALOR_BYTES / 1024 / 1024 + " MB.",
      });
    }

    const resultado = await conActor(actorDe(req), async (c) => {
      if (versionEsperada !== undefined && versionEsperada !== null) {
        const actual = await c.query(
          "SELECT version FROM documentos WHERE propiedad_id = $1 AND clave = $2 FOR UPDATE",
          [propiedad, clave]
        );
        if (actual.rows[0] && actual.rows[0].version !== Number(versionEsperada)) {
          return { conflicto: true, versionActual: actual.rows[0].version };
        }
      }
      const { rows } = await c.query(
        `INSERT INTO documentos (propiedad_id, clave, valor, creado_por, actualizado_por)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (propiedad_id, clave) DO UPDATE
           SET valor = EXCLUDED.valor,
               version = documentos.version + 1,
               actualizado_en = now(),
               actualizado_por = EXCLUDED.actualizado_por,
               eliminado_en = NULL,
               eliminado_por = NULL
         RETURNING clave, version, actualizado_en`,
        [propiedad, clave, valor, req.usuario.id]
      );
      return { fila: rows[0] };
    });

    if (resultado.conflicto) {
      return res.status(409).json({
        error: "Otra persona modificó este registro mientras lo editabas.",
        codigo: "conflicto_version",
        versionActual: resultado.versionActual,
      });
    }
    res.json(resultado.fila);
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// DELETE /api/datos/:clave — borrado LÓGICO
//
// Nunca se borra la fila: se marca eliminado_en. El histórico conserva todas
// las versiones y el registro se puede restaurar. Para contratos de personal
// eso no es opcional.
// --------------------------------------------------------------------------
router.delete("/:clave(*)", A.requiereEscritura, async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    const clave = req.params.clave;
    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });
    if (!claveValida(clave)) return res.status(400).json({ error: "Clave inválida." });

    const resultado = await conActor(actorDe(req), async (c) => {
      const { rows } = await c.query(
        `UPDATE documentos
            SET eliminado_en = now(), eliminado_por = $3, version = version + 1
          WHERE propiedad_id = $1 AND clave = $2 AND eliminado_en IS NULL
          RETURNING clave, version`,
        [propiedad, clave, req.usuario.id]
      );
      return rows[0];
    });

    if (!resultado) return res.status(404).json({ error: "No encontrado", clave });
    res.json({ clave, eliminado: true, version: resultado.version });
  } catch (e) {
    next(e);
  }
});

// ==========================================================================
// Histórico
//
// Va en un router aparte, montado en /api/historial, porque la ruta comodín
// /:clave(*) de arriba se tragaría cualquier subruta que colgara de /api/datos.
// ==========================================================================
const historial = express.Router();
historial.use(A.requiereSesion, A.exigeCambioPassword);

historial.get("/", async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    const clave = req.query.clave;
    const limite = Math.min(Number(req.query.limite) || 100, 500);
    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });

    if (clave) {
      const { rows } = await query(
        `SELECT h.version, h.valor, h.accion, h.actor_email, host(h.actor_ip) AS ip, h.creado_en
           FROM documentos_historial h
          WHERE h.propiedad_id = $1 AND h.clave = $2
          ORDER BY h.version DESC, h.id DESC
          LIMIT $3`,
        [propiedad, clave, limite]
      );
      return res.json({ clave, versiones: rows });
    }

    // Sin clave: actividad reciente de toda la propiedad.
    const { rows } = await query(
      `SELECT h.clave, h.version, h.accion, h.actor_email, h.creado_en
         FROM documentos_historial h
        WHERE h.propiedad_id = $1
        ORDER BY h.id DESC
        LIMIT $2`,
      [propiedad, limite]
    );
    res.json({ actividad: rows });
  } catch (e) {
    next(e);
  }
});

// ==========================================================================
// Documentos emitidos (contratos congelados)
// ==========================================================================
const emitidos = express.Router();
emitidos.use(A.requiereSesion, A.exigeCambioPassword);

// POST /api/documentos — congela un archivo tal como se generó
emitidos.post("/", A.requiereEscritura, async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });

    const b = req.body || {};
    const base64 = String(b.contenidoBase64 || "");
    if (!base64) return res.status(400).json({ error: "Falta el contenido del archivo." });

    const contenido = Buffer.from(base64, "base64");
    if (!contenido.length) return res.status(400).json({ error: "El archivo llegó vacío." });
    if (contenido.length > MAX_ARCHIVO_BYTES) {
      return res.status(413).json({
        error: "El archivo supera el límite de " + MAX_ARCHIVO_BYTES / 1024 / 1024 + " MB.",
      });
    }

    const sha256 = crypto.createHash("sha256").update(contenido).digest("hex");

    const { rows } = await query(
      `INSERT INTO documentos_emitidos
         (propiedad_id, clave_origen, tipo, titulo, empleado_cedula, empleado_nombre,
          nombre_archivo, mime, tamano_bytes, sha256, contenido, emitido_por, emitido_por_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, sha256, emitido_en, tamano_bytes`,
      [
        propiedad,
        b.claveOrigen || null,
        String(b.tipo || "documento"),
        String(b.titulo || b.nombreArchivo || "Documento"),
        b.empleadoCedula || null,
        b.empleadoNombre || null,
        String(b.nombreArchivo || "documento.pdf"),
        String(b.mime || "application/pdf"),
        contenido.length,
        sha256,
        contenido,
        req.usuario.id,
        req.usuario.email,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// GET /api/documentos — lista (sin traer los binarios)
emitidos.get("/", async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    if (!propiedad) return res.status(400).json({ error: "Sin propiedad asignada." });
    const limite = Math.min(Number(req.query.limite) || 200, 1000);

    const filtros = ["propiedad_id = $1"];
    const params = [propiedad];
    if (req.query.cedula) {
      params.push(String(req.query.cedula));
      filtros.push("empleado_cedula = $" + params.length);
    }
    if (req.query.tipo) {
      params.push(String(req.query.tipo));
      filtros.push("tipo = $" + params.length);
    }
    params.push(limite);

    const { rows } = await query(
      `SELECT id, clave_origen, tipo, titulo, empleado_cedula, empleado_nombre,
              nombre_archivo, mime, tamano_bytes, sha256,
              emitido_por_email, emitido_en, anulado_en, anulado_motivo
         FROM documentos_emitidos
        WHERE ${filtros.join(" AND ")}
        ORDER BY emitido_en DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ documentos: rows });
  } catch (e) {
    next(e);
  }
});

// GET /api/documentos/:id/archivo — descarga el binario congelado
emitidos.get("/:id/archivo", async (req, res, next) => {
  try {
    const propiedad = propiedadDe(req);
    const { rows } = await query(
      `SELECT nombre_archivo, mime, contenido, sha256, propiedad_id
         FROM documentos_emitidos WHERE id = $1`,
      [req.params.id]
    );
    const d = rows[0];
    if (!d) return res.status(404).json({ error: "Documento no encontrado." });
    if (d.propiedad_id !== propiedad && req.usuario.rol !== "master") {
      return res.status(403).json({ error: "Ese documento pertenece a otra propiedad." });
    }

    res.setHeader("Content-Type", d.mime);
    res.setHeader("Content-Length", d.contenido.length);
    res.setHeader("X-Documento-SHA256", d.sha256);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="' + d.nombre_archivo.replace(/[^\w.\- ]/g, "_") + '"'
    );
    res.end(d.contenido);
  } catch (e) {
    if (e.code === "22P02") return res.status(400).json({ error: "Identificador inválido." });
    next(e);
  }
});

// PATCH /api/documentos/:id/anular — no borra, marca como anulado
emitidos.patch("/:id/anular", A.requiereEscritura, async (req, res, next) => {
  try {
    const motivo = String(req.body?.motivo || "").trim();
    if (!motivo) return res.status(400).json({ error: "Indica el motivo de la anulación." });

    const { rows } = await query(
      `UPDATE documentos_emitidos
          SET anulado_en = now(), anulado_por = $2, anulado_motivo = $3
        WHERE id = $1 AND anulado_en IS NULL
        RETURNING id, anulado_en`,
      [req.params.id, req.usuario.id, motivo]
    );
    if (!rows[0]) return res.status(404).json({ error: "Documento no encontrado o ya anulado." });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "22P02") return res.status(400).json({ error: "Identificador inválido." });
    next(e);
  }
});

module.exports = { datos: router, historial, emitidos };
