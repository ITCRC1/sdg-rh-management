-- ===========================================================================
-- Firma de contratos: ahora "firmar" exige subir el PDF firmado de regreso
-- (pedido explícito del usuario, para mantener la integridad legal del
-- proceso — antes PATCH .../firmar solo ponía una fecha y un correo, sin
-- ningún archivo de respaldo que probara que el contrato de verdad se
-- firmó). Se guarda en la MISMA fila del contrato en documentos_emitidos
-- (no una tabla nueva, mismo criterio que ya usa 009_firma_contratos.sql),
-- con las mismas 4 columnas que ya usa el documento original
-- (contenido/mime/nombre_archivo/tamano_bytes), con el sufijo _firmado para
-- no confundirlas — así un contrato puede tener el PDF generado por el
-- sistema (contenido) Y el PDF realmente firmado y escaneado (contenido_firmado)
-- como dos archivos distintos de la misma fila.
-- ===========================================================================
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS contenido_firmado bytea;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS mime_firmado text;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS nombre_archivo_firmado text;
ALTER TABLE documentos_emitidos ADD COLUMN IF NOT EXISTS tamano_bytes_firmado integer;

COMMENT ON COLUMN documentos_emitidos.contenido_firmado IS
  'El PDF realmente firmado, subido al confirmar PATCH /api/documentos/:id/firmar — ya no basta con confirmar sin archivo, para mantener la integridad legal del contrato. Se descarga en GET /:id/archivo-firmado.';
