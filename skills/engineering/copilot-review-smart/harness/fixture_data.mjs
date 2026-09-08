const REPO = "dyegolara/skillbook";
const BASE_TS = "2026-09-08T00:00:00.000Z";
const OLD_TS = new Date(Date.now() - 24 * 3600_000).toISOString();

function pr({
  num,
  title,
  headSha,
  draft = false,
  mergeable = true,
  mergeableState = "clean",
  state = "open",
}) {
  return {
    number: num,
    state,
    draft,
    title,
    head: { sha: headSha },
    mergeable,
    mergeable_state: mergeableState,
  };
}

function review({ author, state = "COMMENTED", body = "", ts = BASE_TS }) {
  return {
    user: { login: author },
    state,
    body,
    submitted_at: ts,
  };
}

function issueComment({ num, author, body, ts = BASE_TS }) {
  return {
    user: { login: author },
    body,
    created_at: ts,
    html_url: `http://github.com/${REPO}/issues/${num}#issuecomment-${author}-${Date.parse(ts)}`,
  };
}

function inlineComment({ num, author, body, ts = BASE_TS, topLevel = true }) {
  return {
    user: { login: author },
    body,
    created_at: ts,
    diff_hunk: "@@ -1 +1 @@",
    in_reply_to_id: topLevel ? null : 1,
    html_url: `http://github.com/${REPO}/pull/${num}#discussion_r${Date.parse(ts)}`,
  };
}

function commit(ts = BASE_TS) {
  return {
    commit: {
      author: { date: ts },
    },
  };
}

function buildPrBundle({
  num,
  title,
  headSha,
  draft = false,
  mergeable = true,
  mergeableState = "clean",
  reviews = [],
  issueComments = [],
  inlineComments = [],
  commits = [],
}) {
  const fullPr = pr({ num, title, headSha, draft, mergeable, mergeableState });
  const endpoints = {
    [`repos/${REPO}/pulls/${num}`]: fullPr,
    [`repos/${REPO}/pulls/${num}/reviews?per_page=100&page=1`]: reviews,
    [`repos/${REPO}/pulls/${num}/comments?per_page=100&page=1`]: inlineComments,
    [`repos/${REPO}/issues/${num}/comments?per_page=100&page=1`]: issueComments,
    [`repos/${REPO}/pulls/${num}/commits?per_page=100&page=1`]: commits,
  };
  return { pr: fullPr, endpoints };
}

function makeSignature({
  headSha,
  latestReviewTs = "",
  latestReviewState = "",
  reviewTranscript = [],
  latestInlineTs = "",
  lastCopilotCommentTs = "",
  nInlineUnresolved = 0,
  approved = false,
  mergeable = true,
  mergeableState = "clean",
  issueTranscript = [],
  inlineTranscript = [],
}) {
  const reviewDigest = JSON.stringify(
    reviewTranscript.map((item) => [
      item?.author || "",
      item?.state || "",
      item?.commit_id || "",
      item?.ts || "",
      item?.body || "",
    ])
  );
  const issueDigest = JSON.stringify(
    issueTranscript.map((item) => [
      item?.author || "",
      item?.ts || "",
      item?.body || "",
    ])
  );
  const inlineDigest = JSON.stringify(
    inlineTranscript.map((item) => [
      item?.author || "",
      item?.ts || "",
      item?.body || "",
    ])
  );
  return [
    headSha || "",
    latestReviewTs || "",
    latestReviewState || "",
    latestInlineTs || "",
    lastCopilotCommentTs || "",
    nInlineUnresolved,
    approved,
    mergeable,
    mergeableState,
    reviewDigest,
    issueDigest,
    inlineDigest,
  ].join("|");
}

const idleBundle = buildPrBundle({
  num: 7,
  title: "Idle cached PR",
  headSha: "idle123",
});

const reviewBundle = buildPrBundle({
  num: 42,
  title: "Needs Copilot review",
  headSha: "review123",
});

const repoPr1 = buildPrBundle({
  num: 21,
  title: "Repo PR one",
  headSha: "repo111",
});

const repoPr2 = buildPrBundle({
  num: 22,
  title: "Repo PR two",
  headSha: "repo222",
});

const humanAllClearBundle = buildPrBundle({
  num: 51,
  title: "Human all-clear",
  headSha: "human123",
  reviews: [
    review({
      author: "reviewer",
      body: "Looks good to me, nothing else to add.",
    }),
  ],
});

const copilotAllClearBundle = buildPrBundle({
  num: 52,
  title: "Copilot all-clear",
  headSha: "copilot123",
  issueComments: [
    issueComment({
      num: 52,
      author: "copilot-pull-request-reviewer[bot]",
      body: "All clear on this head. No further issues.",
    }),
  ],
});

const requestFixBundle = buildPrBundle({
  num: 53,
  title: "Inline comment still pending",
  headSha: "fix123",
  inlineComments: [
    inlineComment({
      num: 53,
      author: "copilot-pull-request-reviewer[bot]",
      body: "Please address this failing edge case.",
      ts: "2026-09-08T02:00:00.000Z",
    }),
  ],
  commits: [commit("2026-09-08T01:00:00.000Z")],
});

const stuckBundle = buildPrBundle({
  num: 54,
  title: "Still conflicted",
  headSha: "stuck123",
  mergeable: false,
  mergeableState: "dirty",
  issueComments: [
    issueComment({
      num: 54,
      author: "alice",
      body: "@copilot resolve the merge conflicts with origin/main",
      ts: "2026-09-07T12:00:00.000Z",
    }),
  ],
});

const loopTick1Bundle = buildPrBundle({
  num: 61,
  title: "Loop until ready",
  headSha: "loop123",
});

const loopTick2Bundle = buildPrBundle({
  num: 61,
  title: "Loop until ready",
  headSha: "loop123",
  reviews: [
    review({
      author: "reviewer",
      body: "Thanks, nothing else to add.",
      ts: "2026-09-08T02:30:00.000Z",
    }),
  ],
});

const liveScopeTick1Pr1 = buildPrBundle({
  num: 71,
  title: "Existing PR",
  headSha: "live111",
});

const liveScopeTick2Pr1 = buildPrBundle({
  num: 71,
  title: "Existing PR",
  headSha: "live111",
  reviews: [
    review({
      author: "reviewer",
      body: "This one is done.",
      ts: "2026-09-08T03:00:00.000Z",
    }),
  ],
});

const liveScopeTick2Pr2 = buildPrBundle({
  num: 72,
  title: "Opened mid-loop",
  headSha: "live222",
  reviews: [
    review({
      author: "reviewer",
      body: "New PR is also all clear.",
      ts: "2026-09-08T03:10:00.000Z",
    }),
  ],
});

const notifyOnceBundle = buildPrBundle({
  num: 55,
  title: "Notify once per sha",
  headSha: "notify123",
  reviews: [
    review({
      author: "reviewer",
      body: "Nothing else to add.",
      ts: "2026-09-08T04:00:00.000Z",
    }),
  ],
});

function repoTick(prBundles) {
  return Object.assign(
    {
      [`repos/${REPO}/pulls?state=open&per_page=100&page=1`]: prBundles.map((bundle) => bundle.pr),
    },
    ...prBundles.map((bundle) => bundle.endpoints)
  );
}

function prTick(bundle) {
  return bundle.endpoints;
}

const SCENARIOS = {
  "first-tick-wait": {
    description: "Fresh repo-scope tick uses frozen LLM response and stays silent.",
    args: ["--repo", REPO],
    dryRun: true,
    ticks: [
      {
        gh: repoTick([idleBundle]),
        llmResponses: [{ action: "wait", reason: "fixture wait on first tick" }],
      },
    ],
  },
  "idle-tick": {
    description: "Cached repo-scope tick reuses wait without any LLM call.",
    args: ["--repo", REPO],
    dryRun: true,
    initialState: {
      [`${REPO}#7`]: {
        _sig: makeSignature({
          headSha: "idle123",
          mergeable: true,
          mergeableState: "clean",
        }),
        _action: "wait",
        _reason: "cached wait",
      },
    },
    ticks: [
      {
        gh: repoTick([idleBundle]),
        llmResponses: [],
      },
    ],
  },
  "single-pr-request-review": {
    description: "Single-PR scope emits JSON and asks Copilot for review.",
    args: ["--pr", `${REPO}#42`, "--json-report"],
    dryRun: true,
    ticks: [
      {
        gh: prTick(reviewBundle),
        llmResponses: [{ action: "request_review", reason: "new commits need Copilot review" }],
      },
    ],
  },
  "repo-json-report": {
    description: "Repo-scope agent run emits one JSON line per PR plus overall.",
    args: ["--repo", REPO, "--json-report"],
    dryRun: true,
    ticks: [
      {
        gh: repoTick([repoPr1, repoPr2]),
        llmResponses: [
          { action: "wait", reason: "repo pr one can wait" },
          { action: "request_review", reason: "repo pr two needs review" },
        ],
      },
    ],
  },
  "all-clear-human": {
    description: "Human reviewer transcript reaches All-clear.",
    args: ["--pr", `${REPO}#51`, "--json-report"],
    dryRun: true,
    ticks: [
      {
        gh: prTick(humanAllClearBundle),
        llmResponses: [{ action: "notify_ready", reason: "human reviewer left no further requests" }],
      },
    ],
  },
  "all-clear-copilot": {
    description: "Copilot clean confirmation reaches All-clear.",
    args: ["--pr", `${REPO}#52`, "--json-report"],
    dryRun: true,
    ticks: [
      {
        gh: prTick(copilotAllClearBundle),
        llmResponses: [{ action: "notify_ready", reason: "Copilot confirmed the current head is clean" }],
      },
    ],
  },
  "unaddressed-inline-comment": {
    description: "Pending inline feedback blocks All-clear and requests a fix.",
    args: ["--pr", `${REPO}#53`, "--json-report"],
    dryRun: true,
    ticks: [
      {
        gh: prTick(requestFixBundle),
        llmResponses: [{ action: "request_fix", reason: "Copilot inline feedback is still unaddressed" }],
      },
    ],
  },
  "needs-human-conflicts": {
    description: "Conflict retry budget exhausted escalates once and reports needs-human.",
    args: ["--pr", `${REPO}#54`, "--json-report"],
    dryRun: false,
    initialState: {
      [`${REPO}#54`]: {
        rebase_pings_sha: "stuck123",
        rebase_pings: 3,
        last_ping_ts: OLD_TS,
      },
    },
    ticks: [
      {
        gh: prTick(stuckBundle),
        llmResponses: [],
      },
      {
        gh: prTick(stuckBundle),
        llmResponses: [],
      },
    ],
  },
  "notify-ready-once-per-sha": {
    description: "Notify-ready fires once per head sha and then stays quiet on repeats.",
    args: ["--pr", `${REPO}#55`, "--json-report"],
    dryRun: false,
    ticks: [
      {
        gh: prTick(notifyOnceBundle),
        llmResponses: [{ action: "notify_ready", reason: "review transcript reached all-clear" }],
      },
      {
        gh: prTick(notifyOnceBundle),
        llmResponses: [],
      },
    ],
  },
  "loop-single-pr-to-done": {
    description: "Loop one PR until the overall report becomes done.",
    args: ["--pr", `${REPO}#61`, "--json-report"],
    dryRun: false,
    ticks: [
      {
        gh: prTick(loopTick1Bundle),
        llmResponses: [{ action: "request_review", reason: "Copilot has not reviewed this head yet" }],
      },
      {
        gh: prTick(loopTick2Bundle),
        llmResponses: [{ action: "notify_ready", reason: "reviewer left no further requests" }],
      },
    ],
  },
  "loop-repo-live-scope": {
    description: "Repo loop picks up a PR that appears on the next tick.",
    args: ["--repo", REPO, "--json-report"],
    dryRun: false,
    ticks: [
      {
        gh: repoTick([liveScopeTick1Pr1]),
        llmResponses: [{ action: "wait", reason: "existing PR is still in progress" }],
      },
      {
        gh: repoTick([liveScopeTick2Pr1, liveScopeTick2Pr2]),
        llmResponses: [
          { action: "notify_ready", reason: "existing PR reached all-clear" },
          { action: "notify_ready", reason: "new PR also reached all-clear" },
        ],
      },
    ],
  },
};

export { REPO, SCENARIOS };
