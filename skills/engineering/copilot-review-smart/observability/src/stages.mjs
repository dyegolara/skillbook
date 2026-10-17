/** The six Stages of one Tick over one PR, in the glossary's order
 * (`GLOSSARY.md`: collect → check → reuse → decide → act → schedule). The
 * projection and the TUI renderer both read this one list so the API contract
 * and the view cannot disagree about the sequence. */
export const STAGES = ["collect", "check", "reuse", "decide", "act", "schedule"];
