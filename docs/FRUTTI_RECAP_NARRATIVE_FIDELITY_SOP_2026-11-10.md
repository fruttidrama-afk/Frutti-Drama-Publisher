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
