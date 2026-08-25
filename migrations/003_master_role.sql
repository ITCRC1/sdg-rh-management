-- ===========================================================================
-- 'admin' pasa a llamarse 'master' — mismo permiso exacto (ve y edita todas
-- las propiedades, administra usuarios), solo cambia el nombre del valor
-- para que coincida con cómo el negocio llama al rol.
--
--   master       lee, edita, sube archivos Y administra usuarios (antes 'admin')
--   gerente      lee, edita, sube archivos, solo su propiedad — sin cambios
--   colaborador  solo lectura, solo su propiedad — sin cambios
-- ===========================================================================

-- Los DOS CHECK hay que quitarlos ANTES de actualizar las filas. El segundo
-- todavía compara contra el texto literal 'admin': si sigue activo cuando el
-- UPDATE cambia el rol a 'master', rechaza esa misma fila porque un admin
-- real no tiene propiedad_id (es NULL) — exactamente lo que pasó la primera
-- vez que se corrió esta migración.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;

UPDATE usuarios SET rol = 'master' WHERE rol = 'admin';

ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'colaborador'));

-- Solo master trabaja sin propiedad asignada; gerente y colaborador siempre
-- pertenecen a una.
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'master' OR propiedad_id IS NOT NULL);

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; colaborador = solo lectura';
