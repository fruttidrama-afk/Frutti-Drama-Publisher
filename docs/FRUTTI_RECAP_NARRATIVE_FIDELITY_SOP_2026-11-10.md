# FruttiDrama — SOP de fidelidad narrativa en reconstrucción histórica
**Actualización:** 2026-11-10. **Aplica a:** estación temporal de reconstrucción de 31 MP4 de FruttiDrama, Edge `publisher-frutti-recap`, UI Factory. **Tipo:** control editorial + fuente verificable; NO sustituye aprobación humana.

## Incidente real y causa raíz
Una ficha de T2E9 (archivo con `file_index=0`, mapeo manual ya realizado) tenía un título erróneo, «INTERRUPCIÓN INCÓMODA: Fresia interrumpe a Uva», aun cuando el prompt íntegro de Google Flow describe a **Uva y Limón conversando juntos en el jardín**; Fresia entra, insulta a Uva y se retira, y ninguno de los otros dos habla. El parser anterior seleccionaba una frase de *character reference sheet* y aplicaba una plantilla de interrupción unipersonal, ignorando la relación entre los dos interlocutores y las líneas de diálogo.

El generador existente **NO era una IA semántica**: era un extractor local de expresiones regulares y plantillas. No presentarlo como un modelo que comprende cualquier relato; si falta evidencia, exigir revisión en vez de inventar.

## Jerarquía obligatoria de evidencia y procesamiento
1. **Identidad del archivo:** el operador selecciona el MP4 auténtico, asigna temporada/episodio y pega el prompt completo literalmente usado en Google Flow; nunca inferir el video a partir de `docs/data/frutti-prompt-studio-*.json` ni asociar automáticamente el archivo a un episodio.
2. **Trama explícita del episodio actual:** si hay `TRAMA CENTRAL DE ESTE EPISODIO`, `EPISODE INTENT` u otro encabezado actual inequívoco, extraer SOLO esa sección; NO mezclar `CONTINUIDAD`, `CANON`, `CREATIVE BIBLE`, `CAMERA`, referencias visuales, ejemplos ni historias anteriores. Preservar literalmente sujeto, verbo, objeto, negación, condición, incertidumbre y tiempo. Dos palabras MAYÚSCULAS de hook antes de dos puntos; máximo de 100 caracteres con hashtags si entran. Si es necesario abreviar, seleccionar una **cláusula autónoma fiel**, no truncar hasta crear una mentira.
3. **Narrativa introducida por el operador:** el campo opcional `operator_story` se convierte en `OPERATOR_VERIFIED_STORY`, NO en un libreto para plantillas que alteran hechos. Usarla **textualmente** en título/descr.; el hook editorial debe ser compatible con los verbos (p.ej. `acusa` NO implica `envenena`; `intenta besar` NO implica `besa`; `no interrumpe` NO equivale a `interrumpe`).
4. **Prosa sin encabezado:** analizar escenas y diálogo *en conjunto* sin desechar una línea completa porque contenga términos técnicos. En el caso verificado, Uva y Limón son ambos interlocutores, Fresia es quien entra y profiere la agresión verbal, y Uva/Limón no responden. El título debe referirse a **Uva y Limón**, no solo a Uva. Las frases citadas de Fresia («criada tan atrevida», «ni las sobras se te escapan») son evidencia textual, no instrucciones técnicas.
5. **Indeterminación:** si la sección central no es inequívoca y los roles/verbos no pueden confirmarse, devolver error y explicar qué falta. No usar canon antiguo para completar actores, intenciones, parentescos o desenlaces. Nunca afirmar un acto solo intentado, negado o alegado como consumado.
6. **Revisión editorial:** el resultado es borrador; la persona compara prompt **y video**, corrige si corresponde y guarda ficha. Guardar stock reconstruido NO implica aprobar, regenerar ni publicar. Los archivos originales, `source_sha256`, temporada y número asignados, y el prompt no deben sobrescribirse en reparaciones del redactor.

## Pruebas de regresión obligatorias
- `scripts/test-frutti-copy.mjs` usa 50 prompts históricos de Prompt Studio **solo como corpus de prueba**: 50/50 títulos/descripciones desde trama explícita y 50/50 desde resumen manual; los 100 textos deben contener literalmente toda la narración comprobada.
- Probar un prompt sin sección `STORY`, con directivas `@Limón Duarte`, `@Uva Reyes`, `@Fresia`, conversación de pareja, ingreso de Fresia y cita insultante; título incluye **a Uva y Limón**, y descripción preserva palabras insultantes y que ambos callan.
- Probar falsos positivos negativos: sospecha/acusación de veneno, intento de beso, «no interrumpe», descubrimiento sin interrupción, tercer personaje mero testigo sin motivo romántico inventado.
- Verificar formato YouTube, hashtags, longitud y que nunca aparezca copy técnico de Flow; no publicar como consecuencia de tests.
- Fecha inicial de este contrato: **698 aserciones aprobadas localmente**; primera Edge desplegada y confirmada **v20** (ahora v27, detallada abajo) (`publisher-frutti-recap`). Las pruebas no certifican la interpretación semántica de cualquier prompt futuro ni el video remoto final.

## Reparación confirmada 2026-11-10 — Edge v27
- Incidente nuevo: en un Flow prompt con `CONTINUITY\nPrevious canonical beat: SOSPECHA ABIERTA` y `STORY / ACTION\nHOOK: PRUEBA TÓXICA\nSTORY: Don Melón recibe una prueba médica...`, el extractor anterior podía usar palabras del beat previo o transformar «envenenamiento» en «Banana envenena a Don Melón».
- Corrección de precedencia: la rama `authoritativeCurrentStory` procesa exclusivamente `HOOK` y `STORY` de `STORY / ACTION`/episodio actual; excluye historial/canon y bloques de producción. El texto de `STORY` completo pasa literalmente a la descripción. En títulos se elige un fragmento verbal literal que quepa en 100 caracteres, nunca una nueva relación entre actores.
- Corrección del segundo fallo: `operatorStoryCopy` emplea `literalCurrentCopy`, NO la antigua heurística `explicitEpisodeCopy`. Una narrativa pegada por la operadora no autoriza conversiones de acusación a hecho, intento a consumación o negación a afirmación. Se añadió clasificación editorial de `PRUEBA TÓXICA` al caso de prueba médica + envenenamiento.
- Regresión permanente en `scripts/test-frutti-copy.mjs`: 50 prompts de prueba + 50 narratives de prueba; también casos de canon, prueba médica, conversación romántica de tres interlocutores, acusación, intento de beso y negación. GitHub Actions `FruttiDrama Metadata Fidelity` ejecuta la suite en cada cambio y fue verificado exitoso con commit `9a5c8e674d6db4f731467775e057172bc0545b1e` (run 42742208906).
- GitHub `supabase/functions/publisher-frutti-recap/frutti-recap-copy.js` desplegado en Supabase Edge `publisher-frutti-recap` v27, estado ACTIVE. Los dos clientes UI distinguen «narrativa extraída del prompt» de «narrativa aportada por vos».
- La validación real final requiere pegar/probar el prompt íntegro desde el iPad, verificar contra MP4 auténtico y guardar solo tras revisión. **No** se aprobó stock, levantó `historical_reconciliation_pending`, generó un video ni publicó por esta reparación. Caso T2E9 ya guardado no se sobrescribe.

## Estado operativo y límites
- La ficha real T2E9 ya guardada conserva un título/descripcion anteriores; NO reescribirla silenciosamente. La persona debe abrirla, volver a generar la propuesta desde su prompt completo y verificar antes de guardar una revisión nueva.
- Último episodio realmente publicado confirmado por la operadora: **T2E8**. Los 31 videos históricos requieren asignación manual verificable; la existencia de un borrador o una ficha reconstruida NO prueba publicación, canon ni aprobación.
- `config.automation.historical_reconciliation_pending=true` en FruttiDrama es un bloqueo intencional. No levantarlo ni reanudar Generate/Publicación hasta conciliar video↔episodio↔prompt y Stock con aprobación; mantener los gates de créditos gratis, idempotencia, seguridad Google y publicación 12:30 PRIVATE → 19:00 PUBLIC del mismo día.
- Para EARTH IN 10/Dinnie no interpretar `migration_state=ready` como prueba de créditos, modelo/costo, publicación OAuth o ciclo end-to-end. Conservar la política Free Browser Provider exclusivamente, sin TinyFish.

## Archivos del contrato
- Generador: `supabase/functions/publisher-frutti-recap/frutti-recap-copy.js`
- Endpoint owner-scoped: `supabase/functions/publisher-frutti-recap/index.ts`
- UIs equivalentes: `docs/frutti-recap.js`, `factory-web/public/frutti-recap.js`
- Tests: `scripts/test-frutti-copy.mjs`
- SOP madre: `docs/SOP_MASTER_PUBLISHER_FACTORY.md`

**Principio:** fidelidad factual > titular más llamativo > tasa bruta de generación. Mantener resultado comprobable y jamás inventar una acción o un interlocutor.


## Incidente de extracción repetida — reparación v28 (10 de noviembre de 2026)
La v27 seguía fallando en prompts que, después de copiarse desde el editor, quedaban en una sola línea o con encabezados pegados:
`CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — [episodio anterior] STORY / ACTION HOOK: PRUEBA TÓXICA STORY: Don Melón recibe una prueba médica… CAMERA: …`.

**Causa técnica comprobada:** la función v27 buscaba `STORY / ACTION` como una línea aislada. Con encabezados colapsados no entraba en esa rama. El extractor de respaldo escaneaba verbos del texto completo, incluyendo `CONTINUITY`, y llegaba a inventar «Banana envenena a Don Melón» o un enfrentamiento de Fresia y Mango. Los tests anteriores solo cubrían encabezados separados en líneas y no eran suficientes.

**Corrección aplicada y desplegada:** `extractCollapsedCurrentStory` v28 detecta `STORY / ACTION` como delimitador en cualquier posición, incluso si todo el prompt está en una línea; busca `HOOK:` y `STORY:` posteriores, corta antes de `CAMERA:` y otros encabezados técnicos y construye el copy únicamente del episodio actual. Si hay `Previous canonical beat` pero no puede extraerse una historia actual verificable, devuelve error y **nunca** inventa metadatos. Los hooks canónicos de tres palabras `ORDEN DE SALIDA` y `FURIA DEL PATRÓN` pasan a las dos palabras editoriales `SALIDA FORZADA` y `FURIA PATRONAL`, sin modificar el relato.

**Evidencia de pruebas:** antes de desplegar v28 se aprobaron **20 episodios canónicos diferentes × 5 formatos = 100 pruebas de precedencia**, además de 100 casos del corpus anterior (50 prompts, 50 historias), cuatro casos de bloqueo y el único prompt histórico auténtico vinculado de manera verificada a un MP4 (T2E9). Los 20 provienen del archivo de planificación usado **exclusivamente como banco de pruebas**: no se los denomina «20 prompts reales verificados». El test quedó permanente en `scripts/test-frutti-copy.mjs` como `CANONICAL-COLLAPSED-20`; GitHub Actions `FruttiDrama Metadata Fidelity` y el control unificado aprobaron la nueva suite. Backend activo `publisher-frutti-recap` v28, GitHub commit `3d1323ac7b5364c30758c9388781588a2ecb704f`.

**Segundo defecto de visibilidad:** `docs/index.html` y `factory-web/public/index.html` todavía importaban `frutti-recap.js?v=20261110-source-grounded-v20`. Safari podía reutilizar el módulo antiguo y mostrar el mensaje de éxito de v20 aunque el backend hubiera cambiado. Se actualizó el import a `?v=20261110-story-action-v28` en ambas interfaces y hay que abrir el panel con URL nueva para invalidar también la caché HTML del navegador.

**Seguridad:** no se alteró ningún MP4, ficha histórica, título guardado, asignación, videoId, stock aprobado, cola YouTube ni créditos Google Flow. Sigue vigente el bloqueo `historical_reconciliation_pending` hasta que la operadora identifique los 30 videos todavía pendientes. La validación humana del mismo prompt que estaba sin guardar en el iPad sigue siendo indispensable; la prueba local no debe presentarse como comprobación de ese texto exacto.

## Reparación v30 — separación de STORY de instrucciones (2026-11-10)

**Incidente reproducido:** el panel mostraba v28 y devolvió `CURRENT_STORY_TOO_LONG` al procesar un prompt que tenía una historia breve y muchas instrucciones técnicas. El extractor v28 encontraba `STORY / ACTION`, pero incorporaba secciones de producción posteriores a `STORY` y por eso superaba los 1800 caracteres.

**Solución:** `extractCollapsedCurrentStory` v30 conserva la disposición y los saltos de línea originales hasta detectar el siguiente encabezado. Soporta bloques NARRATIVE NOVELTY LOCK, EXACT 10-SECOND / 2–3 BEAT RHYTHM, DIALOGUE, STRICT ANTI-GLITCH, CHARACTER REFERENCE LOCK, SHOT-BY-SHOT TIMING, OUTPUT CONSTRAINTS, SOUND DESIGN, TECHNICAL INSTRUCTIONS, encabezados Markdown y párrafos colapsados. Solo después normaliza el STORY actual. Ante una historia genuinamente ambigua y extensa devuelve `CURRENT_STORY_BOUNDARY_AMBIGUOUS`, sin usar `Previous canonical beat`.

**Pruebas anteriores al despliegue:** 20 episodios canónicos distintos × 6 variantes de formato con varios miles de caracteres técnicos añadidos = **120/120 aprobadas**. La implementación anterior fallaba 80/120 de las mismas pruebas. Además se verificaron los 100 casos históricos del corpus de tests y la ficha auténtica T2E9. La prueba contextual específica reprodujo `PRUEBA TÓXICA: Don Melón recibe una prueba médica`, preservó la comprensión de Uva del envenenamiento de Banana y excluyó Fresia/Mango.

**Regresión permanente:** `scripts/test-frutti-copy.mjs` contiene `LONG-FLOW-20-BLOCKS`; GitHub Actions `FruttiDrama Metadata Fidelity` y `Unified Publisher Factory UI Smoke Test` aprobaron tras aplicar el cambio. Backend commit `510a51d1570b68d00fded4b6497f2b9a4c29fee2`, Supabase Edge actualmente v31 con `engine_revision=story_action_v30`. UI y caché de ambos paneles cambiadas a v30.

**Veracidad:** los 20 son prompts con estructura canónica del corpus de pruebas, **no** 20 correspondencias autenticadas MP4↔prompt. Solo la ficha T2E9 es una asociación auténtica guardada. El prompt específico que seguía sin guardar en el iPad no fue inspeccionado directamente; requiere comprobación humana final en la UI.

**Guardas:** no tocar Generate, publicación, aprobación, stock, créditos, fichas, MP4 ni hash; `historical_reconciliation_pending=true` permanece.

## Incidente persistente del iPad y reparación estructural v33 (10 de noviembre de 2026)

**Evidencia:** la captura nueva de las 00:28 mostró `CURRENT_STORY_BOUNDARY_AMBIGUOUS` después del despliegue v30; simultáneamente, el panel de Safari seguía mostrando el módulo v28, y una pestaña nueva abrió el formulario de ingreso sin la sesión existente. El backend y el módulo del navegador pueden tener revisiones diferentes; el usuario puede estar viendo mensajes de ambas versiones.

**Causa:** el extractor v30 solo reconocía un conjunto finito de encabezados técnicos. Aunque ya descartaba `Previous canonical beat`, no separaba algunas secciones de producción que seguían al `STORY` cuando sus rótulos eran genéricos, por ejemplo `Camera choreography and acting:`, `Action choreography:`, `EDITORIAL EXECUTION PLAN:`, ni cuando la siguiente línea no tenía un encabezado explícito. Algunas líneas de guion estaban partidas en dos renglones. Esto hacía que el parser excediera 1800 caracteres y rechazara el prompt.

**Reparación:** v32 añadió detección de encabezados desconocidos, separadores de párrafos y extracción limitada de la primera línea narrativa completa cuando no existen delimitadores. v33 amplió la detección de rótulos en formato Title Case en la misma línea y permite conservar narrativas válidas que continúan en la línea siguiente. Esta extracción nunca recurre a la continuidad anterior y tampoco acepta instrucciones técnicas solas como hechos del episodio.

**Pruebas verificadas ANTES de cada despliegue:** sobre 20 historias canónicas independientes, 120 variantes (6 por historia) de encabezados desconocidos, instrucciones largas, texto colapsado, guion multilinea, párrafos y separadores. v31 fallaba 100 de las primeras 120; v33 aprobó 120/120 de las nuevas variantes y los 100 casos de regresión originales. Se comprobó además el auténtico prompt vinculado a T2E9 y el caso `PRUEBA TÓXICA` con Don Melón, la prueba médica y la reacción de Uva, sin introducir a Fresia/Mango como actores del episodio. Los 20 prompts de prueba NO son 20 MP4 vinculados verificados.

**Persistencia y distribución:** `scripts/test-frutti-copy.mjs` ahora contiene `UNKNOWN-HEADING-CANONICAL-20`, además de `LONG-FLOW-20-BLOCKS` y `CANONICAL-COLLAPSED-20`, con CI en GitHub. Backend `publisher-frutti-recap` activo en Supabase Edge v34, indicador de motor `story_action_v33`. Ambos módulos UI y los imports HTML se actualizaron a v33 para invalidar el recurso JS cacheado en Safari. Las pruebas automatizadas de UI y editor han pasado.

**Intervención pendiente:** el texto exacto del prompt sin guardar solo existe en el Safari del usuario, no en la base de datos. Para validar la reparación, copiar el prompt, refrescar la **misma pestaña autenticada** (no abrir obligatoriamente una pestaña nueva que muestre Login), volver a pegarlo y comprobar que el indicador sea `Extractor de episodio actual v33`; revisar título y descripción contra el video y guardar solo si es correcto. Si persiste el fallo, solicitar el prompt completo para reproducirlo sin volver a adivinar etiquetas.

**Seguridad:** sin tocar hashes de video, títulos guardados, stock aprobado, MP4, créditos de Flow ni publicaciones; `historical_reconciliation_pending=true` permanece.


## Error de rotulado v28/v33 — causa raíz y reparación (2026-11-10)

**Hallazgo decisivo:** cuando la operadora indicó que el recuadro aún mostraba `v28`, el código fuente publicado de `docs/frutti-recap.js` y `factory-web/public/frutti-recap.js` contenía exactamente la expresión `aiStatus.engine_revision==="story_action_v33" ? "Extractor de episodio actual v28" : "versión no confirmada"`. Es decir: el cliente RECIBÍA y RECONOCÍA la revisión v33 pero imprimía literalmente «v28». No era evidencia de que el backend ni necesariamente Safari siguieran ejecutando v28. Las respuestas anteriores atribuyendo ese rótulo a la caché eran incorrectas.

**Corrección:** módulo UI con `FRUTTI_EXPECTED_ENGINE_REVISION="story_action_v33"` y export `fruttiEngineLabel(serverRevision)` que deriva el texto visible del valor real de la revisión; `story_action_v33` muestra `Extractor de episodio actual v33`, una versión obsoleta muestra `versión no confirmada`. El mismo literal de revisión controla la validación de propuestas en POST. Se modificaron ambas copias idénticas de `frutti-recap.js`. HTML en ambos frontends importa `frutti-recap.js?v=20261110-v33-engine-label-corrected`, invalidando el recurso cacheado en la misma pestaña al actualizarla.

**Protección permanente:** `scripts/check-unified-factory-ui.mjs` importa el módulo visible, compara su `FRUTTI_EXPECTED_ENGINE_REVISION` con las dos declaraciones de `engine_revision` del endpoint de Supabase, invoca `fruttiEngineLabel` y falla si imprime v28 o si permite versiones viejas. GitHub Actions `Unified Publisher Factory UI Smoke Test` aprobó con commit `abf5b1d122e70d185a1cb7ca5ed1e01602462a7c`. Además se repitieron 20 pruebas con prompts de estructura canónica y anexos técnicos largos, todas aprobadas. No son 20 asociaciones de MP4 verificadas.

**Intervención humana final:** para ver la etiqueta corregida, actualizar **la pestaña ya autenticada** del panel en el iPad. No abrir otra ventana que exija iniciar sesión. Si persiste un error de generación o delimitación, pedir el prompt íntegro; no reinterpretar una etiqueta errónea como falla del parser.

**No alterado:** hashes/MP4, ficha reconstruida T2E9, aprobación, stock, Flow, créditos, YouTube; sigue activo el bloqueo `historical_reconciliation_pending=true`.


## Incidente v33 — CURRENT_STORY_BOUNDARY_AMBIGUOUS y reparación v34 (10 nov 2026)

**Evidencia del operador:** el iPad confirmó que el frontend sí indicaba \`Extractor de episodio actual v33\`, pero al pulsar \`GENERAR PROPUESTA DESDE PROMPT\` devolvió \`CURRENT_STORY_BOUNDARY_AMBIGUOUS\`. Este error NO era un problema de rótulo ni prueba de caché antigua: provenía del delimitador real de \`STORY\` cuando el prompt pegado unía la última frase narrativa con especificaciones técnicas posteriores sin un encabezado reconocible.

**Reproducción antes del cambio:** veinte relatos canónicos de Prompt Studio, usados exclusivamente como fixtures y NO como mapas de MP4, en seis layouts adversariales; **40/120 rechazados**. Fallaban particularmente instrucciones en línea iniciadas por \`The characters are…\` y \`The performance should preserve…\`, porque el corte anterior dependía de encabezados o de saltos físicos de línea.

**Cambio implementado:** el parser \`extractCollapsedCurrentStory\` incorpora una barrera adicional de oraciones técnicas sin título. Solo corta después de una oración narrativa terminada y ante evidencias explícitas de instrucciones de producción; no corta por ver la palabra \`characters\` ni por mencionar personajes. El algoritmo sigue fallando de forma conservadora si no se demuestra el límite, sin inferir jamás el argumento a partir de \`CONTINUITY / Previous canonical beat\`, ni generar hechos consumados desde una acusación, negación o intento.

**Pruebas:** se agregaron diez layouts diferentes para veinte historias con instrucciones técnicas largas en inglés/español, incluyendo todo en una línea, títulos desconocidos, encabezados estándar, y diversas formulaciones de bloqueo visual: **200/200** en esta nueva matriz; más prueba negativa de STORY técnico sin relato y relato de varias oraciones. Ejecutando el script completo \`scripts/test-frutti-copy.mjs\` del repositorio actualizado en un entorno JavaScript de verificación se completaron **4.683 aserciones exitosas** (sin acceder a los MP4 reales ni probar un POST autenticado desde Safari). El suite anterior conserva pruebas de 50 prompts históricos de fixture, anteriores interrupciones románticas, 20×5 layouts colapsados y 20×6 casos largos de producción.

**Publicación técnica:** versión de extractor declarada \`story_action_v34\` en cliente y endpoint, ambas copias de \`frutti-recap.js\` y HTML actualizadas con versión de caché \`20261110-v34-story-boundary\`; prueba de UI sincronizada. Función \`publisher-frutti-recap\` desplegada ACTIVE en Supabase Edge **versión 35**; \`verify_jwt=false\` preservado porque el endpoint sigue verificando internamente el JWT del propietario, sin relajación de autorización. No se modifican identidad de MP4, fichas, stock, automatización, aprobación, Flow, YouTube ni \`historical_reconciliation_pending\`.

**Límite pendiente:** no se posee el texto íntegro del prompt todavía no guardado en la sesión Safari del operador. No se puede afirmar que v34 pase ese prompt exacto sin ejecutarlo. Al regresar a la pestaña ya autenticada, preservar el texto sin guardar, actualizar, confirmar rótulo \`v34\`, y probar de nuevo con el mismo prompt. Si sigue fallando, capturar el texto auténtico íntegro y agregarlo como una nueva regresión; nunca inventar resultados ni reclamar 20 emparejamientos reales.

## Recuperación editorial por identidad de episodio — sin regeneración (2026-11-10)

**Nueva prioridad:** identificar el episodio debe consultar primero los metadatos históricos; nunca exigir regeneración de título y descripción cuando existe fuente histórica. El extractor es opcional y de último recurso.

**Hallazgo en el runtime original:** `fruttidrama-afk/FruttiDrama-Publisher/factory-flow.js` almacena season, episode, title y description en factory_items antes de pedir a Google Flow que genere. La SQLite histórica original no se recuperó de Railway en esta tarea: no inferir que sus filas estén en la proyección migrada.

**Fuente recuperada:** `fruttidrama-afk/FruttiDrama-Publisher/queue.js` contiene T2_CANON con 12 episodios T2E2–T2E13. Se ejecutó su lógica original canonicalStockMetadata/canonicalFruttiTitle y se archivaron íntegros los pares en `supabase/functions/publisher-frutti-recap/legacy-metadata.js`. Son metadatos canónicos del código original, NO prueba de títulos finalmente publicados o editados en YouTube. T2E9: CRIADA ATREVIDA: Fresia humilla a Uva frente a Limón #Shorts #ViralShorts #FruttiDrama.

**Sin evidencia:** para T2E1, T2E14+ y T3 no se recuperaron en este archivo pares históricos exactos. No extrapolar los 125 planes de Prompt Studio a videos reales. Los títulos finales publicados podrían recuperarse de YouTube por identidad de video verificada; otros datos podrían seguir únicamente en la SQLite histórica Railway.

**UI/API:** tras bearer JWT+owner, GET publisher-frutti-recap devuelve historical_metadata y historical_metadata_source. Ambas interfaces auto-rellenan título/descr. SOLO cuando los campos están vacíos al elegir temporada/episodio con fuente; exponen botón RECUPERAR TÍTULO Y DESCRIPCIÓN HISTÓRICOS para restauración explícita, sin llamar al extractor. Nunca sobrescribir silenciosamente valores manuales o fichas guardadas. Avisar que el archivo es canónico, no prueba de última edición en YouTube. Para episodios no recuperados, dejar campos vacíos y permitir edición manual o extracción opcional. El prompt verdadero, MP4 y SHA-256 siguen siendo obligatorios para vincular el stock histórico.

**Excepciones estrictas:** T2E12 mantiene literalmente el título de tres palabras MUERTE DE BANANA:; T2E2 mantiene el carácter … del título canónico original. El servidor solo acepta esas excepciones si título Y descripción coinciden exactamente con el par de ese episodio en el archivo de legado. No relajar validación de títulos nuevos. Guardar sin modificar da metadata_method=legacy_canonical_operator_reviewed; si se edita, operator_reviewed.

**Pruebas y despliegue:** 4.776 aserciones de la suite completa aprobadas en ejecución JS aislada y 16 verificaciones de interfaz simulada; 12/12 metadatos recuperados sin POST, sin inventar T3, sin sobrescribir edición manual. Código Edge v37 ACTIVE igual al GitHub; ambos clientes idénticos, cache HTML 20261110-legacy-metadata-recovery. Validación final con iPad autenticado y títulos YouTube editados aún no efectuada.

**Integridad:** sigue 1 ficha real reconstruida (T2E9 revisión 2); no sobrescribir su copy editorial con el archivo canónico hasta que el operador lo elija. Sin cambios a MP4, generación, aprobación, YouTube, créditos ni historical_reconciliation_pending.
