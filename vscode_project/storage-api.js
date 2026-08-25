"use strict";
// ===========================================================================
// Capa de almacenamiento contra la API. Reemplaza localStorage.
//
// Expone exactamente la misma forma que usaba la app —
// window.storage.get / set / delete / list — así que los ~200 puntos de
// llamada en app.js siguen funcionando sin tocarlos.
//
// Debe cargarse ANTES de app.js.
// ===========================================================================
(function () {
  const API = "/api";

  // Caché en memoria. Evita ir a la red por cada get() dentro de un mismo
  // render (la app hace muchísimas lecturas repetidas al pintar tablas).
  // No persiste entre recargas a propósito: el servidor es la fuente de verdad.
  const cache = new Map();
  const versiones = new Map();

  let sesion = null;

  // La propiedad activa de un usuario master vive en localStorage (la
  // fija app.js vía setPropiedadActual, clave "gcw:propiedad-actual") — el
  // servidor solo la respeta si el rol es master (rutas-datos.js: propiedadDe),
  // así que mandarla de más para gerente/colaborador es inofensivo. Sin esto
  // ningún master podía guardar nada: el servidor siempre respondía "Sin
  // propiedad asignada" porque el parámetro nunca viajaba.
  function propiedadActivaParaApi() {
    try {
      return localStorage.getItem("gcw:propiedad-actual") || "";
    } catch (e) {
      return "";
    }
  }

  // `sondeo: true` para las llamadas que solo PREGUNTAN si hay sesión. Sin esa
  // distinción, comprobar la sesión al cargar la página se interpretaría como
  // que la sesión se cayó, y en una página sin pantalla de login propia eso
  // provocaba un bucle infinito de recargas.
  async function pedir(ruta, opciones, sondeo) {
    const propAct = propiedadActivaParaApi();
    const rutaConPropiedad = propAct
      ? ruta + (ruta.includes("?") ? "&" : "?") + "propiedad=" + encodeURIComponent(propAct)
      : ruta;
    const res = await fetch(API + rutaConPropiedad, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...opciones,
    });

    if (res.status === 401) {
      if (!sondeo) manejarSesionCaida();
      const err = new Error("Sesión expirada");
      err.status = 401;
      throw err;
    }

    let cuerpo = null;
    const tipo = res.headers.get("content-type") || "";
    if (tipo.includes("application/json")) {
      cuerpo = await res.json().catch(() => null);
    }

    if (!res.ok) {
      const err = new Error((cuerpo && cuerpo.error) || "Error " + res.status);
      err.status = res.status;
      err.codigo = cuerpo && cuerpo.codigo;
      err.cuerpo = cuerpo;
      throw err;
    }
    return cuerpo;
  }

  let sesionCaidaAvisada = false;
  function manejarSesionCaida() {
    if (sesionCaidaAvisada) return;
    sesionCaidaAvisada = true;
    sesion = null;
    cache.clear();
    versiones.clear();
    if (typeof window.mostrarPantallaLogin === "function") {
      window.mostrarPantallaLogin("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    // Sin pantalla de login propia, se avisa sin recargar: una recarga
    // automática aquí puede convertirse en un bucle si la sesión sigue caída.
    console.warn("Sesión expirada y la página no tiene pantalla de login.");
    alert("Tu sesión expiró. Recarga la página para volver a iniciar sesión.");
  }

  // -------------------------------------------------------------------------
  // La API que consume app.js
  // -------------------------------------------------------------------------
  window.storage = {
    // Marca que app.js consulta para NO volver a scopear las claves por
    // propiedad: con la API eso lo hace el servidor desde la sesión, y
    // hacerlo dos veces produciría claves como prop_x::prop_x::contrato:1
    __esApi: true,

    async set(clave, valor) {
      const cuerpo = { valor: String(valor) };
      // Control de concurrencia: si otra persona modificó el registro desde
      // que lo leímos, el servidor responde 409 en vez de pisar su trabajo.
      if (versiones.has(clave)) cuerpo.version = versiones.get(clave);

      try {
        const r = await pedir("/datos/" + encodeURIComponent(clave), {
          method: "PUT",
          body: JSON.stringify(cuerpo),
        });
        cache.set(clave, String(valor));
        versiones.set(clave, r.version);
        return { key: clave, value: valor };
      } catch (e) {
        if (e.codigo === "conflicto_version") {
          // Reintento único tras releer: el caso normal es que la otra persona
          // editó un registro distinto del que el usuario tiene en pantalla.
          versiones.delete(clave);
          const r = await pedir("/datos/" + encodeURIComponent(clave), {
            method: "PUT",
            body: JSON.stringify({ valor: String(valor) }),
          });
          cache.set(clave, String(valor));
          versiones.set(clave, r.version);
          avisar("Otra persona había modificado este registro; se guardó tu versión.", false);
          return { key: clave, value: valor };
        }
        if (e.codigo === "solo_lectura") {
          avisar("Tu cuenta es de solo lectura: este cambio no se guardó.", false);
        } else {
          avisar("No se pudo guardar: " + e.message, false);
        }
        throw e;
      }
    },

    async get(clave) {
      if (cache.has(clave)) return { key: clave, value: cache.get(clave) };
      try {
        const r = await pedir("/datos/" + encodeURIComponent(clave));
        cache.set(clave, r.valor);
        versiones.set(clave, r.version);
        return { key: clave, value: r.valor };
      } catch (e) {
        // app.js espera una excepción cuando la clave no existe.
        if (e.status === 404) throw new Error("Key not found: " + clave);
        throw e;
      }
    },

    async delete(clave) {
      await pedir("/datos/" + encodeURIComponent(clave), { method: "DELETE" });
      cache.delete(clave);
      versiones.delete(clave);
      return { key: clave, deleted: true };
    },

    async list(prefijo) {
      const r = await pedir("/datos?prefijo=" + encodeURIComponent(prefijo || "") + "&valores=1");
      const claves = [];
      for (const item of r.items) {
        claves.push(item.clave);
        // Precargar los valores ahorra N peticiones: la app siempre hace
        // list() y acto seguido un get() por cada clave devuelta.
        cache.set(item.clave, item.valor);
        versiones.set(item.clave, item.version);
      }
      return { keys: claves, prefix: prefijo };
    },

    // Fuerza relectura desde el servidor en la próxima consulta.
    invalidar(clave) {
      if (clave) {
        cache.delete(clave);
        versiones.delete(clave);
      } else {
        cache.clear();
        versiones.clear();
      }
    },
  };

  function avisar(texto, ok) {
    if (typeof window.statusMsg === "function") window.statusMsg(texto, ok);
    else console[ok ? "log" : "warn"](texto);
  }

  // -------------------------------------------------------------------------
  // Sesión, histórico y documentos congelados
  // -------------------------------------------------------------------------
  window.sdgApi = {
    async login(email, password) {
      const r = await fetch(API + "/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cuerpo.error || "No se pudo iniciar sesión.");
      sesion = cuerpo.usuario;
      sesionCaidaAvisada = false;
      return sesion;
    },

    async logout() {
      try {
        await fetch(API + "/auth/logout", { method: "POST", credentials: "same-origin" });
      } catch (e) {
        /* si la red falla igual limpiamos del lado del navegador */
      }
      sesion = null;
      cache.clear();
      versiones.clear();
      location.reload();
    },

    async me() {
      try {
        const r = await pedir("/auth/me", undefined, true); // sondeo
        sesion = r.usuario;
        return r;
      } catch (e) {
        sesion = null;
        return null;
      }
    },

    sesionActual() {
      return sesion;
    },

    // Los colaboradores son de solo lectura. Esto solo sirve para ajustar la
    // interfaz: el permiso real lo aplica el servidor en cada petición.
    puedeEditar() {
      return sesion ? sesion.rol === "master" || sesion.rol === "gerente" : false;
    },

    esMaster() {
      return sesion ? sesion.rol === "master" : false;
    },

    rol() {
      return sesion ? sesion.rol : null;
    },

    async cambiarPassword(actual, nueva) {
      return pedir("/auth/password", {
        method: "POST",
        body: JSON.stringify({ actual, nueva }),
      });
    },

    async propiedades() {
      const r = await pedir("/auth/propiedades");
      return r.propiedades;
    },

    // Histórico de un documento, o actividad reciente si no se pasa clave.
    async historial(clave, limite) {
      const p = new URLSearchParams();
      if (clave) p.set("clave", clave);
      if (limite) p.set("limite", String(limite));
      return pedir("/historial?" + p.toString());
    },

    // Congela un archivo generado. `blob` es lo que la app ya produce al
    // exportar; queda guardado con su hash SHA-256 y no se regenera nunca más.
    async congelarDocumento(blob, meta) {
      const base64 = await blobABase64(blob);
      return pedir("/documentos", {
        method: "POST",
        body: JSON.stringify({
          contenidoBase64: base64,
          mime: blob.type || "application/pdf",
          ...meta,
        }),
      });
    },

    async documentos(filtros) {
      const p = new URLSearchParams(filtros || {});
      const r = await pedir("/documentos?" + p.toString());
      return r.documentos;
    },

    urlDescarga(id) {
      return API + "/documentos/" + encodeURIComponent(id) + "/archivo";
    },

    async anularDocumento(id, motivo) {
      return pedir("/documentos/" + encodeURIComponent(id) + "/anular", {
        method: "PATCH",
        body: JSON.stringify({ motivo }),
      });
    },

    // Administración (solo master)
    usuarios: {
      listar: () => pedir("/auth/usuarios").then((r) => r.usuarios),
      crear: (datos) =>
        pedir("/auth/usuarios", { method: "POST", body: JSON.stringify(datos) }),
      actualizar: (id, cambios) =>
        pedir("/auth/usuarios/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify(cambios),
        }),
      bitacora: (limite) =>
        pedir("/auth/bitacora?limite=" + (limite || 100)).then((r) => r.eventos),
    },
  };

  function blobABase64(blob) {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve(String(lector.result).split(",")[1] || "");
      lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
      lector.readAsDataURL(blob);
    });
  }
})();
