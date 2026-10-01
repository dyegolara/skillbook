# Platform-agnostic image for the copilot-review-smart Listener.
# Build from the skill folder:
#   docker build -f resources/deploy/Dockerfile -t copilot-review-smart-listener .
FROM node:22-alpine

# The tick shells out to the GitHub CLI; the Listener itself has no runtime
# dependencies beyond Node and gh.
RUN apk add --no-cache github-cli ca-certificates

WORKDIR /skill
COPY pr_monitor.mjs decision.mjs pr_monitor_webhook.mjs ./

# State, Expectations, pid and log files live here; mount a volume on it.
ENV PR_MONITOR_WEBHOOK_HOST=0.0.0.0 \
    PR_MONITOR_WEBHOOK_PORT=8787 \
    PR_MONITOR_WEBHOOK_STATE_PATH=/state/listener-state.json \
    PR_MONITOR_WEBHOOK_PID_PATH=/state/listener.pid \
    PR_MONITOR_WEBHOOK_LOG=/state/listener.log \
    PR_MONITOR_STATE_PATH=/state/state.json
VOLUME ["/state"]
EXPOSE 8787

# --keep-alive: a supervisor owns the container lifecycle.
CMD ["node", "pr_monitor_webhook.mjs", "--serve", "--keep-alive"]
