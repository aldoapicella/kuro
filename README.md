# Kuro

Nombre temporal de una aplicación para consultar y compartir información confidencial entre pares, con inferencia local mediante QVAC.

**El custodio busca; el solicitante puede resumir.** El custodio mantiene sus originales e índice, recupera fragmentos bajo permisos y revisa su entrega. El solicitante recibe únicamente los fragmentos aprobados y puede resumirlos localmente con referencias.

## Estado del proyecto

Base inicial para trabajar entre tres personas. Incluye arquitectura, plan de implementación, carpetas de módulos y un modelo de referencia ejecutable en Python. La aplicación Electron/TypeScript, el SDK QVAC y el transporte Pear todavía están por integrar. Las pruebas de referencia no demuestran que exista una aplicación funcional ni validan su seguridad en producción.

## Empezar

```sh
git clone https://github.com/aldoapicella/kuro.git
cd kuro
python3 verification/run_checks.py
```

El repositorio es privado: clonar requiere una cuenta autorizada. Las pruebas requieren Python 3.10 o posterior y su SQLite de biblioteca estándar; no descargan modelos ni necesitan dependencias externas. Los comandos de desarrollo de la aplicación se definirán al fijar los contratos y verificar los runtimes.

- [Arquitectura técnica y fuentes](docs/architecture.md)
- [Plan de trabajo para tres personas](docs/team-plan.md)
- [Cómo contribuir e integrar cambios](CONTRIBUTING.md)
- [Alcance exacto de las pruebas de referencia](verification/README.md)
- [PDF de arquitectura previo, conservado con el nombre PISTA](docs/reference/architecture-pista.pdf)

## Reparto de implementación

| Responsable | Carpetas | Entrega |
| --- | --- | --- |
| Persona 1: IA local | `packages/ai/`, `harnesses/ai/` | QVAC, embeddings, ranking autorizado, contexto, síntesis y evaluación. |
| Persona 2: custodia y P2P | `packages/core/`, `packages/transport/`, `harnesses/core/` | Permisos, versiones, SQLite, aprobación, recepción y reintentos. Custodia los contratos compartidos. |
| Persona 3: escritorio e integración | `apps/desktop/`, `harnesses/desktop/`, `tests/integration/` | Electron, interfaz, composición de dependencias, empaquetado y demostración. |

Las carpetas son puntos de partida; todavía no son paquetes instalables. El primer acuerdo conjunto es definir `AppPort`, `AiPort` y `TransportPort` con tipos, validadores, ejemplos y sustitutos para trabajar en paralelo. Una misma aplicación puede ser custodio o solicitante según la consulta.

## Invariantes de la implementación

- Toda inferencia debe ejecutarse localmente con QVAC; no se añade una API de inferencia en la nube.
- Los permisos se filtran antes del ranking. La IA no concede acceso ni aprueba entregas.
- Política, revisión, aprobación y bytes de outbox se confirman mediante el único escritor lógico de SQLite.
- El transporte envía exactamente los bytes aprobados. La recepción persiste antes de confirmar con ACK.
- Recibir evidencia no inicia síntesis automáticamente. El resumen local conserva todas las dependencias del contexto.
- Revocar acceso no recupera información ya entregada. Las limitaciones y pruebas pendientes están documentadas en la arquitectura.

## Base preexistente y atribución

Esta sección declara la base de este repositorio para la entrega al concurso:

- El diseño, el reparto de trabajo y el modelo de referencia se desarrollaron antes de crear este repositorio, durante la preparación de la misma propuesta bajo el nombre **PISTA**, el 9 de septiembre de 2026, con asistencia de Codex. Se incorporan como base inicial de Kuro.
- `docs/architecture.md` y `docs/team-plan.md` adaptan esos documentos al nombre Kuro. `docs/reference/architecture-pista.pdf` conserva el PDF previo sin modificar. No es una versión de una aplicación ya construida.
- `verification/` incorpora el código Python de referencia y sus pruebas preexistentes; se actualizan el nombre y las rutas del registro de comprobaciones para este repositorio. Usa Python, unittest y SQLite de biblioteca estándar.
- `verification/qvac-package-inspection.json` conserva una inspección estática del paquete QVAC publicado. No representa una ejecución del SDK.
- El diseño se apoya en documentación pública oficial de QVAC, Pear, Electron y SQLite, y en materiales públicos de *Generative AI Design Patterns* y *Building Applications with AI Agents*. Las fuentes están identificadas en la arquitectura; no se incorporan implementaciones de los repositorios de esos libros.
- Se añaden en este arranque el README, las instrucciones de colaboración, la configuración de Git y las carpetas de los módulos. Las dependencias, modelos, ejemplos o código adicional que se incorporen deben registrarse aquí con su procedencia y licencia aplicable.

No se incluyen documentos confidenciales reales, credenciales ni pesos de modelos. No se ha seleccionado una licencia abierta para el proyecto; se mantiene como repositorio privado.

## Entrega al concurso

El repositorio debe ser accesible al jurado durante toda la evaluación. Al mantenerlo privado, habrá que conceder acceso a las cuentas que indique la organización. El video demostrativo debe durar como máximo cinco minutos y tener un enlace accesible sin credenciales.
