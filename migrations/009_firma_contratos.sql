-- ===========================================================================
-- Bandeja de firma de contratos — la fase que 008_rol_consultor.sql dejó
-- pendiente ("ese flujo de firma en sí se construye en una fase aparte").
--
-- Reutiliza documentos_emitidos (tipo='contrato') en vez de una tabla nueva:
-- ya es donde queda archivado cada contrato generado, ya filtra por
-- propiedad/cédula, y ya es de solo-inserción con UPDATE permitido (ver el
-- trigger trg_emitidos_no_delete de 001_init.sql) — el mismo mecanismo que
-- usa anulado_en/anulado_por/anulado_motivo para "anular" sirve igual para
-- marcar el estado de la firma.
--
-- Tres pasos, cada uno con su propio trío _en/_por/_(extra), igual que ya
-- existe para anulado_en/anulado_por/anulado_motivo:
--   1. enviado_firma_*   — RRHH/gerencia manda el contrato ya generado a la
--                          bandeja del contador jefe (PATCH .../enviar-firma).
--   2. firmado_*         — el contador jefe (usuarios.puede_firmar_contratos)
--                          lo firma (PATCH .../firmar).
--   3. rechazado_firma_* — o lo rechaza con motivo (PATCH .../rechazar-firma),
--                          lo que limpia enviado_firma_* al día siguiente si
--                          RRHH lo vuelve a enviar (ver rutas-datos.js).
-- Se guarda el correo además del id de usuario (a diferencia de anulado_*)
-- porque la bandeja necesita mostrar "firmado por fulano@..." sin tener que
-- ir a buscarlo a la tabla usuarios.
-- ===========================================================================
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS enviado_firma_en timestamptz;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS enviado_firma_por uuid REFERENCES usuarios(id);
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS enviado_firma_por_email text;

ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS firmado_en timestamptz;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS firmado_por uuid REFERENCES usuarios(id);
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS firmado_por_email text;

ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS rechazado_firma_en timestamptz;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS rechazado_firma_por uuid REFERENCES usuarios(id);
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS rechazado_firma_por_email text;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS rechazado_firma_motivo text;

CREATE INDEX IF NOT EXISTS idx_documentos_emitidos_firma_pendiente
  ON documentos_emitidos (propiedad_id, enviado_firma_en DESC)
  WHERE tipo = 'contrato' AND enviado_firma_en IS NOT NULL AND firmado_en IS NULL AND rechazado_firma_en IS NULL;

COMMENT ON COLUMN documentos_emitidos.enviado_firma_en IS
  'Solo aplica a tipo=contrato: cuándo RRHH/gerencia lo mandó a la bandeja de firma. NULL = todavía no se ha enviado.';
COMMENT ON COLUMN documentos_emitidos.firmado_en IS
  'Cuándo lo firmó la cuenta con usuarios.puede_firmar_contratos. Exige enviado_firma_en previo (ver PATCH /api/documentos/:id/firmar).';
COMMENT ON COLUMN documentos_emitidos.rechazado_firma_en IS
  'Cuándo lo rechazó el firmante en vez de firmarlo — rechazado_firma_motivo explica por qué. RRHH puede volver a enviarlo a firma después de corregirlo, lo que limpia estos tres campos.';
