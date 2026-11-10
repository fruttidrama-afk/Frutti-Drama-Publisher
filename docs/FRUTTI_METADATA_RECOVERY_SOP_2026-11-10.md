# FruttiDrama — SOP ACTUAL de conciliación manual y paquetes creativos integrados
**Versión operativa: 2026-11-10.** Sustituye íntegramente el procedimiento anterior de extracción de narrativa desde prompts.

## 1. Decisión irrevocable de producto
**NO utilizar jamás inteligencia artificial, reglas de extracción, palabras clave, historias inferidas ni lectura semántica de un prompt de Google Flow para fabricar títulos/descripciones de FruttiDrama.**
El antiguo extractor `story_action_v34` quedó retirado del backend y eliminado de las dos interfaces. La petición obsoleta `action="suggest"` devuelve HTTP 410 `NARRATIVE_EXTRACTOR_RETIRED`.
El usuario ha indicado expresamente que el método fue disfuncional y no se volverá a emplear, ni en conciliación ni cuando retorne la producción.

## 2. Conciliación histórica de los 31 videos
El operador **ve el MP4 real** y determina temporada/episodio. No asignar identidad por orden de tiles, transcripciones tentativas ni storyboard previo.
Se ofrecen exactamente dos alternativas editoriales:
1. **Metadatos históricos originales**: solo cuando hay título y descripción auténticos documentados, recuperarlos sin reinterpretar el prompt; T2E2–T2E13 provienen de `FruttiDrama-Publisher/queue.js:T2_CANON`. La copia canónica podría diferir de una edición posterior de YouTube; cotejar con el video.
2. **Redacción manual con estructura canónica**: el operador escribe TODO el contenido del título y de la descripción; el panel solo aporta formato/hashtags, nunca adivina sucesos.

Formato manual de título: `GANCHO CENTRAL: [hecho dramático] #Shorts #ViralShorts #FruttiDrama`.
- `GANCHO CENTRAL` representa DOS PALABRAS INICIALES EN MAYÚSCULAS, separadas de una frase sobre lo que efectivamente ocurre mediante dos puntos.
- 100 caracteres MÁXIMO contando espacios y hashtags; sin truncamiento ni puntos suspensivos nuevos.
- Formato descripción: una o dos frases reales sobre quién hace qué y qué cambia, línea vacía, y `#Shorts #ViralShorts #FruttiDrama`.
- La plantilla con los corchetes es **solo una guía** y está bloqueada en validación hasta que se escriba un texto real.
- Excepciones (tres palabras o puntos suspensivos) son admisibles SOLO cuando corresponden a un par histórico canónico literal, título Y descripción idénticos al archivo verificado; jamás para textos nuevos.

El **prompt original** se pega si está disponible, pero **NO es requisito** para identificar y guardar el MP4: si no se encuentra se registra `generation_prompt=""` y `prompt_provenance="historical_prompt_not_yet_available"` sin inventar contenido. Puede adjuntarse después reabriendo la ficha. El título/descripcion manuales son la fuente editorial para videos históricos identificados sin su prompt.

Controles: cada archivo mantiene SHA-256 real, índice, identidad, edición con `expected_revision` optimista, y bloqueo de duplicados por temporada/episodio. El formulario guarda únicamente `publisher_frutti_reconstructed_stock` con `record_status=reconstructed_unapproved`, `publication_status=unverified`; no aprueba, genera, sube, agenda, publica ni levanta `historical_reconciliation_pending`. No borrar ni reemplazar copias MP4.

## 3. Temporada 3
`publisher_runtime_publishers.config.content.initial_episodes` conserva 12 planes narrativos; el inventario migrado señala seis episodios en Review y otros seis planes sin render confirmado. NINGUNA de estas 12 sinopsis es prueba de 12 MP4 ni de metadatos finales históricos.
No presentar `season3-story-metadata.js` como un archivo de títulos históricos: sus títulos fueron reconstruidos y el modo actual **NO los expone** como recuperación histórica. Si no existe título/descr. auténtico para el episodio, solo se ofrece redacción manual.

## 4. Nueva producción — paquete creativo único y atómico
El **generador de episodios** recibe primero una idea editorial estructurada con `hook`, `story`, `publicationHook` (gancho de título de exactamente dos palabras, cuando el hook narrativo original tenga más de dos), `titleCore` y `descriptionCore` o equivalentes `title`/`description`.
En la MISMA etapa autoral, `runtime-config.js:materializeCreativePackage` produce el prompt de Google Flow y la copia editorial del episodio desde **esa misma idea previa**. No permite producir prompt si falta el título o la descripción del origen. No extrae ni sintetiza la copia a partir del prompt creado: el prompt es una salida hermana, no fuente de lectura.
Se registra en una transacción SQLite **un único paquete** `(season,episode,hook,story,prompt,title,description,promptHash,packageHash,packageId)` en `factory_items` y en el ledger privado `factory_creative_packages`. La tabla ledger es append-only con triggers que rechazan UPDATE/DELETE.
El render sólo puede enviarse a Flow con copia y paquete completos. Review, aprobación, Stock y YouTube **consumen la misma copia inmutable**, contrastada contra el ledger y su hash. Nunca recalculan textos posteriormente ni aplican fallback para FruttiDrama: faltante/discordancia provoca un bloqueo explícito.
La tabla de ideas T3 ya posee 12 **paquetes editoriales de planificación**, autorizados como fuente futura pero NO renders existentes. No retroactivarlos a MP4 de Review ni a títulos de YouTube. El generador sigue condicionado a nuevos episodios genuinos; no repetir cíclicamente copias de seeds sin autoría nueva.

## 5. Activación y verificación
El backend temporal `publisher-frutti-recap` usa JWT del propietario más verificación de pertenencia; `verify_jwt=false` del gateway no equivale a endpoint público. El GET devuelve `metadata_modes=["historical","manual"]` y solo archivo canónico, no tramas inventadas.
**No levantar la pausa histórica ni reanudar producción/publicación solo por haber cambiado este código.** Primero deben verificarse los mapeos reales de video→temporada/episodio con consentimiento del operador, consistencia de stock y medios, OAuth real al canal correcto, ID de proyecto Flow, obligaciones ambiguas remotas, y una ejecución completa antes de declarar autonomía.
Pruebas requeridas: `node scripts/test-frutti-manual-recovery.mjs`, `node scripts/check-unified-factory-ui.mjs` y smoke de paquete creativo + ledger; confirmar ejecución CI y despliegue servido. Los tests en memoria no prueban la carga autenticada desde Safari. No gastar créditos pagos, no usar TinyFish, no hacer generación/publicación sintética.

## 6. Intervención humana y formato de respuesta
Cuando el próximo paso dependa de que el operador reconozca visualmente un video, indicar exactamente qué debe hacer en el panel, siempre al **final** de la respuesta; no pedirle tareas técnicas que pueda hacer el asistente. Todo paso sin intervención humana se completa antes de responder, sin prometer trabajo en segundo plano.
