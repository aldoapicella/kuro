# Trabajar en Kuro

Leer primero [la arquitectura](docs/architecture.md) y [el reparto de trabajo](docs/team-plan.md). La base actual es documental y de referencia; las carpetas de aplicación todavía no contienen una implementación.

## Primer corte conjunto

1. Acordar la versión de Node, Electron, QVAC y el gestor de paquetes después de las pruebas iniciales de compatibilidad.
2. Crear los contratos compartidos de `AppPort`, `AiPort` y `TransportPort`, con validación en ejecución y fixtures sintéticos.
3. Cada proveedor entrega un sustituto y pruebas de conformidad de su puerto para que los consumidores puedan avanzar.
4. Integrar pronto un recorrido mínimo y sustituir progresivamente los simuladores por adaptadores reales.

## Cambios cotidianos

- Trabajar en ramas cortas, por ejemplo `ai/embedding-adapter`, `core/approval-outbox` o `desktop/review-screen`.
- Enviar cambios pequeños a `main` mediante pull requests que expliquen comportamiento, validación y límites pendientes.
- Mantener un solo lockfile cuando se configure el workspace; la persona 3 coordina cambios de dependencias y composición.
- Coordinar cambios de `packages/contracts/` antes de modificar consumidores. No importar archivos internos de otro módulo.
- Mantener la política, las migraciones y las transacciones dentro del núcleo. UI y transporte no abren la base de datos directamente.
- Actualizar la declaración de base preexistente del README al incorporar código, plantillas, modelos o ejemplos externos.

## Verificación disponible

```sh
python3 verification/run_checks.py
```

El resultado se escribe en `verification/results.json`, excluido de Git por ser un registro local generado. También se pueden ejecutar únicamente las pruebas:

```sh
python3 -m unittest discover -s verification -v
```

Estas pruebas cubren el modelo de referencia. Las pruebas de TypeScript, QVAC, Pear, Electron y el flujo entre dispositivos se incorporarán con sus implementaciones. Un recorrido simulado debe identificarse como tal.

## Datos de desarrollo

Usar fixtures sintéticos y directorios privados separados para cada identidad de prueba. Guardar claves, bases locales, pesos de modelos y archivos de usuarios fuera de los archivos versionados. `.gitignore` es una ayuda para evitar incorporaciones accidentales, no una frontera de seguridad.
