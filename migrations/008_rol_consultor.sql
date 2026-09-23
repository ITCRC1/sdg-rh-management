-- ===========================================================================
-- Nuevo rol "consultor": cuentas del grupo externo "Consultants" que
-- administra SDG RH Management. A diferencia de gerente/jefatura/empleado,
-- no queda atado a una sola propiedad (propiedad_id puede ser NULL, igual
-- que master) — ve las 5 propiedades. A diferencia de master, NO administra
-- usuarios (requiereAdmin sigue siendo solo master) y es de SOLO LECTURA en
-- todo: planillas, expedientes, datos y documentos de empleados, horas
-- extra y días libres/vacaciones (por empleado), incapacidades — nunca crea
-- ni edita nada de eso (no está en PUEDEN_ESCRIBIR, ver src/auth.js).
--
-- usuarios.puede_firmar_contratos solo aplica a rol=consultor: identifica la
-- cuenta del contador jefe (Ronald), la única con una capacidad de
-- escritura — angosta y aparte, no escritura general —: firmar/rechazar los
-- contratos que le lleguen de cualquier propiedad. Ese flujo de firma en sí
-- se construye en una fase aparte; por ahora la columna solo se guarda y
-- viaja en la sesión.
-- ===========================================================================
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'jefatura', 'empleado', 'consultor'));

-- Consultor no queda atado a una propiedad, igual que master.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol IN ('master', 'consultor') OR propiedad_id IS NOT NULL);

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puede_firmar_contratos boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; jefatura = solo lectura + aprobar/editar horas extra de su departamento (usuarios.puesto guarda el departamento); empleado = solo lectura de su propio expediente (usuarios.empleado_clave guarda su clave cat_empleado:<key>); consultor = cuentas de Consultants, solo lectura en cualquier propiedad (ver usuarios.puede_firmar_contratos para la única excepción de escritura)';

COMMENT ON COLUMN usuarios.puede_firmar_contratos IS
  'Solo aplica a rol=consultor: habilita la bandeja de firma de contratos (ej. el contador jefe). El resto de cuentas consultor lo dejan en false.';
