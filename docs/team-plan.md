# Kuro: tres personas, tres módulos que pueden evolucionar por separado

**Reparto recomendado: 1) motor de IA local; 2) núcleo de custodia y comunicación P2P; 3) aplicación de escritorio e integración.** Las tres partes se conectan por contratos TypeScript pequeños. Cada persona desarrolla su módulo con sustitutos de los otros, y se prueba la composición desde las primeras horas.

Este plan desarrolla la decisión de [la arquitectura técnica](architecture.md): el custodio recupera fragmentos, una persona aprueba la entrega y el solicitante puede resumir lo recibido localmente. Una misma instalación puede ser custodio o solicitante según la consulta. Son tres responsabilidades de desarrollo de una aplicación, no tres aplicaciones ni tres roles del negocio.

**Estado:** propuesta de organización e interfaces. El repositorio contiene la arquitectura, un modelo de referencia en Python y carpetas iniciales para los módulos. Los contratos, comandos de desarrollo y adaptadores TypeScript descritos aquí siguen pendientes de implementación.

## 1. Reparto y propiedad del código

| Persona | Entrega principal | Código del que es responsable | Puede demostrar sola |
| --- | --- | --- | --- |
| 1 — IA local | Transformar texto autorizado en vectores, candidatos y resúmenes citados usando QVAC. | `packages/ai/`, pruebas y evaluaciones de IA. | Indexar textos sintéticos, recuperar evidencia y resumir fragmentos sin abrir Electron ni conectar un par. |
| 2 — Custodia y P2P | Decidir qué se permite, conservar el estado y entregar exactamente lo aprobado. | `packages/core/`, `packages/transport/`, migraciones SQLite y validación de contratos compartidos. | Dos núcleos con bases separadas intercambian una entrega con IA simulada y sin interfaz gráfica. |
| 3 — Escritorio e integración | Permitir que una persona importe, consulte, revise, reciba y lea; ensamblar la aplicación. | `apps/desktop/`, composición de dependencias, harness de integración, empaquetado y presentación de demo. | Recorrer todas las pantallas con un núcleo simulado, incluyendo errores y desconexiones. |

La persona 1 necesita mayor comodidad con modelos y evaluación; la 2 con persistencia, seguridad y redes; la 3 con Electron, experiencia de usuario y depuración de integración. La persona 2 tiene el tramo con más invariantes: la 3 asume la composición, el empaquetado y la automatización de escenarios para equilibrar el trabajo.

### Persona 1: motor de IA local

**Responsabilidades**

- Integrar QVAC en su worker local y verificar pronto la carga de embeddings y del LLM en el hardware disponible.
- Definir un perfil de embeddings con modelo, checksum, dimensión, normalización y versión de segmentación. No mezclar perfiles al comparar vectores.
- Vectorizar bloques y preguntas. Recibir del núcleo únicamente el conjunto autorizado para ranking; calcular similitud y combinar resultados literales proporcionados por el núcleo.
- Preparar un contexto de síntesis acotado y explícito a partir de fragmentos recibidos. Devolver esa preparación al núcleo para registrar el manifiesto antes de ejecutar el LLM.
- Ejecutar la preparación exacta mediante QVAC, validar la estructura del resultado, rechazar IDs de pasajes inventados y reconstruir citas desde el contexto recibido.
- Implementar cancelación, errores de modelo y un guardián de exclusión: nunca dos operaciones QVAC activas simultáneas en un dispositivo. El núcleo mantiene la cola de trabajo; el motor no crea otra cola persistente independiente.
- Mantener un conjunto pequeño de preguntas en español con pasajes esperados y casos de evidencia insuficiente.

**Frontera:** no decide permisos, abre la base de datos, enumera archivos, aprueba documentos ni envía mensajes P2P. Su resultado es un cálculo, no una autorización. El núcleo persiste los vectores y comprueba la vigencia de las versiones.

**Bucle de iteración independiente:** cargar un fixture de texto y vectores → ejecutar QVAC o un motor determinista → observar candidatos, referencias, tiempos y memoria → cambiar segmentación, ranking o prompt → repetir el mismo conjunto de evaluación. Los fixtures del ranking representan datos ya autorizados; las pruebas de filtrado real pertenecen al núcleo.

**Aceptación propia**

1. Embeddings y síntesis ejecutados mediante el SDK real, con modelos previamente preparados y sin una API de inferencia en la nube.
2. Recuperación comprobada con preguntas anotadas; dimensiones y perfiles incompatibles producen error explícito.
3. El resumen solo utiliza IDs del contexto y se puede contrastar con sus citas. La validez de IDs no se presenta como prueba de respaldo semántico.
4. Una cancelación o un modelo sin capacidad no impiden leer evidencia ya recibida.

### Persona 2: núcleo de custodia, persistencia y P2P

**Responsabilidades**

- Implementar espacios, miembros, documentos versionados, permisos, solicitudes y entregas. Mantener una única autoridad de política por espacio en cada nodo.
- Importar TXT UTF-8, conservar la representación canónica y producir pasajes con referencias estables. PDF y OCR quedan fuera del primer corte.
- Mantener el único escritor lógico de SQLite. Las migraciones y todas las escrituras de la aplicación pasan por este módulo.
- Materializar restricciones documentales; prefiltrar en SQL antes de entregar vectores al ranking de IA. Publicar generaciones completas del índice y revalidar revisiones al usar resultados.
- Registrar las tareas y aplicar deduplicación, cuotas y selección equitativa por identidad. Despachar una sola operación al motor QVAC; ceder entre lotes de indexación.
- Persistir revisión, aprobación y bytes exactos de salida en una transacción con la política vigente. El transporte recibe esos bytes después del commit.
- Implementar emparejamiento por clave, adaptador Pear/HyperDHT, framing acotado, inbox/outbox, reintentos y correlación. La identidad llega del canal autenticado.
- Guardar respuestas antes de emitir ACK; comprobar permisos, caducidad y revisiones antes de cada nuevo intento de entrega.
- En el solicitante, comprobar condiciones de procesamiento, registrar el manifiesto completo antes del LLM y guardar el resumen como derivado privado. Recibir evidencia nunca ejecuta el modelo automáticamente.

**Frontera:** no depende de componentes visuales ni de detalles internos del SDK. Invoca `AiPort` y `TransportPort`; controla el flujo y la divulgación. La red no obtiene acceso directo al corpus o a SQLite.

**Bucle de iteración independiente:** levantar dos núcleos A/B con directorios privados separados → usar un motor de IA determinista → enviar una consulta mediante transporte en memoria o Pear real → aprobar mediante un cliente de pruebas local → cortar conexión o reiniciar → verificar estado y bytes. No necesita esperar las pantallas o el LLM.

**Aceptación propia**

1. Un documento sin permiso no llega al ranking ni a la entrega.
2. No existe salida con contenido antes de aprobación local válida.
3. Cambiar una versión o revocar permisos invalida una revisión obsoleta o impide el siguiente intento de envío, según el punto de autorización definido en la arquitectura.
4. Caer después del commit y perder un ACK producen reintentos de los mismos bytes, sin duplicar una entrega persistida.
5. El par no puede invocar aprobación, cambios de permisos o síntesis remota.

### Persona 3: escritorio, experiencia e integración

**Responsabilidades**

- Construir una sola aplicación con espacios y capacidades comunes, sin pantallas distintas por profesión.
- Implementar la configuración de identidad, emparejamiento y permisos mínimos, la importación de texto, la consulta a un par, la revisión de fragmentos y la recepción.
- Hacer explícitos en la revisión el destinatario, el texto exacto, las referencias y las condiciones de la entrega. Aprobar usa el ID y revisión del borrador; la UI no reconstruye el paquete.
- Permitir leer evidencia sin LLM y solicitar síntesis local mediante una acción separada. Distinguir visualmente evidencia recibida y resumen generado.
- Implementar estados de desconexión, espera, caducidad, revisión obsoleta, capacidad insuficiente y error; no inferir permisos a partir de controles ocultos.
- Montar Electron, su preload acotado y la composición: crear el núcleo e inyectar los adaptadores exportados por las otras personas. Mantener aislado el renderer.
- Gestionar arranque y cierre de workers mediante las interfaces de ciclo de vida acordadas. El código propio de cada worker sigue perteneciendo a la persona 1 o 2.
- Preparar perfiles locales A/B, empaquetado, instalación reproducible, pruebas de recorrido completo, README y video. Cada persona aporta su sección técnica y declara la base que reutilizó.

**Frontera:** el renderer solo utiliza `AppPort`. No recibe SDK QVAC, sockets, acceso SQL, rutas arbitrarias o un IPC genérico. El proceso principal ensambla dependencias, pero la política y las transacciones siguen dentro del núcleo.

**Bucle de iteración independiente:** abrir la aplicación en modo de escenarios → seleccionar un `FakeAppPort` con respuesta inmediata, espera, desconexión o error → cambiar UI y navegación → repetir. Después, sustituir el fake por el núcleo real sin cambiar componentes.

**Aceptación propia**

1. El flujo completo puede recorrerse con fixtures, y los mismos componentes consumen el núcleo real.
2. La vista permite comprobar exactamente qué se aprobará y quién lo recibirá.
3. Una evidencia guardada continúa legible cuando la síntesis falla.
4. La aplicación integrada arranca con instrucciones reproducibles y una separación visible entre modo demostración simulado y ejecución real.

## 2. Estructura propuesta del repositorio

```text
kuro/
  packages/
    contracts/        # P2 custodia versiones; los tres acuerdan las fronteras
    ai/               # P1: QVAC, preparación de contexto, ranking, validación
    core/             # P2: dominio, casos de uso, política, SQLite y cola
    transport/        # P2: worker Pear y adaptador de transporte
  apps/
    desktop/          # P3: main/composición, preload, renderer y empaquetado
  fixtures/           # Datos sintéticos y respuestas válidas compartidas
  harnesses/
    ai/               # P1: probar IA sin escritorio ni pares
    core/             # P2: dos nodos sin interfaz y con IA determinista
    desktop/          # P3: interfaz con FakeAppPort
  tests/
    contracts/        # Formatos y comportamientos comunes
    integration/      # P3 mantiene el recorrido; cada dueño arregla su módulo
  docs/
    decisions/        # Cambios de contrato y decisiones breves
```

La dependencia es: escritorio → núcleo → puertos de IA y transporte. Los adaptadores y consumidores comparten `contracts`, que no importa Electron, SQLite, Pear o QVAC. Ninguna persona necesita importar archivos internos del paquete de otra.

La integración usa inyección de dependencias dentro de una aplicación local; no requiere inventar tres servidores HTTP, puertos de red locales o despliegues independientes.

## 3. Contratos que se acuerdan al inicio

**Los nombres siguientes son interfaces propuestas de Kuro, no llamadas oficiales del SDK ni código ya implementado.** En los primeros 90 minutos se fijan sus tipos, errores, eventos, fixtures y validadores de ejecución. TypeScript por sí solo no valida lo que llega por IPC o por la red.

### Contrato A: escritorio → núcleo (`AppPort`)

| Comando o lectura | Entrada esencial | Salida o efecto |
| --- | --- | --- |
| `importText` | Espacio, handle local de archivo seleccionado, revisión esperada. | ID de importación y progreso local de indexación. El handle solo se resuelve en el host. |
| `submitQuestion` | Espacio, clave del destinatario emparejado, pregunta y TTL. | `requestId`; progreso posterior por eventos. |
| `listReviews` / `getReview` | Ámbito autorizado y, para detalle, ID de borrador. | Fragmentos exactos, referencias, destinatario, condiciones y revisión. |
| `approveDraft` | `draftId`, `expectedRevision` y digest de la vista revisada. | `deliveryId` o error de revisión/vigencia. No recibe texto de respuesta elaborado por la UI. |
| `getEvidence` | ID de entrega local. | Fragmentos persistidos y referencias recibidas, si el acceso sigue permitido. |
| `requestLocalSummary` | ID de entrega y límites acordados. | `jobId`; resultado privado o causa de no ejecución. |
| `cancelJob` / `subscribe` | ID de trabajo o suscripción local. | Cancelación cooperativa y eventos tipados para refrescar vistas. |

Las operaciones de configuración siguen el mismo patrón: comandos locales explícitos para emparejar, importar miembros o cambiar permisos, con revisión y autoridad verificadas en el núcleo. No se reutilizan como mensajes remotos.

Eventos mínimos: importación actualizada, solicitud actualizada, revisión disponible, entrega recibida, resumen actualizado y estado de conexión. Son avisos: al abrir o reconectar una pantalla se consulta el estado persistido; un evento perdido no borra trabajo.

### Contrato B: núcleo → IA (`AiPort`)

| Operación | Entrada | Resultado y límite |
| --- | --- | --- |
| `embedBlocks` | `jobId`, textos identificados y perfil de embeddings fijado. | Vectores asociados a sus IDs y perfil real utilizado; el núcleo valida y persiste. |
| `rankAllowed` | Vector de pregunta, snapshot de vectores ya autorizado y candidatos literales ya filtrados. | IDs y puntuaciones. No puede ampliar el universo de documentos. |
| `prepareSummary` | Pregunta y evidencia cuyo procesamiento autorizó el núcleo; presupuesto. | Contexto exacto propuesto, todas sus dependencias, perfil de modelo y estimación de tokens. No genera todavía. |
| `runPreparedSummary` | Preparación exacta cuyo manifiesto ya guardó el núcleo. | Resumen estructurado con IDs válidos o evidencia insuficiente; sin herramientas ni envío remoto. |
| `cancel` / `getCapabilities` | ID de trabajo o consulta local. | Estado de cancelación y capacidades observadas, sin prometer rendimiento no medido. |

El embedding de la pregunta usa la misma operación y perfil que los bloques, sobre una entrada identificada. Los tokens, pesos y cachés se gestionan dentro del adaptador. La cola persistente, las cuotas y las decisiones de inicio pertenecen al núcleo.

El núcleo valida que la preparación solo contenga fuentes autorizadas y persiste el contexto completo antes de llamar a `runPreparedSummary`. El adaptador ejecuta ese contexto sin añadir documentos o historia oculta; si necesita modificarlo, devuelve una nueva preparación antes de inferir. Las dependencias incluyen todo el texto visto, aunque el resultado no lo cite.

Para empezar, un ejemplo común de salida de síntesis es:

```json
{
  "status": "answer",
  "claims": [
    { "text": "La aprobación sigue pendiente.", "spanIds": ["s1"] }
  ]
}
```

`s1` es un alias de ese contexto, no un ID universal. El núcleo conserva su correspondencia con origen, documento, versión y pasaje. La UI recibe las citas reconstruidas; el texto del LLM no sustituye las fuentes.

### Contrato C: núcleo ↔ transporte (`TransportPort`)

- Entrada al núcleo: bytes recibidos y clave autenticada suministrada por el canal. Un `sender` declarado en el JSON no sirve como identidad.
- Salida al transporte: clave de destino y bytes preparados por el núcleo. Para evidencia, son exactamente los bytes de la outbox autorizada; el adaptador no vuelve a serializar ni redactar contenido.
- Ciclo de vida: iniciar con la configuración de identidad y red, informar conexión/desconexión y cerrar de forma controlada. Confirmar una escritura al socket no equivale a `RESPONSE_ACK`.
- Mensajes de aplicación: `SEARCH_REQUEST`, `RECEIVED`, `APPROVED_RESPONSE`, `RESPONSE_ACK` y `CLOSED`, con versión y esquema estricto.
- Límites iniciales compartidos: frame de 32 KiB, pregunta de 2 KiB y TTL máximo de 24 horas. El framing rechaza longitudes excesivas antes de reservar el cuerpo.

La persona 2 implementa tanto el adaptador real como uno en memoria con fallos controlables. La persona 3 puede sustituirlo al montar la aplicación. Una prueba con transporte en memoria no cuenta como demostración de P2P real.

### Errores comunes y datos estables

Fijar códigos internos como `ACCESS_DENIED`, `STALE_REVISION`, `MODEL_UNAVAILABLE`, `CAPACITY_EXCEEDED`, `EXPIRED`, `PEER_OFFLINE` y `INVALID_MESSAGE`; cada puerto expone solo los que le corresponden. Son códigos locales para pruebas y UI. No se envían detalles internos al par ni se revela por red si existen documentos restringidos.

El contrato incluye semántica de cancelación, orden de persistencia/acuse, IDs, revisiones y digest. Las rutas locales, conexiones SQL, instancias del SDK y objetos de Electron nunca son DTO compartidos.

## 4. Cómo evitar que los módulos se bloqueen mutuamente

| Persona | Dependencia sustituida durante su trabajo | Sustituto y escenario |
| --- | --- | --- |
| 1 | Núcleo, SQLite y red. | Archivos de fixture con bloques, vectores permitidos y evidencia recibida. |
| 2 | QVAC y escritorio. | `FakeAiPort` determinista y cliente de comandos; `MemoryTransport` para pérdida, repetición y desconexión. |
| 3 | Núcleo, QVAC y P2P. | `FakeAppPort` con snapshots y eventos de éxito, espera, revisión obsoleta, capacidad insuficiente y error. |

**Regla:** cada proveedor entrega su contrato, un sustituto y una prueba de conformidad. Los consumidores pueden cambiar su implementación interna sin pedir una nueva versión si conservan esa conducta. Cuando aparece una diferencia entre fake y adaptador real, se corrigen también el fixture y la prueba compartida.

Los datos de prueba son sintéticos: dos espacios, dos identidades, documentos permitidos y restringidos, versiones cambiadas y frases que contradicen deliberadamente un resumen incorrecto. Así se prueba la custodia, además del recorrido exitoso.

No se necesita que el modelo produzca una frase exactamente igual entre ejecuciones. Las comprobaciones de IA miden referencias permitidas, cobertura anotada y respaldo; los fakes fijan respuestas solamente para probar el flujo determinista.

## 5. Uniones que deben permanecer juntas

1. **Permisos + SQLite + aprobación + outbox: persona 2.** Revalidar política y confirmar bytes aprobados requiere una transacción local. Dividir ese commit entre bases o módulos autónomos rompería el invariante.
2. **Embeddings + LLM + control de ejecución QVAC: persona 1.** Un equipo puede custodiar y solicitar. Las dos tareas comparten memoria y no deben arrancar motores independientes sin coordinación.
3. **Admisión, cola y prioridad: persona 2.** Existe una cola de aplicación; el motor solo refuerza que haya una operación activa. No hay tres políticas de concurrencia según quién llamó.
4. **Renderer + preload + composición de la app: persona 3.** La UI puede cambiar sin obligar a las otras personas a editar componentes. El host inyecta puertos; no replica reglas del núcleo.
5. **Tipos y validadores: un paquete compartido.** La persona 2 custodia cambios; las tres acuerdan cualquier ruptura. Los mismos mensajes tienen la misma interpretación en UI, núcleo, fixtures y pruebas.

Separar el trabajo por «custodio», «solicitante» y «red» duplicaría permisos y motores en ambos extremos. Separarlo por estas capacidades mantiene un propietario claro por invariante y permite reutilizar el mismo código en cada instalación.

## 6. Integración durante las 48 horas

Las horas son relativas al inicio de la ventana de trabajo. Se reserva el tramo final para estabilizar y entregar; las fronteras se ejercitan antes para que los problemas de unión aparezcan con margen.

| Ventana | Persona 1 | Persona 2 | Persona 3 | Resultado común |
| --- | --- | --- | --- | --- |
| 0–2 h | Define `AiPort`, fake y fixture. | Define `AppPort`, `TransportPort`, esquemas y estados mínimos. | Crea la estructura del repositorio y monta una pantalla con `FakeAppPort`. | Contrato v1 y primer arranque con sustitutos; propietario por carpeta. |
| 2–6 h | Verifica QVAC real, embeddings y generación por separado. | Verifica SQLite en el runtime elegido y un intercambio Pear entre dos identidades. | Verifica Electron/preload y que el host pueda arrancar los workers exportados. | Se conocen los riesgos reales de compatibilidad; modelos y versiones fijados. |
| 6–16 h | Embeddings, ranking autorizado y preparación de resumen. | Importación, versiones, permisos, índice persistido y API local. | Consulta, importación, revisión y evidencia con fakes. | Primer corte real: importar → preguntar → mostrar fragmentos para revisión. |
| 16–26 h | Síntesis local y validación de citas en A. | Aprobación transaccional, salida, recepción antes de ACK y correlación. | Conecta vistas a `AppPort` real e integra síntesis opcional. | Dos dispositivos: consulta → aprobación → evidencia → resumen local opcional. |
| 26–36 h | Evalúa español, cancelación, memoria y evidencia insuficiente. | Reinicios, reintentos, revocación, duplicados y límites. | Ejecuta escenarios completos y corrige UX/errores de composición. | Flujo real probado ante fallos; lectura funciona sin síntesis. |
| 36–42 h | Documenta modelo, configuración y mediciones reales. | Documenta protocolo, datos, amenazas y pruebas. | Instalación limpia, prueba LAN sin internet y ensayo del video. | Candidato de entrega reproducible y limitaciones registradas. |
| 42–48 h | Corrige bloqueantes de IA. | Corrige bloqueantes del núcleo o transporte. | Congela versión, arma README y video accesible de menos de cinco minutos. | Repositorio y demostración final; bases preexistentes declaradas. |

Si una integración falla, la persona 3 conserva un caso mínimo reproducible y la persona propietaria corrige su módulo. El contrato no se modifica unilateralmente para esconder el fallo.

La NVIDIA P3450 permanece fuera del camino crítico mientras su compatibilidad y capacidad no estén verificadas. Primero se obtiene el recorrido real en los equipos disponibles que superen las pruebas iniciales. Los sustitutos permiten seguir desarrollando, pero no reemplazan la evidencia de QVAC y Pear reales para la entrega.

## 7. Prueba final que une a las tres personas

Preparar dos dispositivos A y B con modelos ya descargados, identidades verificadas y conectividad local comprobada. La prueba de arranque sin internet debe verificar descubrimiento/conexión local y configuración de bootstrap; P2P por sí solo no garantiza esa condición.

1. B importa texto sintético y genera su índice con QVAC; contiene un documento que A no puede recibir.
2. A envía una pregunta a B. B valida permisos y recupera candidatos mediante embeddings locales y ranking sobre filas permitidas.
3. Una persona revisa en B los fragmentos exactos y el destinatario. Antes de aprobar no llega contenido a A.
4. B aprueba; se interrumpe la conexión y se reinicia el proceso. Al reconectar, se reenvían los bytes persistidos. A los guarda y acusa recibo sin crear otra entrega.
5. A lee la evidencia y pide, mediante una acción local, un resumen QVAC con referencias. B no ejecuta un LLM para esa entrega.
6. Se repite con síntesis no disponible: la lectura funciona. Se repite con permiso revocado antes del siguiente intento: ese intento no divulga contenido.

Registrar SDK/modelos utilizados, equipos, tiempos observados y pruebas que pasaron. Dos perfiles en el mismo ordenador sirven para integración temprana; no sustituyen la prueba de red y capacidad entre dispositivos. Un video con fixtures puede ilustrar diseño, pero debe identificarlos y demostrar también el recorrido real.

## 8. Reglas de colaboración e iteración posterior

- Mantener un monorepo, un lockfile y versiones de runtime acordadas. La persona 3 integra cambios de dependencias; los propietarios proponen solo los paquetes que necesitan.
- Usar ramas cortas por cambio, con revisiones pequeñas y frecuentes. Evitar tres ramas que diverjan durante toda la ventana de trabajo.
- El propietario de un paquete mantiene su interfaz pública, fake, escenarios y documentación mínima. Las otras personas consumen ese paquete sin editar su implementación interna.
- Una ruptura de contrato requiere un ejemplo de entrada/salida, cambio de esquema y prueba que describa la nueva conducta. Se coordina antes de mezclarla. No se añaden campos al protocolo estricto suponiendo compatibilidad automática.
- Una migración de SQLite la hace la persona 2; un cambio de modelo o perfil vectorial lo inicia la 1 y coordina la regeneración con la 2; un cambio visual sin DTO nuevos lo hace la 3 sola.
- Medir por resultados integrables: P1 entrega cálculo con contrato; P2 entrega estado autorizado y persistido; P3 entrega recorrido utilizable. Ninguno necesita comprender o modificar todo el sistema para mejorar su parte.

**Primer acuerdo operativo:** cada persona debe poder levantar su módulo, cargar un escenario y comprobar su resultado sin arrancar los otros dos módulos reales. La integración final consiste en sustituir esos adaptadores de prueba por las implementaciones reales ya ejercitadas durante el desarrollo.
