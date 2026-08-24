-- ===========================================================================
-- Tres roles en lugar de dos.
--
--   admin        lee, edita, sube archivos Y administra usuarios
--   gerente      lee, edita, sube archivos — no toca usuarios
--   colaborador  solo lectura
--
-- El rol anterior 'trabajador' tenía acceso completo a los datos, así que
-- equivale a 'gerente'. Se migra a ese, no a 'colaborador': degradar cuentas
-- existentes en silencio dejaría a gente sin poder trabajar sin aviso.
-- ===========================================================================

-- El CHECK viejo hay que quitarlo ANTES de actualizar las filas, porque
-- 'gerente' todavía no es un valor permitido para él.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;

UPDATE usuarios SET rol = 'gerente' WHERE rol = 'trabajador';

ALTER TABLE usuarios ALTER COLUMN rol SET DEFAULT 'colaborador';

ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('admin', 'gerente', 'colaborador'));

-- Solo el admin trabaja sin propiedad asignada; gerente y colaborador siempre
-- pertenecen a una.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'admin' OR propiedad_id IS NOT NULL);

COMMENT ON COLUMN usuarios.rol IS
  'admin = todo + usuarios; gerente = leer/editar/subir; colaborador = solo lectura';
