-- ===========================================================================
-- Quinta "propiedad": la agencia de viajes del grupo. No es un hotel — usa el
-- logo de la marca paraguas (The Costa Rica Collections) en vez del logo de
-- una propiedad específica — pero funciona igual que las otras 4 para todo lo
-- demás: silo de datos independiente, usuarios asignables, catálogos propios.
-- ===========================================================================
INSERT INTO propiedades (id, nombre, orden) VALUES
  ('agencia', 'The Costa Rica Collections', 5)
ON CONFLICT (id) DO NOTHING;
