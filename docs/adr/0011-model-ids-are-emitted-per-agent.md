# Model ids are emitted in the form each agent accepts

`DEV_ENV_MODEL_<STAGE>` keeps one canonical human-readable form,
`provider/model` (`opencode-go/glm-5.3`). That form is what `pi` and `opencode`
want on their model flag; it is not what `claude`, `codex`, `grok` or the
Cursor CLI want, and passing it verbatim hands those agents an id they never
document. The launch layer therefore owns an emission rule per agent: it
strips the `provider/` prefix for the agents that take a bare model id or
alias, and keeps it for the agents that take `provider/model`. The variable
itself is never rewritten.

## Considered Options

Passing the string verbatim to every agent (today's behavior; wrong for four
of the six agents); storing two fields per stage and letting the caller emit
the right one (the settings surface would have to know each CLI's flag
vocabulary); normalizing the variable per agent before it is set (the same
value would then read differently depending on which agent a stage happens to
use).

## Consequences

One value, one meaning, one place where a CLI's quirk is known. A new agent
that wants a third shape extends the emission table instead of adding a
second representation of the same model. The chain keeps validating the model
as a free string; the shape rule is an emission concern, not a validation one.
