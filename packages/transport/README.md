# Transporte P2P — Persona 2

Estado: por implementar. Adaptador Pear/HyperDHT, worker, framing, identidad autenticada y ciclo de vida.

Implementa `TransportPort`. Entrega bytes y la clave autenticada al núcleo; envía los bytes proporcionados por este sin reconstruir evidencia. No accede a SQLite o al corpus. Incluir un transporte en memoria con pérdida y repetición controladas para pruebas.
