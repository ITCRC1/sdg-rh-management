"use strict";
// Emparejado de nombre/código del reloj marcador contra la ficha de un
// empleado — réplica exacta de relojIndiceFichas y sus helpers en
// vscode_project/app.js (ver ese archivo para la explicación completa de
// cada prioridad de match). Compartido entre src/reloj-sync.js (envío
// automático a Horas extra) y src/rutas-reloj.js (filtrar por departamento
// lo que ve una jefatura) para que ninguno de los dos mantenga su propia
// copia — si el criterio de match cambia, cambia en un solo lugar.

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

// Devuelve una función (codigo, nombreReloj) => empleado | null.
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

module.exports = {
  normalizarNombreParaMatch,
  normalizarCodigoEmpleado,
  relojNumeroExacto,
  nombreCompletoEmpleado,
  relojNombresCompatibles,
  desempatarFichasPorNombre,
  construirIndiceFichas,
};
