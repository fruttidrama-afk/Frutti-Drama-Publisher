# FruttiDrama — Conciliación manual y paquetes creativos de origen
**Contrato vigente: 10 de noviembre de 2026.** Este documento reemplaza cualquier instrucción anterior que intentaba interpretar el prompt de Google Flow para inventar un título o descripción.

## Principio innegociable
El contenido narrativo de un prompt NO se volverá a analizar con IA, expresiones regulares o heurísticas para generar títulos/descripciones una vez creado el video. El extractor `story_action_v34` fue retirado de la API activa. El endpoint de sugerencia ahora retorna **HTTP 410 NARRATIVE_EXTRACTOR_RETIRED** y la interfaz ya no presenta sus controles. La implementación archivada no está desplegada.

## Etapa actual: identificación de contenido ya generado
La operatoria es humana. Cada MP4 original se reproduce y se asigna manualmente a temporada/episodio, sin inferir identidad por índice, transcripción, orden de archivos, plan o coincidencia de nombre. El prompt COMPLETO y REAL de Google Flow puede pegarse en el mismo acto si está a mano; si no, se deja **vacío y señalado como pendiente**. Nunca copiar el plan de Prompt Studio para fingir autenticidad, nunca bloquear la identificación de un MP4 porque falte su prompt. Dos y solo dos opciones de metadatos:

1. **Recuperar título y descripción históricos:** mostrar botón solamente cuando el catálogo auténtico incluye el par del episodio. Hasta la fecha la única fuente confirmada es el constructor canónico original de `FruttiDrama-Publisher/queue.js` para **T2E2–T2E13 (12 pares)**; esto prueba el copy canónico del código antiguo, NO una edición final de YouTube. Prohibido reconstruir o mostrar los títulos derivados de tramas T3 como si fueran históricos. Las 12 historias T3 se conservan como planificación independiente; Review T3E1–E6 NO prueba que existan 12 videos generados.
2. **Plantilla canónica para completar manualmente:** título `GANCHO CENTRAL: [describí el hecho] #Shorts #ViralShorts #FruttiDrama` y descripción `[Contá qué sucede en el video y a quién afecta.]\n\n#Shorts #ViralShorts #FruttiDrama`. Los corchetes y el gancho del ejemplo DEBEN reemplazarse por texto redactado por la operatoria. El título comienza con **exactamente dos palabras en mayúsculas**, luego dos puntos, descripción atractiva del acontecimiento real y hashtags. Máximo **100 caracteres** incluyendo hashtags. La descripción termina con esos hashtags.

La interfaz permite seleccionar una fuente histórica o una plantilla manual sin sobrescribir automáticamente ninguna edición previa. El backend valida la estructura y rechaza el ejemplo sin completar. Las excepciones antiguas de 3 palabras / elipsis solo se permiten si título Y descripción coinciden exactamente con el par canónico original del episodio. Guardar en `publisher_frutti_reconstructed_stock` NO equivale a aprobar, programar ni publicar. Se mantiene MP4, SHA-256 y prompt real con revisionado y owner token. Estado obligatorio `reconstructed_unapproved`, publicación `unverified`.

## Etapa posterior: creador de episodios produce un solo paquete creativo
El **generador de episodios** debe entregar en UNA decisión la idea/historia, prompt de Flow, título editorial y descripción editorial. Estos tres artefactos se producen juntos. Nunca se derivan retrospectivamente de un prompt o del MP4.

### Entrada source-authored
- `hook`: identidad canónica de la idea, incluida en el prompt.
- `story`: historia actual exacta; no se usa el canon anterior como argumento de la escena presente.
- `publicationHook`: dos palabras en mayúsculas para el título (puede diferir del hook de trabajo, sin modificar historia).
- `titleCore` o `title`: acontecimiento central redactado por el mismo creador, no leído de Flow después.
- `descriptionCore` o `description`: sinopsis redactada por el mismo creador.
- El sistema añade `#Shorts #ViralShorts #FruttiDrama` al título y descripción antes de guardar el paquete. No repite tags.

La función `buildFruttiSourceCopy` de `frutti-creative-package.js` acepta campos explícitos, falla ante ausencia, hook editorial inválido, sinopsis técnica, título con elipsis o metadatos excedidos, y NO recibe el prompt. El productor `runtime-config.materializeCreativePackage` construye el prompt para Google Flow desde la misma idea y guarda **prompt, título y descripción simultáneamente**.

### Archivo inmutable de paquetes
La SQLite del runtime mantiene `factory_creative_packages`, con una entrada nueva por paquete/revisión: `packageId`, `itemId`, temporada, episodio, hook, story, prompt **íntegro**, title, description, hashes, schema, fuente y fecha. Una transacción `BEGIN IMMEDIATE → INSERT ledger + UPDATE factory_items → COMMIT` evita paquetes incompletos. Triggers `no_update` y `no_delete` impiden sobrescribir o borrar el historial. El runtime serializa su SQLite (incluida la tabla inmutable) en el archivo privado `state.tgz` y lo sube a Supabase al cerrar cada ejecución; el respaldo solo se considera confirmado si la carga terminó con éxito. Hasta entonces no se afirma persistencia remota.

Review y YouTube nunca reescriben ni infieren copy a partir de video/prompt. Los tres puntos de consumo —Flow preflight, Review y publicación— exigen que `creativePackageId` y su hash correspondan a la entrada inmutable; ante falta de evidencia, bloquean generación/aprobación/publicación en vez de inventar. Los Review históricos sin ledger siguen visibles para la persona operadora, pero no se aprueban automáticamente.

Las correcciones por feedback creativo también deben contener `new_hook`, `new_story`, `new_publication_hook`, `new_title_core` y `new_description_core` en la **misma respuesta de creación/revisión**. Un simple retry de render conserva copy original; una revisión del prompt sin cambio narrativo conserva el paquete editorial y crea un nuevo ledger para el nuevo prompt.

### Planes disponibles ≠ episodios generados
En Supabase se conservaron 12 historias de T3: seis Review y seis ideas adicionales. Se añadieron campos editoriales de origen para que, **solo en futuras generaciones**, puedan construir paquete completo; su estado sigue siendo PLAN, no publicación ni evidencia de render. También existen ocho semillas genéricas futuras; **jamás** se reciclan para improvisar metadatos. Al retomarse la generación, el `frutti-autonomous-source.js` construye instrucciones para el **showrunner de origen** antes de enviar nada a Flow: una respuesta JSON única con `hook`, `story`, `publicationHook`, `titleCore`, `descriptionCore`, contrastada contra continuidad, rechazada si está incompleta o repetida. El `free-browser-provider.js` invoca al showrunner antes del generador de prompts y guarda esos cinco campos en `factory_items` de manera idempotente. Ante fallo de Gemini, credenciales o respuesta inválida, **no** se llama Generate. Jamás se hace esta llamada para recuperar videos históricos. Nunca activar generación por haber encontrado ideas o títulos.

## Protección y activación
FruttiDrama sigue con `historical_reconciliation_pending=true`. La última publicación confirmada es T2E8; la ficha temporal T2E9 sigue intacta. No levantar ese bloqueo ni conectar migraciones a publicación sin reconciliación humana de archivos, identidad de Flow, revisión/stock, IDs de YouTube y estado OAuth. TinyFish excluido; no usar créditos pagos, no re-generar videos antiguos, no subir privados antes del día programado ni duplicar IDs.

## Pruebas
- `scripts/test-frutti-manual-recovery.mjs`: corpus de validación de títulos/hashtags, rechazo de plantillas, recuperación T2 original, ausencia de T3 falsamente histórico, editor manual en DOM simulado, source package, SQLite con triggers y prueba integral transaccional, sin acceder a Flow/YouTube.
- `scripts/check-unified-factory-ui.mjs`: ambos HTML y módulos sincronizados, ausencia de botones de IA, solo dos opciones y módulos Safari con cache-busting.
- `scripts/check-publication-safety.mjs`: invariantes de publicación escalonada y límites de generate.
- `.github/workflows/frutti-metadata-fidelity.yml`: CI fuente de verdad para el contrato de recuperación manual y paquetes cohesivos.
- Dockerfile incluye el nuevo constructor editorial de origen y ejecuta selftests; un workflow verde solo prueba código, **NO** que la automatización haya generado o publicado realmente.

## Pruebas de seguridad adicionales
- La decisión creativa autónoma solo puede darse en `draft` o `regen_wait`, nunca si se conoce un MP4, un asset de Flow, `providerRunId`, un prompt guardado o cualquier fila de `factory_generations` para el mismo ítem. La misma identidad del episodio se reusa en los siguientes intentos, sin reescribir copy posterior a una generación.
- `packageMatches(db,row)` recibe la SQLite explícita, y `publication.js` incluye `id` del factory item en los SELECT de reconciliación; se evitan errores de alcance de DB e identidades de ledger ausentes.
- El flujo de generación y publicación permanece pausado por la conciliación histórica, sin autorización para resetearla automáticamente. Los títulos T3 fuente de planes no significan videos realmente generados ni publicados.
