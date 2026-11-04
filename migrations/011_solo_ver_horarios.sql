-- ===========================================================================
-- Excepción personal (no de rol): una cuenta master/gerente puntual que debe
-- quedar de SOLO LECTURA únicamente en el módulo Horarios (ver cat_horario:,
-- cat_lugar_trabajo:, horario_asignado: en src/rutas-datos.js), sin perder
-- ninguno de sus demás permisos de rol en el resto del sistema. A diferencia
-- de rol, que se aplica a muchas cuentas, esto se marca una por una — mismo
-- patrón que usuarios.puede_firmar_contratos (008_rol_consultor.sql).
-- ===========================================================================
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS solo_ver_horarios boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN usuarios.solo_ver_horarios IS
  'Excepción personal: si está en true, esta cuenta (sin importar su rol) queda de solo lectura en el módulo Horarios — ver puedeEscribirClave en src/rutas-datos.js. No afecta ningún otro permiso del rol.';
