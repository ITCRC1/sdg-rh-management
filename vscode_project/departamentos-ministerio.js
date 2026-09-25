"use strict";
// Lista canónica de los departamentos reales de operación (COCINA, LIMPIEZA,
// RECEPCIÓN...) — la misma agrupación que ya trae el catálogo de puestos del
// Ministerio de Trabajo (MINISTERIO_PUESTOS, en app.js; ej. COCINA engloba
// Cocinero A, Cocinero B, Panadero y Steward).
//
// ÚNICO lugar donde vive esta lista. Antes existían dos copias mantenidas a
// mano por separado (una derivada en app.js, otra tecleada en
// empleador.html) que podían desincronizarse en silencio — si alguien creaba
// una cuenta de jefatura con un departamento que ya no existiera en el
// catálogo de Puestos, esa jefatura se quedaba sin ver a nadie de su equipo
// sin ningún aviso. Ahora tanto index.html (para app.js) como empleador.html
// cargan este mismo archivo con <script src="departamentos-ministerio.js">
// antes de su propio script.
//
// Si el catálogo de puestos del Ministerio cambia de departamentos (se
// agrega o renombra alguno en MINISTERIO_PUESTOS), esta lista se actualiza
// acá — app.js valida en tiempo de carga que coincida exactamente con lo que
// MINISTERIO_PUESTOS realmente contiene, y avisa fuerte por consola si
// alguna vez divergen, en vez de fallar en silencio (ver la verificación
// justo después de MINISTERIO_PUESTOS en app.js).
const DEPARTAMENTOS_MINISTERIO = [
  "ACTIVIDADES", "COCINA", "COMEDOR DE EMPLEADOS", "COMPRAS", "CONCIERGE",
  "DIRECCIÓN", "FINANZAS", "LIMPIEZA", "MANTENIMIENTO",
  "RECEPCIÓN", "RESERVA", "RESTAURANTE", "SEGURIDAD", "SISTEMA DE INFORMACIÓN",
  "SPA", "TOURS", "TRANSPORTE", "VENTAS Y MARKETING",
];
