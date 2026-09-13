-- ===========================================================================
-- Se retira el rol "colaborador": era de solo lectura de TODOS los empleados
-- de la propiedad, y ese alcance ya no se quiere para nadie fuera de
-- RRHH/gerencia — el único rol de solo lectura para un trabajador ahora es
-- "empleado" (su propio expediente, nunca el de los demás — ver
-- 006_rol_empleado.sql). Si alguna cuenta quedó con rol='colaborador' antes
-- de este cambio, se convierte a 'empleado' en vez de romperse: seguirá
-- pudiendo entrar, aunque sin usuarios.empleado_clave no verá su expediente
-- hasta que RRHH la vincule (PATCH /api/auth/usuarios con empleadoClave).
-- ===========================================================================
UPDATE usuarios SET rol = 'empleado' WHERE rol = 'colaborador';

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'jefatura', 'empleado'));

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; jefatura = solo lectura + aprobar/editar horas extra de su departamento (usuarios.puesto guarda el departamento); empleado = solo lectura de su propio expediente (usuarios.empleado_clave guarda su clave cat_empleado:<key>)';
