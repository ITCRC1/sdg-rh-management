-- ===========================================================================
-- Nuevo rol "jefatura": como colaborador (solo lectura) en todo lo demás,
-- pero puede aprobar, corregir o rechazar horas extra — solo las de su
-- propio departamento. El departamento lo guarda la columna usuarios.puesto
-- (pese al nombre, para una cuenta de jefatura no guarda un puesto puntual
-- sino el departamento que lidera — ej. "COCINA"), y debe coincidir con
-- DEPARTAMENTO_MINISTERIO del puesto de cada subalterno en el catálogo de
-- Puestos. Ese alcance lo aplica el servidor en rutas-datos.js — no es una
-- restricción solo de interfaz.
-- ===========================================================================
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'jefatura', 'colaborador'));

-- Jefatura pertenece siempre a una propiedad, igual que gerente y colaborador.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'master' OR propiedad_id IS NOT NULL);

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; jefatura = solo lectura + aprobar/editar horas extra de su departamento (usuarios.puesto guarda el departamento); colaborador = solo lectura';
