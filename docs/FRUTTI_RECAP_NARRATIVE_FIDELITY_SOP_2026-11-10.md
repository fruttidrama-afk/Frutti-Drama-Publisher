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
- Fecha inicial de este contrato: **698 aserciones aprobadas localmente**; última Edge desplegada y confirmada **v20** (`publisher-frutti-recap`). Las pruebas no certifican la interpretación semántica de cualquier prompt futuro ni el video remoto final.

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
