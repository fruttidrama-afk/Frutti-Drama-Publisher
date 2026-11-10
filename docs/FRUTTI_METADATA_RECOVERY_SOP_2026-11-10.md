# FruttiDrama — SOP de metadatos y reconstrucción narrativa
**Fecha:** 2026-11-10. **Alcance:** estación de conciliación histórica de 31 MP4; solo propuestas y fichas manuales, sin publicaciones ni generación de Flow.

## 1. Qué hacía la automatización original
El motor en el repositorio histórico `FruttiDrama-Publisher/queue.js` exporta `metadataFromStory(hook,story,preferredCore)`. Las historias de `factory-flow.js` tenían `row.hook` y `row.story` **antes de generar el prompt**; el productor hacía `EPISODE\n<HOOK>: <STORY>`. Para episodios especiales, `T2_CANON` incluía sinopsis editoriales específicas. No necesitaba interpretar desde cero un prompt cinematográfico arbitrario. Éste es el contrato original que debe respetarse.

## 2. Error de migración
La estación de reconstrucción nueva recibe el prompt completo copiado de Google Flow, pero no tiene el `row.story` original vinculado de manera verificada al MP4. La función `publisher-frutti-recap` v17–21 había sido reconstruida mediante reglas de palabras/verbos y plantillas. Confundía canon con acción actual, testigos con protagonistas, intentos con hechos, y podía devolver `STORY_NOT_FOUND` ante prosa sin sección `EPISODE`. Las pruebas anteriores eran mayormente prompts con `TRAMA CENTRAL`, por lo que no medían esa falla.

## 3. Orden de autoridad y ejecución
1. **Story confirmado por operadora:** usarlo literalmente para formar la propuesta; preservar acciones, sujeto, objeto, negaciones y participantes.
2. **Story explícito en el prompt real:** primero `EPISODE\nHOOK: STORY`, luego `TRAMA CENTRAL DE ESTE EPISODIO`, `EPISODE INTENT` y rótulos equivalentes. Extraer solo el episodio actual, nunca biografía/canon.
3. **Prosa cinematográfica sin rótulos:** extraer acciones observables con evidencia textual, sin transformar coexistencia de personajes en romance ni acusación en hecho consumado. Se puede conservar una cita literal. Si algo es ambiguo se presenta como propuesta para cotejo, no como verdad canónica.
4. **Respaldo con reglas editoriales:** reutilizar solamente cuando no contradiga las acciones; para escenas no soportadas, no inventar tramas. No ejecutar Generate ni publicar como consecuencia de generar metadatos.

## 4. Guardado y trazabilidad
Mantener intactos `source_sha256`, `generation_prompt`, `file_index`, `season` y `episode` asignados por la persona operadora. Conservar por separado `episode_story_evidence` y `episode_story_extraction_method`, marcados como **no verificados**, para no perder la fuente de la propuesta. Las revisiones de texto no deben modificar MP4 ni su identidad. La asignación del video a episodio permanece manual; los archivos `docs/data/frutti-prompt-studio-*.json` sirven para pruebas, no para inferir correspondencias verdaderas.

## 5. Aceptación
- Ejecutar `node scripts/test-frutti-copy.mjs` de forma íntegra; cubrir los 50 prompts de archivo y 50 stories y ejemplos de prosa libre sin `STORY`.
- Probar el prompt real recuperado del stock T2E9 (sin copiarlo al repositorio público): reconocer a Uva y Limón conversando, Fresia entrando e insultando, y el silencio de ambos.
- Verificar que un informe médico leído por Don Melón no sea descrito como una acción médica realizada por otro personaje; que un intento de beso no sea un beso consumado; que un simple testigo no se convierta en interlocutor o motivo amoroso.
- Publicar el backend solo si estas verificaciones pasan; confirmar versión activa desde Supabase y que el código desplegado corresponde al probado.
- La comprobación final del prompt que falla en el iPad requiere una interacción real del propietario en el panel, ya que el texto no guardado en su navegador no es visible al backend ni a GitHub.

## 6. Guardas de producción
La conciliación histórica `historical_reconciliation_pending` de FruttiDrama **no se levanta** al corregir metadatos. Sin mapeo auténtico de MP4→temporada/episodio→prompt no se autoriza generación ni publicación. No usar TinyFish, no duplicar Generate ni gastar créditos pagos.
