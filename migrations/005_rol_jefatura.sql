-- ===========================================================================
-- Nuevo rol "jefatura": como colaborador (solo lectura) en todo lo demás,
-- pero puede aprobar, corregir o rechazar horas extra — solo las de su
-- propio equipo. El equipo se determina por el puesto que ocupa la cuenta
-- (columna usuarios.puesto, con el mismo texto exacto que "Jefatura
-- inmediata" en el catálogo de Puestos), y ese alcance lo aplica el
-- servidor en rutas-datos.js — no es una restricción solo de interfaz.
-- ===========================================================================
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'jefatura', 'colaborador'));

-- Jefatura pertenece siempre a una propiedad, igual que gerente y colaborador.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'master' OR propiedad_id IS NOT NULL);

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; jefatura = solo lectura + aprobar/editar horas extra de su equipo (usuarios.puesto); colaborador = solo lectura';
