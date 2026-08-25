-- ===========================================================================
-- 'admin' pasa a llamarse 'master' — mismo permiso exacto (ve y edita todas
-- las propiedades, administra usuarios), solo cambia el nombre del valor
-- para que coincida con cómo el negocio llama al rol.
--
--   master       lee, edita, sube archivos Y administra usuarios (antes 'admin')
--   gerente      lee, edita, sube archivos, solo su propiedad — sin cambios
--   colaborador  solo lectura, solo su propiedad — sin cambios
-- ===========================================================================

-- El CHECK viejo hay que quitarlo ANTES de actualizar las filas, porque
-- 'master' todavía no es un valor permitido para él.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;

UPDATE usuarios SET rol = 'master' WHERE rol = 'admin';

ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'colaborador'));

-- Solo master trabaja sin propiedad asignada; gerente y colaborador siempre
-- pertenecen a una.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'master' OR propiedad_id IS NOT NULL);

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; colaborador = solo lectura';
