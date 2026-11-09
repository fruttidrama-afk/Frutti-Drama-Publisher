# Google Flow — investigación de verificaciones de seguridad y prevención de actividad innecesaria
Fecha de investigación: **2026-11-09**. Propietaria: Publisher Factory (FruttiDrama, EARTH IN 10, Dinnie). Este documento es un **anexo operativo** del SOP maestro, no una guía para eludir la seguridad de Google.

## Resumen ejecutivo

Google **no publica** una lista exhaustiva de factores, una puntuación, probabilidades ni límites numéricos que determinen la aparición de una verificación de identidad. La única meta legítima es reducir movimientos innecesarios, conservar correctamente una sesión real autorizada y responder a cualquier control de Google con verificación humana normal. **No resolver CAPTCHA, MFA, avisos de cuenta, límites ni restricciones de automatización por medios elusivos.** El acceso a la cuenta y la aceptación de Flow son decisiones de Google, no propiedades que podamos garantizar permanentemente.

### Matriz de factores (evidencia vs hipótesis)

| Factor | Confirmación pública / interpretación responsable | Implicación práctica |
| --- | --- | --- |
| Nuevo dispositivo, navegador o ubicación de inicio de sesión | Google documenta bloqueos y avisos cuando un dispositivo o lugar es desconocido. Confirmado. | Una nueva VM GitHub Actions con egress externo cambiante **puede** parecer un contexto de acceso nuevo, incluso si la persona dirige su pantalla remota desde el iPad. No afirmar que ocurrió así en una cuenta específica sin ver la actividad de seguridad. |
| Software que controla un navegador al iniciar sesión | La ayuda de Google indica explícitamente que algunos navegadores controlados por software automatizado o integrados pueden tener denegado el inicio de sesión. Confirmado. | El usuario hace login interactivo en Chrome estándar mediante noVNC; el programa no intenta efectuar el login, rellenar contraseñas ni responder a la verificación. No garantizar soporte de automatización. |
| Cookies borradas y estado de navegador perdido | Google recomienda conservar cookies y usar navegador compatible/actualizado para mantenerse conectado. Confirmado. | Archivar cookies, almacenamiento local e IndexedDB en una copia privada por publisher. No borrar cookies como medida de 'desbloqueo'. |
| Rotaciones de IP, VPN, proxy, navegadores nuevos y cambios de firma | Google confirma factores **ubicación/dispositivo** y la FAQ de Flow recomienda desactivar VPN/proxy ante 'Unusual Activity'. **No confirma una regla concreta de rotación de IP/fingerprint ni un umbral.** | No alternar proxies/VPN ni falsificar dispositivos. Las IP salientes de las VM efímeras gratuitas no son persistentes por garantía; la prueba de continuidad de perfil no equivale a persistencia de ubicación física o IP. |
| Generaciones demasiado seguidas | La FAQ de Flow confirma límites de velocidad, especialmente modelos de coste cero, y variación después de muchas generaciones. Confirmado. | Hacer 1 submit legítimo por intención, con fronteras durables, sin re-submit tras errores ambiguos ni recuperar días perdidos en lotes. El máximo 4 intentos/24h y separación mínima de 10 minutos es una **política nuestra**, no una regla publicada de Google. |
| 'Unusual activity' en Google Flow | Google Flow documenta este mensaje e indica esperar unos minutos / desactivar VPN o proxy. Confirmado. No equivale automáticamente a cuenta comprometida o necesidad de iniciar sesión otra vez. | Diferenciarlo de 'verificar que sos vos'. Bloquear nuevos envíos, preservar la identidad del video y la sesión y solicitar revisión legítima en lugar de un bucle de reintentos, borrado de caché o cambios de red. |
| Cambiar contraseñas, 2FA, métodos de recuperación y otras acciones sensibles | Google aplica verificaciones adicionales; ciertos métodos/dispositivos necesitan al menos 7 días vinculados para algunas acciones sensibles. Confirmado. | No modificar medidas de seguridad innecesariamente durante la migración; nunca desactivar MFA para facilitar automatizaciones. Mantener disponibles métodos de recuperación legítimos. |
| Eventos de acceso inusual/desconocido | Google emite alertas por nuevas sesiones y recomienda revisar actividad reciente. Confirmado. | Solo una persona autorizada revisa y valida estas alertas desde Google Account Security. No registrar tokens/códigos ni validarlos automáticamente. |

## Fuentes oficiales verificadas

- Google Account Help — servicio tercero bloqueado, dispositivo y lugar nuevos: https://support.google.com/accounts/answer/9279980?hl=es-419
- Google Account Help — navegadores admitidos; bloqueo de navegador automatizado: https://support.google.com/accounts/answer/7675428?hl=es-419
- Google Account Help — permanecer conectado/cookies: https://support.google.com/accounts/answer/54490?hl=es-419
- Google Account Help — verificación de acciones sensibles y antigüedad de 7 días en determinados supuestos: https://support.google.com/accounts/answer/7162782?hl=es
- Google Account Help — actividad sospechosa y eventos de cuenta: https://support.google.com/accounts/answer/140921?hl=es
- Google Flow Help — 'You're requesting generations too quickly', 'Unusual Activity', VPN/proxy y límites dinámicos: https://support.google.com/flow/answer/16353333?hl=es-419
- Playwright docs — almacenamiento de autenticación, cookies/LocalStorage/IndexedDB, naturaleza temporal de los snapshots: https://playwright.dev/docs/auth
- Condiciones de Google (antiabuso; no omitir medidas protectoras): https://policies.google.com/terms?hl=es-419
- API Gemini Omni Flash/Veo: https://ai.google.dev/gemini-api/docs/pricing?hl=es (la API oficial de video tiene precios/niveles distintos, **no** sustituye automáticamente los créditos gratuitos de Flow).

## Investigación del runtime REAL (antes de correcciones de 2026-11-09)

1. Google Flow está abierto mediante **Chrome alojado en runners temporales GitHub Actions**. El iPad solo muestra el escritorio remoto noVNC. Por lo tanto, Google no interpreta el iPad necesariamente como el dispositivo que aloja el navegador. Las IP públicas de cada VM y su identidad no tienen garantía de estabilidad.
2. Google Flow puede autenticar con estado portable de Playwright restaurado desde Supabase Storage privado. FruttiDrama pasó prueba real de *cold restore* en otra VM el 2026-11-09, sin nuevo login ni Generate; Earth/Dinnie todavía tenían `login_required` en esa prueba.
3. Los perfiles Chrome completos pueden superar el tope de tamaño (~40 MiB) de la carga de Bootstrap; fallback actual es `flow-auth-state.json` con `indexedDB:true`, guardado en el bucket privado. Frutti quedó validado mediante este fallback. No se copiarán cookies a archivos GitHub públicos.
4. Existía un **cold restore programado todos los días a las 11:23 UTC** además de la comprobación al iniciar cada generación. Esta visita diaria extra desde un runner nuevo no contribuye a generar ni publicar un video; elimina la necesidad del cron diario. Debe dispararse solo una vez después de una captura humana real o en una auditoría expresamente solicitada.
5. El worker validaba Flow antes de generar y podía volver a abrirlo en otra instancia **después de un proceso fallido**, incluso ante avisos de seguridad. Ese segundo acceso es innecesario y fue eliminado para fallas, timeouts, crédito no legible y hold; se conserva el refresh cuando efectivamente se logró una generación nueva.
6. `free-browser-provider.js` tenía un protocolo de **reintentos automáticos 30m→1h→2h→4h→8h→24h** tras 'Unusual Activity / not charged' y hasta reseteaba caches del perfil en ciertos escalones. No era una política de Google, sino un SOP antiguo. Se cambió a **hold global duradero ante el primer aviso**, sin nuevos Generate, sin reiniciar login, sin borrar cookies/cache, conservando ID y episodio. El error no se interpreta como permiso para seguir probando.
7. Los avisos de Google seguridad deben distinguirse de Flow sin créditos, errores de proyectos, respuesta antiabuso y caída de Chrome. Evitar etiquetas 'sin créditos' cuando el problema real sea de autenticación.

## Reglas instaladas (seguridad por defecto)

1. **Una cuenta = un perfil privado y un proyecto Flow exacto.** No compartir cookies entre shows. Mantener cookies, LocalStorage e IndexedDB y no sobrescribir una captura buena con un estado deslogueado.
2. **Login únicamente humano** en la ventana noVNC autorizada. Si Google solicita passkey, 2FA, correo, reCAPTCHA o reconoce un navegador no admitido, se detiene el runtime y se informa; no automatizar, suplantar, resolver CAPTCHA, modificar IP/proxy, ni intentar 'arreglar' seguridad haciendo múltiples logins.
3. **No más pruebas de login superfluas**: `.github/workflows/flow-auth-cold-restore.yml` corre manualmente o tras el éxito de `Bootstrap Flow * Account V2`, no todos los días. Un preflight read-only antes de cada sesión de generación es razonable para evitar créditos desperdiciados.
4. **Clasificador de seguridad separado**: `scripts/flow-security-signals.mjs` distingue `login_required`, `security_challenge` y `unusual_activity`. No almacena body, URL con parámetros, contraseñas, cookies ni capturas. Las dos últimas condiciones no se convierten en reintentos automáticos ni cambio de red.
5. **Fail closed en todos los niveles**: `scripts/free-runtime-runner-v2.mjs` bloquea una tarea después de un desafío; `free-browser-provider.js` bloquea el proveedor y el episodio sin crear una nueva frontera Generate; `publisher-flow-account-bootstrap-v2` guarda resultado específico de cold restore y bloquea migración si hay desafío real. La publicación de videos aprobados queda desacoplada del login Flow, aunque sus propias reglas de publicación también deben seguir siendo seguras.
6. **No confundir seguridad con quotas**: faltan credenciales, error del navegador, proyecto ajeno, crédito ilegible, límite de generación y actividad sospechosa son estados distintos. Un error no confirma que Google haya consumido cero créditos ni que un submit ambiguo pueda repetirse.
7. **No desactivar 2FA ni ampliar confianza en un runner efímero**: Google permite añadir dispositivos confiables al verificar 2FA cuando procede, pero no debe tratarse una VM de GitHub como dispositivo personal persistente. Preferir métodos de verificación y recuperación legítimos disponibles en el iPad.
8. **Cuenta exacta**: verificar identidad del proyecto y flujo antes de consumir créditos. Google puede pedir una nueva validación en el futuro aunque se guarde el estado correctamente; no hacer promesas de sesión o créditos ilimitados/indefinidos.

## Verificación y límites

- Los cambios sobre clasificación y no-reintentos se probaron con casos **sintéticos** en `scripts/check-google-security-guard.mjs`, sin sesiones de Google ni llamadas a Generate.
- El esquema visual de Factory, publicaciones y controles anti-spam se revisa con `Unified Publisher Factory UI Smoke Test`. El estado de GitHub Actions por sí mismo no confirma que Google haya aceptado cada acceso.
- No se intentó sortear restricciones de Google, ocultar automation flags, usar fingerprints falsos, rotar IPs, comprar servicios de proxies ni modificar propiedades de las cuentas.
- Persistir cookies puede reducir logins, pero **ni el navegador, la región, la IP de una VM efímera, ni el propio servicio gratis de Flow tienen permanencia garantizada**. Si Google exige human verification, el único procedimiento seguro es completarla con la cuenta legítima o pausar producción.
- Cuando se necesite una intervención humana, se mostrará **solo al final de la respuesta**, con enlaces directos y pasos que puedan ejecutarse íntegramente desde el iPad. Las preferencias del usuario de continuidad operativa son del diálogo además de estar anotadas en SOP.

### Diagrama de reacción autorizada

```text
Programación -> obligación válida -> preflight único sin Generate
                                      |
                +---------------------+------------------------+
                |                     |                        |
       autenticado/proyecto     login necesario         security challenge
              correcto                |               o Unusual Activity
                |                     |                        |
         1 acción autorizada     bloquear generación        HOLD GLOBAL
         (fence/ID durables)     preservar cookies          preservar video/ID
                |               avisar a operadora        sin reintentos automáticos
         Review humano               (iPad)               ni proxy ni cache reset
```

## Fecha y propiedad

Esta investigación contiene hechos citados y **evaluaciones de riesgo del diseño**, no ingeniería inversa de señales internas de Google. Los criterios exactos se desconocen y pueden variar sin aviso. Se preserva la seguridad y la autorización humana por encima de la continuidad forzada.
