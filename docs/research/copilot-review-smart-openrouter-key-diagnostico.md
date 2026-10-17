# Diagnóstico `no OPENROUTER_API_KEY` en `copilot-review-smart`: verificación contra fuentes primarias

> Nota posterior: `CONTEXT.md` se renombró a `GLOSSARY.md` al redactar el spec.
> Las citas a `CONTEXT.md` en este informe apuntan al mismo contenido.

Fecha: 2026-10-10. Rama: `kepler/research-cuando-se-ejecuta` (worktree `skillbook-research-cuando-se-ejecuta-8f5ba174`).
Convención de guardado: `docs/research/` creada por la investigación anterior; esta nota sigue esa convención junto a `docs/research/copilot-review-smart-watchdog-ubicacion.md`.
Cada afirmación cita ruta + línea o salida de comando verificada en este ambiente. Idioma: español neutro.

## 1. Veredicto

**Diagnóstico válido en lo esencial, con correcciones menores de líneas y un matiz sobre la guardia de trabajo activo.**

- Sí existe la caída a `wait` por falta de clave, sí escala a `llm_failed` → `needs-human` al tercer fallo por head sha, sí quema un intento por tick válido, y sí la causa es que el watchdog resuelve su LLM por su cuenta sin acceso a las credenciales del agente que lo invoca.
- Correcciones: los números de línea citados en el diagnóstico tienen deriva de ±5 líneas (tabla en §3); el punto de inyección no es `decision.mjs:158` sino el parámetro `llmDecider` (`decision.mjs:177`, invocado en `decision.mjs:195`, con default `callLlm` en `pr_monitor.mjs:883`).
- Matiz nuevo: la guardia de trabajo activo (< 3 h) **no protege** la ruta de fallo LLM — el contador de fallos se incrementa aunque la rama tenga commits de hace minutos (§4).
- Fix propuesto: **parcialmente viable**. La frontera inyectable ya existe y está testeada, pero **no existe hoy ningún mecanismo de delegación a sesión Kepler en el repo** (búsqueda sin resultados en §6), así que esa parte requiere código nuevo; además choca con ADR-0002 (portabilidad) y con el hecho de que el cron productivo corre con `no_agent: true`, donde no hay sesión agente a la cual delegar (§7).

## 2. Síntoma verificado

El estado real en disco ya contiene el fallo descrito (leído con `cat /config/.cache/pr-monitor/state.json` el 2026-10-10):

```json
{
  "dyegolara/dashboard#12": {
    "llm_failures_sha": "cfb4d6d2b3b6a6926e97d6bbb201db5172e03291",
    "llm_failures": 1,
    "_reason": "Could not decide with LLM (no OPENROUTER_API_KEY); retrying (1/3).",
    "last_head_sha": "cfb4d6d2b3b6a6926e97d6bbb201db5172e03291"
  },
  "seen_ready_shas": []
}
```

El PR estaba efectivamente en estado válido para decidir (verificado con `gh api repos/dyegolara/dashboard/pulls/12`, 2026-10-10):

```json
{"draft":false,"head_sha":"cfb4d6d2b3b6a6926e97d6bbb201db5172e03291","mergeable":true,"mergeable_state":"clean","state":"open","title":"Home: live Unraid memory + dojo-mojo-casa-house hardware metrics"}
```

Abierto, no draft, título sin marca WIP, `mergeable: true` / `mergeable_state: "clean"`. Las tres puertas deterministas previas al LLM (draft/WIP en `decision.mjs:56-61`, conflictos en `decision.mjs:61-117`, mergeabilidad desconocida en `decision.mjs:118-120`) dejan pasar este PR, así que la decisión cae al LLM tal como afirma el diagnóstico. El contrato "puertas deterministas primero, LLM último" está documentado en `skills/engineering/copilot-review-smart/SKILL.md:185-194`, en el diagrama de `skills/engineering/copilot-review-smart/README.md:63-91` y en `skills/engineering/copilot-review-smart/resources/docs/adr/0003-llm-decision-maker-behind-deterministic-gates.md:1-15`.

## 3. Causa raíz verificada línea por línea

| Afirmación del diagnóstico | Verificación |
|---|---|
| `pr_monitor.mjs:550-551` — `loadEnvKey("OPENROUTER_API_KEY")`; sin clave lanza `LLMDecisionError("no OPENROUTER_API_KEY")` | **Correcto con deriva de líneas.** La clase está en `pr_monitor.mjs:551` (`class LLMDecisionError extends Error {}`), la lectura en `pr_monitor.mjs:554` (`const apiKey = loadEnvKey("OPENROUTER_API_KEY");`) y el lanzamiento en `pr_monitor.mjs:555` (`if (!apiKey) throw new LLMDecisionError("no OPENROUTER_API_KEY");`), dentro de `callLlm` (`pr_monitor.mjs:553-619`). |
| `pr_monitor.mjs:189-192` — la clave solo se busca en entorno, `~/.pr-monitor.env` y `~/.hermes/.env` | **Correcto con deriva de líneas.** `loadEnvKey` vive en `pr_monitor.mjs:192-207`; el comentario de orden de búsqueda en `pr_monitor.mjs:192-193` ("process env, `~/.pr-monitor.env`, `~/.hermes/.env` (legacy deployed cron)") y el bucle sobre esos dos archivos en `pr_monitor.mjs:196-205`. Las mismas tres fuentes se documentan en `SKILL.md:60-62`, `SKILL.md:292-295` y `resources/deploy/README.md:18`. |
| Las credenciales del agente orquestador nunca se exportan al shell donde corre `node` | **Confirmado por observación del ambiente.** `env \| grep -iE 'OPENROUTER\|PR_MONITOR\|DRY_RUN'` devuelve vacío en esta sesión; `ls ~/.pr-monitor.env ~/.hermes/.env` confirma que ninguno de los dos archivos existe; `/config/.cache/pr-monitor/` solo contiene `state.json`. No hay ningún código en el skill que lea credenciales del agente: el hijo tick hereda el entorno del padre (`listener/src/tick-runner.mjs:85`, `const childEnv = { ...env, ... }`), así que la clave fluye del Listener al tick **solo si alguien la puso en el entorno** — y nadie lo hace. |
| `decision.mjs:158` como frontera `llmDecider` inyectada | **Deriva de línea: el parámetro real es `decision.mjs:177`.** `decideWithLlm` recibe `llmDecider` en `decision.mjs:168-178` (línea 177), lo invoca en `decision.mjs:195` (`decision = await llmDecider(llmContext);`), y `runMonitorOnce` lo expone con default `callLlm` en `pr_monitor.mjs:876-887` (línea 883: `llmDecider = callLlm`) y lo pasa en `pr_monitor.mjs:1054-1064` (línea 1063). La línea `decision.mjs:158` real es parte de `normalizeLlmDecision`, no del punto de inyección. |
| Reintentos 1/3 → `llm_failed` → `needs-human` | **Exacto.** `decision.mjs:196-217`: si `failures < 3` (`LLM_MAX_FAILURES_PER_HEAD = 3`, `decision.mjs:4`), borra la firma cacheada (`decision.mjs:204-205`, lo que fuerza reintentar el LLM en el próximo tick en vez de reusar caché), devuelve `wait` con `retrying (N/3)`; si no, `decision.mjs:219-239`: fija `_action = "llm_failed"`, notifica `needs-human` una sola vez por sha (`decision.mjs:223-231`, guardia `llm_fail_notified_sha`). `pr_monitor.mjs:647` clasifica `llm_failed` como terminal `needs-human`. Los tests lo cubren: `pr_monitor.test.mjs:58-132` (tres ticks con stub que falla: sin notificación, sin notificación, una notificación + `could not decide with LLM after 3 attempts`), `pr_monitor.test.mjs:1225-1250` (`llm_failed` + `next_check_at` +1 h + notificación `needs-human`) y `pr_monitor.test.mjs:1252-1269` (fallo transitorio = `wait` +1 h sin notificación). |

Demostración directa de la escalada (sin red, stub que lanza `no OPENROUTER_API_KEY`, ejecutado el 2026-10-10 con `node --input-type=module`):

```json
{"tick":1,"action":"wait","reason":"Could not decide with LLM (no OPENROUTER_API_KEY); retrying (1/3).","notifs":[]}
{"tick":2,"action":"wait","reason":"Could not decide with LLM (no OPENROUTER_API_KEY); retrying (2/3).","notifs":[]}
{"tick":3,"action":"llm_failed","reason":"Could not decide with LLM after 3 attempts on this head (no OPENROUTER_API_KEY)","notifs":["needs-human"]}
{"tick":4,"action":"llm_failed","reason":"Could not decide with LLM after 4 attempts on this head (no OPENROUTER_API_KEY)","notifs":[]}
```

El cuarto tick confirma la guardia anti-spam: no duplica la notificación en el mismo sha (`decision.mjs:223`).

## 4. Contrato afectado y matiz sobre la guardia de trabajo activo

- **"LLM último, detrás de puertas deterministas"**: se cumple el orden, pero sin clave el último paso falla siempre. Cada tick con firma cambiada quema un intento: el fallo borra `_sig`/`_action` (`decision.mjs:204-205`), así que la caché de firma (documentada en `SKILL.md:266-269`, implementada en `decision.mjs:121-124` y `pr_monitor.mjs:1039-1053`) no evita el siguiente intento. La economía de tokens vía caché solo cubre el caso con LLM funcional.
- **Matiz verificado (no estaba en el diagnóstico): la guardia de trabajo activo no cubre el fallo LLM.** Al momento del repro el último commit del PR era de `2026-10-10T15:29:04Z`, solo ~36 min antes del tick (16:05 UTC), es decir dentro de la ventana `ACTIVE_WORK_QUIET_HOURS = 3` (`pr_monitor.mjs:64`). Aun así el tick quemó un intento de fallo. La razón: la supresión por trabajo activo se aplica **después** de decidir y solo a las ramas `request_rebase` (`pr_monitor.mjs:1148-1155`) y `request_fix`/`request_review` (`pr_monitor.mjs:1244-1248`); un `wait` por fallo LLM pasa intacto por `pr_monitor.mjs:1265-1268`. Dentro del LLM la preferencia por WAIT ante trabajo activo solo vive como hint del prompt (`pr_monitor.mjs:1032-1036`, flag `agent_still_working`), y sin LLM ese hint nunca se evalúa. La investigación anterior (`docs/research/copilot-review-smart-watchdog-ubicacion.md:71`) atribuyó el `wait` a "falta de clave más la guardia de trabajo activo"; lo verificado aquí es que la guardia no intervino en la razón reportada — el `reason` es puramente el fallo LLM.
- **`next_check_at`**: el fallo transitorio arma +1 h (`pr_monitor.mjs:705-712`) y el `llm_failed` terminal también +1 h (`pr_monitor.mjs:704`); el repro en seco lo confirma (`next_check_at: 2026-10-10T17:05:46.166Z` para un tick a las 16:05 UTC). La tabla del contrato está en `SKILL.md:218-219` (fallo recurrente → now + 1 h).
- **Silencio en cron**: los ticks 1-2 no generan notificaciones (verificado en la demo y en `pr_monitor.test.mjs:95-106`), y `main` solo imprime notificaciones (`pr_monitor.mjs:1318-1320`: "empty stdout = silent" en modo `no_agent`). Así que en cron productivo los dos primeros fallos son silenciosos y el tercero publica el `needs-human` en stdout para entrega al dueño — coincide con "al tercero notifica al dueño" y con la advertencia de `SKILL.md:327` ("LLM/API failures notify the owner once per head sha") y `SKILL.md:356-357` ("A recurring LLM/API outage must not spam the owner — notify once per head sha").

## 5. Repro con salida real

Comando seguro usado (variante del propuesto: con `DRY_RUN=1` y estado temporal para no contaminar la contabilidad real; el `DRY_RUN=1` nunca persiste por `pr_monitor.mjs:1314-1316`):

```bash
env -u OPENROUTER_API_KEY DRY_RUN=1 PR_MONITOR_STATE_PATH=/tmp/opencode/repro-state.json \
  node skills/engineering/copilot-review-smart/pr_monitor.mjs --pr dyegolara/dashboard#12 --json-report
```

Salida real (2026-10-10, `exit=0`):

```json
{"type":"pr","repo":"dyegolara/dashboard","pr":12,"title":"Home: live Unraid memory + dojo-mojo-casa-house hardware metrics","head_sha":"cfb4d6d2b3b6a6926e97d6bbb201db5172e03291","action":"wait","reason":"Could not decide with LLM (no OPENROUTER_API_KEY); retrying (1/3).","reused_cached_decision":false,"github_action_posted":false,"next_check_at":"2026-10-10T17:05:46.166Z","owner_notifications":[],"done":false,"terminal":null,"skipped":false}
{"type":"overall","scope":"single-pr","repo":"dyegolara/dashboard","pr":12,"done":false,"actionable_prs":1,"terminal_prs":0,"needs_human_prs":0,"skipped_prs":0,"scope_fetch_failures":0}
```

Y `ls /tmp/opencode/repro-state.json` confirma que no se escribió estado (esperado bajo `DRY_RUN`).

Advertencia sobre el repro tal como está escrito en el diagnóstico (`env -u OPENROUTER_API_KEY node pr_monitor.mjs --pr owner/repo#123 --json-report`, sin `DRY_RUN`): **sí persiste** — `main` guarda estado cuando `DRY_RUN` no es `1` (`pr_monitor.mjs:1316`, `saveState` en `pr_monitor.mjs:217-220`). De hecho el `state.json` real ya acumula `llm_failures: 1` de una corrida no-seca previa. Para reproducir sin efectos usa `DRY_RUN=1` o `PR_MONITOR_STATE_PATH` temporal como arriba.

## 6. La frontera inyectable existe; la delegación Kepler no

- **Inyectable y testeable: sí, verificado.** `runMonitorOnce` acepta `decideFn` y `llmDecider` (`pr_monitor.mjs:882-883`); `decideWithLlm` acepta `llmDecider` (`decision.mjs:177`). Los tests lo ejercitan con stubs en `decision.test.mjs:219-249` (firma sin cambios nunca llama al LLM), `decision.test.mjs:251-286` (firma nueva dispara decisión fresca) y `pr_monitor.test.mjs:58-132` (stub que siempre falla). La arquitectura de costura está documentada en `SKILL.md:302-305` y `README.md:68-69` ("la dependencia LLM es inyectable para tests sin red"). El harness de fixtures evita la clave real de otra forma: fija `OPENROUTER_API_KEY: "fixture-key"` (`harness/run_fixture.mjs:79`) e intercepta `fetch` a OpenRouter (`harness/fake_openrouter.mjs:12-35`).
- **Límite: el `main` productivo nunca inyecta.** `main` (`pr_monitor.mjs:1292-1324`) llama `runMonitorOnce` sin `decideFn` ni `llmDecider` (`pr_monitor.mjs:1305-1312`), así que por CLI siempre se usa `callLlm` con `OPENROUTER_API_KEY`. No existe flag ni env para un decidor alternativo.
- **Delegación a sesión Kepler: no existe hoy.** Búsqueda `create_session|taskContext|kepler|Kepler|MCP|mcp` bajo `skills/engineering/` devuelve **cero archivos**. La única mención Kepler del repo está en esta carpeta `docs/research/` (la investigación anterior cita `kepler-workspace_session_read` como herramienta observada del runtime, no como código del skill). El fix de "delegar vía sesión" requiere código nuevo por completo: serializar `llmContext`, invocar la API/sesión, y reinyectar la respuesta como `llmDecider`.
- **Portabilidad (ADR-0002).** `docs/adr/0002-plain-esm-javascript-for-skill-scripts.md:3-9` exige scripts `.mjs` que corran "as-is in any agentic environment" con "zero dependencies beyond Node itself", validados con `node --check` y smoke `DRY_RUN=1` (`0002:23-26`). Un decidor que hable con la API local de Kepler introduce un acoplamiento de plataforma (endpoint local, autenticación loopback, serialización de contexto tipo `taskContext:false`) que rompe ese contrato salvo que viva detrás de una costura opcional y con fallback documentado.
- **Cron productivo sin agente.** `SKILL.md:315-321` documenta el cron Hermes desplegado: `no_agent: true`, `deliver: origin`, corriendo `pr_monitor.sh` (wrapper porque el runner ejecuta no-`.sh` con Python). Con `no_agent: true` **no hay sesión agente a la cual delegar**: la rama "si hay Kepler delegar" del fix no aplica al modo que más lo necesita. El propio diagnóstico lo marca como restricción (`cron productivo corre con no_agent:true`); queda verificado que esa restricción vacía la propuesta en el caso productivo.
- **Semántica a preservar.** `wait` transitorio es no-terminal (`done: false`, `pr_monitor.test.mjs:1252-1269`); `llm_failed` es terminal `needs-human` (`pr_monitor.mjs:647`); presupuesto 3 fallos por sha (`decision.mjs:4`); `DRY_RUN=1` nunca publica ni persiste (`pr_monitor.mjs:342-348` para comentarios, `pr_monitor.mjs:1314-1316` para estado).

## 7. Evaluación del fix propuesto, alternativas y criterio de aceptación

**Parte viable con el código actual:** inyectar un `llmDecider` alternativo es trivial a nivel de módulo (la costura existe y los tests la usan). Un wrapper externo (no el tick) podría importar `runMonitorOnce` con un `llmDecider` propio sin tocar `pr_monitor.mjs` ni `decision.mjs`.

**Parte que requiere cambio:** (a) delegación a sesión Kepler — código nuevo, sin precedente en el repo; (b) exponerla por CLI/env sin romper ADR-0002 (p. ej. opt-in explícito, fallback a `callLlm`); (c) resolver el caso `no_agent` donde no hay a quién delegar.

**Riesgos:** (1) acoplamiento Kepler viola portabilidad salvo costura opcional; (2) una sesión delegada tiene latencia y costo distintos al `fetch` de 60 s con `AbortSignal.timeout` (`pr_monitor.mjs:602`) — el timeout del tick (`PR_MONITOR_TICK_TIMEOUT`, 5 min, `SKILL.md:175-176`) debe contemplarlo; (3) serializar el transcript completo a otra sesión duplica el gasto de tokens que la caché de firma intenta evitar (`SKILL.md:358-359`); (4) cambiar la semántica `wait`/anti-spam o el presupuesto de 3 fallos rompería los tests citados en §3.

**Alternativas ordenadas por costo:**

1. **Fallo rápido con mensaje accionable (barata, compatible):** si `loadEnvKey` devuelve vacío, devolver `wait` con `reason` que indique setup (`~/.pr-monitor.env`, `resources/deploy/README.md:18`) en vez de contar como intento LLM, o documentar setup + fallo rápido. No quema el presupuesto de 3 fallos en un error de configuración permanente. Requiere decidir si la falta de clave es transitoria (reintentar, comportamiento actual) o permanente (no reintentar): hoy se trata como transitoria.
2. **Re-exportar clave heredada (barata, solo cuando hay agente):** el wrapper que invoca el tick (sesión agente, Listener con entorno) exporta `OPENROUTER_API_KEY` antes del `spawn`; el tick ya la hereda (`listener/src/tick-runner.mjs:85`). No toca el skill; no sirve para cron `no_agent` sin secreto gestionado.
3. **Delegación a sesión Kepler (cara, solo modo con agente):** implementar el `llmDecider` delegado como módulo opcional tras la costura existente. Solo tiene sentido cuando hay sesión disponible; en cron `no_agent` sigue necesitando la clave real (opción 1 o secreto en el host).

**Criterio de aceptación corregido:**

- [ ] La falta de `OPENROUTER_API_KEY` se distingue de un fallo LLM transitorio (configuración permanente vs. outage) y no consume el presupuesto de 3 fallos por sha indebidamente, o se documenta por qué se mantiene el conteo actual.
- [ ] Cualquier decidor alternativo entra por el parámetro `llmDecider` existente (`decision.mjs:177`, `pr_monitor.mjs:883`) sin cambiar la semántica `wait`/`llm_failed`, el anti-spam (una notificación por sha) ni el presupuesto 3-por-sha; la suite `npm run test:copilot-review-smart` sigue en verde (verificado parcialmente el 2026-10-10: 48/48 pass en `decision.test.mjs` + `pr_monitor.test.mjs`).
- [ ] Sin regresión ADR-0002: `node --check` + smoke `DRY_RUN=1` pasan sin Kepler; la delegación, si se añade, es opt-in con fallback a `callLlm`.
- [ ] `DRY_RUN=1` sigue sin publicar ni persistir (verificado en el repro: sin archivo de estado).
- [ ] El caso cron `no_agent: true` queda cubierto por secreto en host o fallo rápido documentado, no por delegación (que no tiene a quién delegar).
