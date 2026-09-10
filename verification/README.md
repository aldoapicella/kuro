# Kuro: especificación ejecutable de diseño

Este directorio convierte una parte crítica de la arquitectura en contratos comprobables: permisos, dependencias de evidencia, aprobación y entrega. No es una aplicación QVAC, un prototipo funcional entre pares ni una implementación de seguridad lista para uso real.

## Ejecutar

Desde la raíz del proyecto, con Python 3.10 o posterior y su módulo estándar SQLite:

```sh
python3 verification/run_checks.py
```

No requiere paquetes externos ni red. Produce `verification/results.json` con nombres de pruebas, resultados, runtime y SHA-256 de los documentos y código examinados. El comando alternativo `python3 -m unittest discover -s verification -v` ejecuta las pruebas sin generar el registro.

## Qué se comprueba

- Una matriz de 256 combinaciones independientes de identidad, membresía, permisos, documento y vigencia.
- Ausencia de acceso implícito por `manage`; predicado que reserva cambios de contenido a la autoridad de política del espacio.
- Restricciones de todas las fuentes expuestas al modelo, incluso las no citadas.
- Alcance del espacio, versiones, audiencia de la pregunta e IDs de pasajes.
- Reconstrucción de citas desde el texto original de la versión registrada.
- Ausencia de despacho sin aprobación; revisión obsoleta y doble aprobación.
- Reversión transaccional si ocurre una excepción entre aprobación y outbox.
- Persistencia de bytes al cerrar y reabrir SQLite; reintentos de esos mismos bytes.
- Deduplificación y rechazo de otro par, espacio o contenido distinto con el mismo ID.
- Revocación antes de un nuevo intento y límite del control sobre bytes ya entregados al transporte.

## Qué no se comprueba

La arquitectura confirmada ahora usa embeddings QVAC e índice filtrado en el custodio; este entrega fragmentos aprobados, y el solicitante puede resumirlos con QVAC local. Las 16 pruebas existentes cubren el contrato anterior de citas, permisos y entrega. No prueban embeddings, SQL de recuperación, ranking, actualización del índice, condiciones de procesamiento recibidas, esquema de afirmaciones ni respaldo semántico. Tampoco prueban colas, concurrencia o RAM. La síntesis en el solicitante es una decisión de diseño, no una integración probada; no se autoriza delegación automática a terceros.

El modelo abstrae la identidad y recibe una política confiable como argumento. El predicado de modificación de permisos se prueba, pero no existe una interfaz de administración. No existe un parser de red ni un worker QVAC. La inbox es un diccionario en memoria; no demuestra persistencia antes de ACK. Reabrir SQLite no equivale a cortar la energía ni matar un proceso durante un commit.

La implementación TypeScript deberá leer política, revisiones y estado en la misma transacción de su escritor local. El modelo reconstruye los bytes durante `dispatch` solo para detectar inconsistencias en las pruebas; el producto debe validar las dependencias y transportar los bytes aprobados persistidos, sin regeneración.

`qvac-package-inspection.json` registra una inspección estática del paquete publicado 0.19.0. Describe declaraciones de API y su huella, no resultados de inferencia.

## Base y atribución

Código de referencia y pruebas escritos para esta propuesta. Uso de Python, unittest y SQLite de biblioteca estándar. El diseño adapta conceptos de los materiales oficiales públicos de *Generative AI Design Patterns* y *Building Applications with AI Agents*, citados en la arquitectura. No se copiaron implementaciones de sus repositorios ni se emplearon inferencias remotas. La arquitectura explica cómo deberá integrarse el SDK obligatorio de QVAC; este directorio por sí solo no satisface el requisito de una aplicación construida con QVAC.
