# Núcleo de custodia — Persona 2

Estado: por implementar. Contiene dominio, casos de uso, política, documentos versionados, SQLite, cola, aprobación, outbox e inbox.

Expone `AppPort` y consume `AiPort` y `TransportPort`. Mantiene el único escritor lógico y la transacción que revalida permisos y guarda la aprobación con sus bytes. Alcance completo en el [plan de equipo](../../docs/team-plan.md).
