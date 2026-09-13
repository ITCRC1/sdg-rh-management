-- ===========================================================================
-- Nuevo rol "empleado": solo lectura de su PROPIO expediente (no de todos
-- los empleados, a diferencia de colaborador/gerente/master). La cuenta se
-- crea sola cuando RRHH guarda un empleado con nombre, apellidos, cédula y
-- número de empleado completos (ver src/rutas-datos.js) — usuario = primera
-- letra del nombre + primer apellido, clave temporal = número de empleado
-- con ceros a la izquierda, forzando cambio de clave al primer ingreso.
--
-- usuarios.empleado_clave guarda la clave completa cat_empleado:<key> del
-- expediente al que esa cuenta queda amarrada — es el equivalente, para este
-- rol, de lo que usuarios.puesto es para jefatura (el dato que el servidor
-- usa para acotar qué puede leer). Ese alcance lo aplica rutas-datos.js, no
-- es una restricción solo de interfaz.
-- ===========================================================================
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('master', 'gerente', 'jefatura', 'colaborador', 'empleado'));

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empleado_clave text;

-- Empleado pertenece siempre a una propiedad, igual que gerente/jefatura/colaborador.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_propiedad_segun_rol;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_propiedad_segun_rol
  CHECK (rol = 'master' OR propiedad_id IS NOT NULL);

COMMENT ON COLUMN usuarios.rol IS
  'master = todo + usuarios; gerente = leer/editar/subir; jefatura = solo lectura + aprobar/editar horas extra de su departamento (usuarios.puesto guarda el departamento); colaborador = solo lectura; empleado = solo lectura de su propio expediente (usuarios.empleado_clave guarda su clave cat_empleado:<key>)';

COMMENT ON COLUMN usuarios.empleado_clave IS
  'Solo para rol=empleado: la clave cat_empleado:<key> de su propio expediente. Acota qué puede leer en rutas-datos.js.';
