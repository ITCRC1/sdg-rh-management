-- ===========================================================================
-- Generador de Contratos SDG — esquema inicial
--
-- Principio de diseño: los datos operativos se pueden corregir, pero el
-- HISTÓRICO no se toca nunca. Por eso:
--   · `documentos` nunca borra de verdad (borrado lógico con eliminado_en)
--   · `documentos_historial` es append-only, protegido por trigger
--   · `documentos_emitidos` guarda el archivo congelado tal como se firmó
-- ===========================================================================

-- Nota: no se usa la extensión pgcrypto. gen_random_uuid() es parte del núcleo
-- de Postgres desde la versión 13, y no depender de extensiones evita
-- problemas en proveedores administrados que restringen CREATE EXTENSION.

-- ---------------------------------------------------------------------------
-- Utilidad: convertir texto a jsonb sin reventar si no es JSON válido.
-- La app guarda casi todo con JSON.stringify, pero hay un par de claves que
-- guardan texto plano (ej. "colillas-ultima-actualizacion"). Guardamos el
-- texto exacto para no perder fidelidad, y derivamos el jsonb solo cuando se
-- puede, para poder consultar el histórico con operadores de JSON.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION try_jsonb(t text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Propiedades
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS propiedades (
  id      text PRIMARY KEY,
  nombre  text NOT NULL,
  activa  boolean NOT NULL DEFAULT true,
  orden   integer NOT NULL DEFAULT 0
);

INSERT INTO propiedades (id, nombre, orden) VALUES
  ('corcovado', 'SCP Corcovado Wilderness Lodge', 1),
  ('oxygen',    'Oxygen Jungle Villas',           2),
  ('ojochal',   'Ojochal Garden Villas',          3),
  ('amarena',   'Amarena Canvas Beach Hotel',     4)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text NOT NULL,
  nombre                 text NOT NULL,
  cedula                 text,
  puesto                 text,
  propiedad_id           text REFERENCES propiedades(id),
  rol                    text NOT NULL DEFAULT 'trabajador'
                           CHECK (rol IN ('admin', 'trabajador')),
  activo                 boolean NOT NULL DEFAULT true,
  password_hash          text NOT NULL,
  debe_cambiar_password  boolean NOT NULL DEFAULT true,
  intentos_fallidos      integer NOT NULL DEFAULT 0,
  bloqueado_hasta        timestamptz,
  creado_en              timestamptz NOT NULL DEFAULT now(),
  creado_por             uuid REFERENCES usuarios(id),
  desactivado_en         timestamptz,
  ultimo_acceso          timestamptz
);

-- El correo identifica a la persona: único sin importar mayúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_unico
  ON usuarios (lower(email));

-- Un admin no está atado a una propiedad; un trabajador sí, siempre.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'admin' OR propiedad_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Sesiones — en BD (no JWT) para poder revocarlas de verdad y auditar accesos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash   text PRIMARY KEY,
  usuario_id   uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada_en    timestamptz NOT NULL DEFAULT now(),
  ultima_vez   timestamptz NOT NULL DEFAULT now(),
  expira_en    timestamptz NOT NULL,
  revocada_en  timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS sesiones_usuario ON sesiones (usuario_id);
CREATE INDEX IF NOT EXISTS sesiones_expira  ON sesiones (expira_en)
  WHERE revocada_en IS NULL;

-- ---------------------------------------------------------------------------
-- documentos — reemplaza localStorage. Misma forma clave/valor que usaba la
-- app, ahora con dueño, versión y borrado lógico.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos (
  propiedad_id     text NOT NULL REFERENCES propiedades(id),
  clave            text NOT NULL,
  tipo             text GENERATED ALWAYS AS (split_part(clave, ':', 1)) STORED,
  valor            text NOT NULL,
  valor_json       jsonb GENERATED ALWAYS AS (try_jsonb(valor)) STORED,
  version          integer NOT NULL DEFAULT 1,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  creado_por       uuid REFERENCES usuarios(id),
  actualizado_en   timestamptz NOT NULL DEFAULT now(),
  actualizado_por  uuid REFERENCES usuarios(id),
  eliminado_en     timestamptz,
  eliminado_por    uuid REFERENCES usuarios(id),
  PRIMARY KEY (propiedad_id, clave)
);

CREATE INDEX IF NOT EXISTS documentos_por_tipo
  ON documentos (propiedad_id, tipo) WHERE eliminado_en IS NULL;
CREATE INDEX IF NOT EXISTS documentos_prefijo
  ON documentos (propiedad_id, clave text_pattern_ops) WHERE eliminado_en IS NULL;
CREATE INDEX IF NOT EXISTS documentos_json
  ON documentos USING gin (valor_json) WHERE valor_json IS NOT NULL;

-- ---------------------------------------------------------------------------
-- documentos_historial — EL HISTÓRICO. Append-only.
--
-- Lo escribe un trigger, no la aplicación: si mañana un bug en la API olvida
-- registrar un cambio, el trigger igual lo registra. El histórico no depende
-- de que el código de arriba se porte bien.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos_historial (
  id            bigserial PRIMARY KEY,
  propiedad_id  text NOT NULL,
  clave         text NOT NULL,
  version       integer NOT NULL,
  valor         text,
  valor_json    jsonb GENERATED ALWAYS AS (try_jsonb(valor)) STORED,
  accion        text NOT NULL CHECK (accion IN ('crear','actualizar','eliminar','restaurar')),
  actor_id      uuid,
  actor_email   text,
  actor_ip      inet,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS historial_documento
  ON documentos_historial (propiedad_id, clave, version DESC);
CREATE INDEX IF NOT EXISTS historial_fecha
  ON documentos_historial (creado_en DESC);
CREATE INDEX IF NOT EXISTS historial_actor
  ON documentos_historial (actor_id, creado_en DESC);

-- El actor viaja por variable de sesión, fijada por la API en cada transacción.
CREATE OR REPLACE FUNCTION registrar_historial() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_accion text;
  v_actor  uuid;
  v_email  text;
  v_ip     inet;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_accion := 'crear';
  ELSIF NEW.eliminado_en IS NOT NULL AND OLD.eliminado_en IS NULL THEN
    v_accion := 'eliminar';
  ELSIF NEW.eliminado_en IS NULL AND OLD.eliminado_en IS NOT NULL THEN
    v_accion := 'restaurar';
  ELSE
    v_accion := 'actualizar';
  END IF;

  BEGIN v_actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN others THEN v_actor := NULL; END;
  v_email := nullif(current_setting('app.actor_email', true), '');
  BEGIN v_ip := nullif(current_setting('app.actor_ip', true), '')::inet;
  EXCEPTION WHEN others THEN v_ip := NULL; END;

  INSERT INTO documentos_historial
    (propiedad_id, clave, version, valor, accion, actor_id, actor_email, actor_ip)
  VALUES
    (NEW.propiedad_id, NEW.clave, NEW.version, NEW.valor, v_accion, v_actor, v_email, v_ip);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_historial ON documentos;
CREATE TRIGGER trg_historial
  AFTER INSERT OR UPDATE ON documentos
  FOR EACH ROW EXECUTE FUNCTION registrar_historial();

-- ---------------------------------------------------------------------------
-- documentos_emitidos — el archivo CONGELADO tal como se entregó/firmó.
--
-- No se regenera desde plantillas: si la plantilla cambia en marzo, regenerar
-- un contrato de enero produciría un documento distinto al que la persona
-- firmó. Para un histórico laboral eso no sirve. Se guarda el binario y su
-- huella SHA-256 para poder probar que no fue alterado.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos_emitidos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  propiedad_id      text NOT NULL REFERENCES propiedades(id),
  clave_origen      text,
  tipo              text NOT NULL,
  titulo            text NOT NULL,
  empleado_cedula   text,
  empleado_nombre   text,
  nombre_archivo    text NOT NULL,
  mime              text NOT NULL,
  tamano_bytes      integer NOT NULL,
  sha256            text NOT NULL,
  contenido         bytea NOT NULL,
  emitido_por       uuid REFERENCES usuarios(id),
  emitido_por_email text,
  emitido_en        timestamptz NOT NULL DEFAULT now(),
  anulado_en        timestamptz,
  anulado_por       uuid REFERENCES usuarios(id),
  anulado_motivo    text
);
CREATE INDEX IF NOT EXISTS emitidos_propiedad
  ON documentos_emitidos (propiedad_id, emitido_en DESC);
CREATE INDEX IF NOT EXISTS emitidos_empleado
  ON documentos_emitidos (propiedad_id, empleado_cedula, emitido_en DESC);
CREATE INDEX IF NOT EXISTS emitidos_sha
  ON documentos_emitidos (sha256);

-- ---------------------------------------------------------------------------
-- Candado de inmutabilidad sobre las tablas de histórico.
--
-- Alcance honesto: esto detiene bugs de la aplicación y errores manuales.
-- Un superusuario de Postgres puede quitar el trigger — la protección contra
-- eso son los backups y el control de acceso a las credenciales de la BD.
-- Anular un documento emitido se hace marcando anulado_en, no borrándolo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bloquear_modificacion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'La tabla % es de solo-inserción (histórico legal). Operación % rechazada.',
    TG_TABLE_NAME, TG_OP;
END $$;

DROP TRIGGER IF EXISTS trg_historial_inmutable ON documentos_historial;
CREATE TRIGGER trg_historial_inmutable
  BEFORE UPDATE OR DELETE ON documentos_historial
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- En emitidos sí se permite UPDATE (para anular), pero nunca DELETE.
DROP TRIGGER IF EXISTS trg_emitidos_no_delete ON documentos_emitidos;
CREATE TRIGGER trg_emitidos_no_delete
  BEFORE DELETE ON documentos_emitidos
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- ---------------------------------------------------------------------------
-- Bitácora de accesos — quién entró, desde dónde, y qué intentos fallaron
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bitacora_accesos (
  id          bigserial PRIMARY KEY,
  email       text,
  usuario_id  uuid REFERENCES usuarios(id),
  evento      text NOT NULL,
  exito       boolean NOT NULL,
  detalle     text,
  ip          inet,
  user_agent  text,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bitacora_fecha ON bitacora_accesos (creado_en DESC);
CREATE INDEX IF NOT EXISTS bitacora_email ON bitacora_accesos (lower(email), creado_en DESC);
