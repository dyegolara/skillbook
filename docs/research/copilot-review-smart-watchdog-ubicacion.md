# Dónde corre el watchdog de `copilot-review-smart` en un dev-server como este, y si se puede vigilar en una terminal de Kepler

> Nota posterior: `CONTEXT.md` se renombró a `GLOSSARY.md` al redactar el spec.
> Las citas a `CONTEXT.md` en este informe apuntan al mismo contenido.

Fecha: 2026-10-10. Ambiente probado: el contenedor donde corre esta sesión (`hostname e1e7f6f50788`, usuario `dojomojocasahouse`).
Repo y rama de la investigación: skillbook, `kepler/research-cuando-se-ejecuta`.
Cada afirmación lleva su fuente primaria (ruta + línea, URL oficial, herramienta MCP observada o salida de comando verificada en este ambiente).

## Convención de guardado

El repo solo tiene `docs/adr/`, `docs/agents/` y `docs/VERSIONING.md` (verificado con `ls docs/`; el layout single-context se describe en `docs/agents/domain.md:1-14`).
No existe convención para notas de investigación, así que se creó `docs/research/` y esta nota vive en `docs/research/copilot-review-smart-watchdog-ubicacion.md`.

## Respuesta corta

1. **Dónde corre:** donde tú lo invocas. El skill no instala ningún daemon global: cada tick es un proceso `node` hijo del runtime del agente, y el Listener es otro proceso `node` que tú levantas en primer plano (`--serve`) o separado (`--daemon`). En un ambiente como este, eso significa **dentro de este mismo contenedor dev-server**, con el usuario `dojomojocasahouse`, sin systemd, sin cron y sin Docker adentro. Cada dev-server es un contenedor separado: si lo levantas aquí, solo existe aquí.
2. **¿Se puede vigilar en una terminal de Kepler?** **Sí.** No existe herramienta MCP para terminales (catálogo `kepler-workspace` observado en esta sesión, sin ninguna operación de terminal), pero la API HTTP local de Kepler sí expone terminales y fue verificada por prueba directa en este ambiente. Creas una terminal atada a esta tarea, le inyectas el comando del Listener o del tick, y su buffer es el log en vivo visible en la UI de Kepler.

## 1. Qué es el "watchdog process": dos procesos, no uno

El skill tiene dos modos y dos procesos distintos. Fuente: `skills/engineering/copilot-review-smart/SKILL.md:33-57`.

- **Tick** (`pr_monitor.mjs`): una invocación = exactamente un tick del watchdog (`SKILL.md:81`). No duerme nunca; la receta del loop (dormir 1 h, mínimo 15 min, re-ejecutar) es propiedad de quien lo llama (`SKILL.md:107-114`).
- **Listener** (`pr_monitor_webhook.mjs`): proceso HTTP de larga duración que recibe deliveries de GitHub, los verifica/filtra y genera ticks (`SKILL.md:46-57`). "No tiene lógica de decisión" (`pr_monitor_webhook.mjs:8-12`); la implementación vive en `listener/src/` con un módulo por concern (`listener/README.md:18-31`).

Glosario del repo lo confirma: **Tick** es "una invocación del watchdog sobre un scope" (`CONTEXT.md:124-128`), **Listener** es "el proceso HTTP de larga duración" (`CONTEXT.md:130-134`), **Host** es "la máquina donde corre el skill — listener, estado y timers viven ahí" y el skill nunca asume plataforma (`CONTEXT.md:118-122`).

## 2. Dónde corre cada proceso (diseño: "donde lo pongas")

El diseño es deliberadamente agnóstico a plataforma:

- `docs/adr/0005-webhook-first-expectation-fallback.md:30-33`: "los archivos de despliegue son agnósticos a plataforma; el agente elige dónde ejecutarlos para su Host".
- `skills/engineering/copilot-review-smart/resources/deploy/README.md:3-8`: "esta carpeta no elige plataforma por ti: el agente (o el operador) elige dónde ejecutarlo — un VPS, un host de contenedores, una máquina en casa — según lo que el Host ya tenga".
- Requisitos mínimos del Listener: Node >= 18, `gh` autenticado, red a GitHub y OpenRouter, y una URL HTTPS pública que alcance `POST /github/webhook` (`resources/deploy/README.md:3-8`).

Rutas de ejecución soportadas por el propio skill (fuente: `listener/src/cli.mjs:21-37`, `SKILL.md:73-77`):

| Modo | Comando | Vive mientras… |
|---|---|---|
| Primer plano | `node pr_monitor_webhook.mjs --serve` | viva la sesión que lo invocó (`SKILL.md:134-136`: "`--serve` en primer plano, `--daemon` separado para que la sesión invocadora pueda terminar") |
| Separado | `node pr_monitor_webhook.mjs --daemon` | separado del padre: `spawn` con `detached: true`, stdio a archivo de log, `unref`, y espera hasta que `/healthz` responde (`listener/src/daemon.mjs:137-178`) |
| Tick único | `node pr_monitor.mjs --repo …` o `--pr …` | un tick y termina; el alcance repo y single-PR son mutuamente excluyentes (`SKILL.md:81-82`, `pr_monitor.mjs:140-158`) |
| Cron alterno | cron apuntando a `pr_monitor.mjs` con `PR_MONITOR_REPOS` | cada hora está bien porque la caché de firma abarata los ticks ociosos (`SKILL.md:312-314`) |
| systemd | unidad plantilla `copilot-review-smart-listener@.service` | `Restart=on-failure`, `ExecStart=/usr/bin/node pr_monitor_webhook.mjs --serve --keep-alive` (`resources/deploy/copilot-review-smart-listener@.service:7-26`) |
| Docker | `Dockerfile` + `docker-compose.yml` | imagen `node:22-alpine` + `github-cli`, estado en volumen `/state`, `restart: unless-stopped` (`resources/deploy/Dockerfile:1-25`, `resources/deploy/docker-compose.yml:1-30`) |

Detalle importante del ciclo de vida: el Listener es **efímero por defecto** — sale cuando no queda ningún PR abierto por vigilar; `--keep-alive` lo mantiene arriba bajo un supervisor (`SKILL.md:145-149`, `listener/src/listener.mjs:175-182`). El tick de arranque (**Startup tick**) recupera deliveries perdidos mientras estuvo caído (`SKILL.md:137-138`, `listener/src/listener.mjs:421-484`; GitHub no reintenta: `CONTEXT.md:141-146`).

El tick hijo se genera así: el Listener hace `spawn` de `node <skill>/pr_monitor.mjs --pr owner/repo#N --json-report` (alcance repo para el Startup tick), con env del hijo limpio de alcance propio, `detached` en no-Windows, y timeout que mata el árbol a los 5 min por defecto (`listener/src/tick-runner.mjs:64-151`, `listener/src/paths.mjs:10-20`).

Estado y archivos en disco (rutas por defecto, todas bajo el home del usuario que lo corre):

- Tick: `PR_MONITOR_STATE_PATH`, por defecto `~/.cache/pr-monitor/state.json` (`pr_monitor.mjs:38-39`).
- Listener: `PR_MONITOR_WEBHOOK_STATE_PATH`, por defecto `~/.cache/pr-monitor/listener-state.json` (`listener/src/state.mjs:18-21`); pid en `~/.cache/pr-monitor/listener.pid` y log en `~/.cache/pr-monitor/listener.log` (`listener/src/daemon.mjs:7-15`).
- El deploy Docker remapea a `/state/` vía variables de entorno (`resources/deploy/docker-compose.yml:12-18`, `resources/deploy/Dockerfile:15-21`).

Puerto y endpoint: por defecto bind `127.0.0.1:8787`, `GET /healthz` (liveness + última delivery) y `POST /github/webhook` con HMAC-SHA256 (`listener/src/paths.mjs:13-14`, `listener/src/http-transport.mjs:14-68`, `listener/src/signature.mjs:4`, `SKILL.md:156-164`).

## 3. Qué es "una instancia" en este ambiente (verificado por prueba)

Todo lo de esta sección se verificó con comandos en esta sesión el 2026-10-10 (salidas completas en la transcripción de la sesión; aquí el resumen con la evidencia):

- **Es un contenedor, no una VM con systemd.** `/.dockerenv` existe; `mount` muestra `overlay` de `containerd`; `hostname` es `e1e7f6f50788` (id de contenedor); PID 1 es `sshd`, no systemd; `systemctl status` responde `System has not been booted with systemd as init system`. No hay binarios `docker`, `podman` ni `crontab` adentro.
- **El agente vive en ese contenedor.** `ps aux` muestra el servidor Kepler (`/config/.kepler-server/server/index.js`), varios `opencode acp` y los puentes MCP `gk … mcp --host=opencode`. La herramienta bash de esta sesión corre como hijo de ese runtime (`/bin/bash -c …` bajo el usuario `dojomojocasahouse`).
- **Usuario y home compartido.** `whoami` = `dojomojocasahouse`, `HOME=/config`. Por eso el estado por defecto del monitor es `/config/.cache/pr-monitor/…`, compartido por todos los worktrees de este contenedor (evidencia: `~/.cache/pr-monitor/state.json` ya contenía el tick del PR `dyegolara/dashboard#12` corrido desde otra sesión — ver sección 4).
- **Cada dev-server = un contenedor hermano.** `/config` está montado desde el host (`/dev/vdb1 on /config`), y los worktrees cuelgan de `/config/kepler/worktrees/`. La red del contenedor es propia (`172.17.0.2`). Un proceso `node` levantado aquí solo existe en este contenedor: no lo ves desde otro dev-server salvo por efectos externos (comentarios en GitHub, Hooks registrados).
- **Variables Kepler de la sesión:** `TERM_PROGRAM=Kepler`, `KEPLER_SESSION_ID=41db7ecc-…`, `KEPLER_TASK_ID=684da629-…`, `KEPLER_WORKTREE_ID=ba0a4702198c623b`, `KEPLER_REPO_ID=8f5ba174-…` (salida de `env`). El bind por defecto del Listener (`127.0.0.1`) solo es alcanzable dentro del contenedor; GitHub necesita una URL pública (Tailscale Funnel, ngrok, cloudflared o proxy inverso — `resources/deploy/README.md:28-37`, recetas en `resources/deploy/ingress/`, p. ej. `ingress/tailscale-funnel.md:1-21`). Sin endpoint público, el modo correcto es cron (`SKILL.md:182-183`, `SKILL.md:307-327`).

**Consecuencia directa para la pregunta:** si ejecutas el skill desde una sesión de agente en este dev-server, el watchdog corre **en este contenedor (`e1e7f6f50788`), bajo `dojomojocasahouse`, como descendiente del proceso `opencode acp`**, con cwd en el worktree desde donde lo lanzaste y estado en `/config/.cache/pr-monitor/`. Con `--serve` muere con tu sesión; con `--daemon`/systemd/Docker sobrevive según el supervisor que elijas (tabla de sección 2). **No es visible desde Kepler como objeto propio**: Kepler lista sesiones y terminales, no procesos arbitrarios (ver sección 5).

## 4. Evidencia en vivo de que el tick corre en-sesión

La sesión `kepler-session:12e87875-3f87-483f-b9a5-c95ee6e7294e` ("Copilot review watchdog for dashboard PR 12", leída vía `kepler-workspace_session_read`) ejecutó un tick con alcance `dyegolara/dashboard#12` y reportó `action: wait` por falta de `OPENROUTER_API_KEY` más la guardia de trabajo activo (< 3 h desde el último commit). El rastro en disco lo confirma: `/config/.cache/pr-monitor/state.json` contiene la entrada `dyegolara/dashboard#12` con `llm_failures: 1` y `last_head_sha: cfb4d6d…` (leído con `cat` en esta sesión). Esto prueba el modelo de ejecución: el agente corre `node pr_monitor.mjs` como subproceso propio, en el contenedor, con el home compartido.

## 5. ¿Se puede abrir en una terminal de Kepler para vigilarlo? Sí

### 5.1. Lo que NO existe: herramienta MCP de terminales

Catálogo `kepler-workspace` observado en esta sesión (fuente primaria: la lista de herramientas disponibles del propio runtime): `add_task_note`, `archive_task`, `attach_link`, `attach_worktree`, `create_session`, `create_task`, `create_worktree`, `detach_link`, `detach_worktree`, `discard_worktree`, `get_task_context`, `list_agents`, `list_repos`, `list_sessions`, `list_task_resources`, `list_tasks`, `read_task_note`, `refresh_task_links`, `remove_task_note`, `session_read`, `session_send`, `set_task_stage`, `unarchive_task`, `update_task_note`. **Ninguna crea, escribe ni lee terminales.** `list_sessions` enumera sesiones de agente (verificado: devuelve 6 sesiones con `handle`, `taskId`, `worktreePath`, `live`), no terminales. Si algo no está en ese catálogo, el agente no puede hacerlo por MCP. Dicho explícitamente: **no se encontró fuente primaria para una operación MCP de terminales; por MCP, la respuesta es no.**

### 5.2. Lo que SÍ existe: API HTTP local de terminales (verificada por prueba)

Fuente documental: `skills/software-factory/docs/kepler-api.md:1-26` (nota: vive en otro worktree, `skillbook-grill-docs-necesitamos-asegurarnos-8f5ba174`, trabajo aún no fusionado a `main` al momento de escribir; se cita como fuente secundaria interna y por eso se re-verificó todo por prueba directa).

Verificación propia en este ambiente (2026-10-10, comandos `curl` contra la API local):

- Base en `~/.kepler-server/data/server.host` + `server.port` (aquí `127.0.0.1:36325`; el puerto cambia entre arranques — leer siempre los archivos, nunca fijarlo). El helper la resuelve así (`launch-stage.mjs:72-79`).
- `GET /terminal/list` devuelve el arreglo de terminales con `id`, `label`, `worktreePath`, `repoId`, `worktreeId`, `taskId`, `exited`, `closing` (probado: lista 9+ terminales, p. ej. `chain #55: status` `544749d8-…`).
- `POST /terminal/start` crea una terminal atada a `repoId` + `worktreeId` + `taskId` + `worktreePath` (los cuatro requeridos) más `label`/`shell` opcionales. `POST /terminal/input` con `{terminalId, input}` teclea en su bash (PTY real; `\n` ejecuta). `GET /terminal/buffer?terminalId=…` devuelve el scrollback como **string JSON desnudo** con escapes ANSI (probado: el buffer de `544749d8-…` muestra el loop de status corriendo en `e1e7f6f50788`, mismo host que esta sesión — prueba de que las terminales Kepler corren **en este mismo contenedor**).
- Sin autenticación en loopback (misma fuente, verificada implícitamente: los `curl` sin token funcionaron).
- Receta de descubrimiento si la API cambia: `kepler-api.md:49-70` (rutas en el bundle JS de la UI, errores de validación que nombran campos requeridos).

El helper `skills/software-factory/scripts/launch-stage.mjs:1-25,90-94` (mismo worktree externo) envuelve exactamente este flujo: deriva los ids de una terminal ancla en el mismo worktree, crea la terminal etiquetada y le inyecta el comando. Sirve como ejemplo de uso, no como dependencia del skill watchdog.

### 5.3. Cómo hacerlo: comandos concretos para ESTA tarea

Ids de esta tarea (de `env` en esta sesión): `repoId=8f5ba174-47dd-40fd-858b-326c45c8c503`, `worktreeId=ba0a4702198c623b`, `taskId=684da629-70c3-49f9-91e6-142fbf963e56`, `worktreePath=/config/kepler/worktrees/skillbook-research-cuando-se-ejecuta-8f5ba174`.

```bash
API="http://$(cat ~/.kepler-server/data/server.host):$(cat ~/.kepler-server/data/server.port)"

# 1. Crear la terminal atada a esta tarea (los 4 ids son obligatorios)
curl -s "$API/terminal/start" -H 'Content-Type: application/json' -d '{
  "repoId": "8f5ba174-47dd-40fd-858b-326c45c8c503",
  "worktreeId": "ba0a4702198c623b",
  "taskId": "684da629-70c3-49f9-91e6-142fbf963e56",
  "worktreePath": "/config/kepler/worktrees/skillbook-research-cuando-se-ejecuta-8f5ba174",
  "label": "copilot-watchdog: listener",
  "shell": "/bin/bash",
  "cols": 118, "rows": 30
}'
# → {"terminalId": "<id>"} (guardar el id)

# 2a. Vigilar el Listener en primer plano (ver log en vivo en la UI de Kepler)
curl -s "$API/terminal/input" -H 'Content-Type: application/json' -d "{
  \"terminalId\": \"<id>\",
  \"input\": \"cd /config/kepler/worktrees/skillbook-research-cuando-se-ejecuta-8f5ba174 && PR_MONITOR_REPOS=\\\"owner/repo\\\" PR_MONITOR_WEBHOOK_SECRET=\\\"$(openssl rand -hex 32)\\\" node skills/engineering/copilot-review-smart/pr_monitor_webhook.mjs --serve --keep-alive\n\"
}"

# 2b. Alternativa: loop de ticks de un solo PR (sin webhook público)
curl -s "$API/terminal/input" -H 'Content-Type: application/json' -d "{
  \"terminalId\": \"<id>\",
  \"input\": \"cd /config/kepler/worktrees/skillbook-research-cuando-se-ejecuta-8f5ba174 && while true; do DRY_RUN=1 PR_MONITOR_REPOS=\\\"owner/repo\\\" node skills/engineering/copilot-review-smart/pr_monitor.mjs; sleep 3600; done\n\"
}"

# 3. Leer el log desde cualquier sesión (el buffer es el log de la etapa)
curl -s "$API/terminal/buffer?terminalId=<id>" | python3 -c "import json,sys,re; print(re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]','',json.loads(sys.stdin.read()))[-3000:])"
```

Notas operativas (todas con fuente):

- La terminal aparece en la UI de Kepler bajo esta tarea y su buffer es el log persistente de la etapa (patrón ya usado por el chain #55: terminales `chain #55: status/dev-flow/…` listadas en `GET /terminal/list`, sesión `kepler-session:7ea0feb5-…`).
- `--serve` en primer plano ata la vida del Listener a la terminal: si la cierras, muere (`POST /terminal/close` con `{terminalId}`). Para que sobreviva al cierre, usa `--daemon` dentro de la misma terminal (pid + log en `~/.cache/pr-monitor/`, `listener/src/daemon.mjs:137-178`) o el loop `while` de 2b.
- Sustituye `owner/repo` por los repos vigilados (el skill nunca los asume por defecto: `SKILL.md:38-40`, `pr_monitor.mjs:140-158`). Guarda `PR_MONITOR_WEBHOOK_SECRET` y `OPENROUTER_API_KEY` fuera del buffer (env file `~/.pr-monitor.env`, cfr. `pr_monitor.mjs:192-207`).
- Para webhook real necesitas además registrar el Hook (`--setup-hooks`, que verifica la URL pública y espera el `ping` de GitHub: `listener/src/cli.mjs:213-239`) y una URL pública que llegue al contenedor (sección 3). Sin ella, usa 2b.

### 5.4. Cómo vigilarlo una vez abierto (independiente de terminales)

- `node pr_monitor_webhook.mjs --status` → pid + salud (`listener/src/cli.mjs:290-300`, vía `listenerStatus` + sonda `/healthz`: `listener/src/daemon.mjs:87-109`).
- `curl http://127.0.0.1:8787/healthz` → `{status, pid, tracked_flows, pending_expectations, last_delivery}` (`listener/src/listener.mjs:357-366`).
- Logs JSONL a stdout (+ `PR_MONITOR_WEBHOOK_LOG` opcional): eventos `delivery_accepted`, `tick_finished`, `expectation_armed`, `flow_closed`, `listener_idle` (`listener/src/cli.mjs:99-120`, `listener/src/listener.mjs` passim).
- Proceso: `ps aux | grep -E 'pr_monitor|listener'` en cualquier sesión/terminal del mismo dev-server.
- `--list-hooks` muestra Hooks y deliveries recientes (`listener/src/cli.mjs:342-348`).

## 6. Pasos de verificación sugeridos (copiar/pegar)

```bash
# A. Soy un contenedor dev-server sin systemd ni docker adentro
test -f /.dockerenv && echo "dockerenv: si"; hostname; ps -p 1 -o comm=
systemctl status 2>&1 | head -2; command -v docker podman crontab || echo "sin docker/podman/crontab"
env | grep -E '^(KEPLER|TERM_PROGRAM|HOME|PWD)=' | sort

# B. El tick corre aquí mismo como hijo del agente (prueba seca, no publica nada)
cd /config/kepler/worktrees/skillbook-research-cuando-se-ejecuta-8f5ba174
DRY_RUN=1 PR_MONITOR_REPOS="owner/repo" node skills/engineering/copilot-review-smart/pr_monitor.mjs; echo "exit=$?"
ls -la /config/.cache/pr-monitor/   # estado compartido del contenedor

# C. La API de terminales existe y enumera (puerto dinámico: leer archivos)
API="http://$(cat ~/.kepler-server/data/server.host):$(cat ~/.kepler-server/data/server.port)"
curl -s "$API/terminal/list" | python3 -c "import json,sys; print(len(json.load(sys.stdin)), 'terminales')"
curl -s "$API/agent/sessions" | head -c 200  # sesiones ≠ terminales

# D. MCP no ofrece terminales (inspección del catálogo en tu cliente:
# busca kepler-workspace_*terminal*; no existe — solo sesiones y tareas)
```

## 7. Límites y cosas sin fuente primaria

- **Orquestador de dev-servers:** desde adentro del contenedor no hay fuente primaria de cuántos dev-servers existen ni de quién los crea (sin API del orquestador, sin `docker`, sin manifiesto). "Tengo varios" se toma del operador; lo verificado es que este es uno (`e1e7f6f50788`) y que el estado en `/config/.cache` es por contenedor.
- **Alcanzabilidad pública de este dev-server:** depende del networking del operador (Funnel/túnel/proxy). El skill solo exige `PR_MONITOR_PUBLIC_URL` y verifica el `ping` antes de declarar éxito (`listener/src/cli.mjs:213-239`); no se probó exponer este contenedor concreto.
- **`kepler-api.md` y `launch-stage.mjs` citados** viven en el worktree `skillbook-grill-docs-necesitamos-asegurarnos-8f5ba174`, no fusionado a `main` al escribir esto. Se usaron como pista y cada endpoint citado se re-verificó por prueba directa (sección 5.2); si Kepler sube de build, re-verificar con la receta de `kepler-api.md:49-70`.
- **Puertos:** el `36325` visto es efímero; el `8787` del Listener es el default configurable (`PR_MONITOR_WEBHOOK_PORT`). Leer siempre `~/.kepler-server/data/server.port` y no fijar valores.
