export const dashboardMessages = {
  nav: "Dashboard",
  title: "Less model. More memory.",
  refresh: "Refresh measurements",
  loading: "Loading handling measurements",
  scope: "Latest {{count}} recorded handling outcomes · oldest to newest",
  truncated:
    "Showing the latest {{limit}} outcomes. All metrics below use this cohort; live queue and catalog counts cover the whole shop.",
  cohort:
    "All metrics below use these saved outcomes; live queue and catalog counts cover the whole shop.",
  deterministic: "Zero-token handling",
  deterministicCount: "{{count}} of {{total}} outcomes",
  pending: "Pending approvals",
  active: "Active recipes",
  unknown: "Not enough data",
  unknownValue: "Unmeasured",
  tokens: "LLM tokens",
  time: "Active time",
  tokenUnit: "tokens",
  zeroTokens: "0 tokens",
  zeroTime: "0 ms",
  logScale: "Log scale · zero on a separate lane",
  overall: "Measured agent versus recipe cost",
  overallNote:
    "Means across all measured outcomes in this cohort, with sample counts. Recipe totals include intake extraction.",
  noMeasured: "No measured requests yet",
  sampleCount: "n = {{count}}",
  separateCounts: "Tokens n = {{tokens}} · time n = {{time}}",
  breakdownCount: "breakdown n = {{count}}",
  breakdown:
    "Intake extraction {{intake}} tokens · recipe steps {{run}} tokens",
  agentBreakdown:
    "Agent turns {{agent}} · intake extraction {{intake}} · recipe steps {{run}}",
  allIntake: "All intake extraction · recipe steps {{run}} tokens",
  perRequest: "per request",
  trend: "Measured cost per handled request",
  recipe: "Recipe",
  agent: "Agent",
  unattributed: "Unattributed",
  sequence: "Handling completion order →",
  coverage:
    "{{tokens}} outcomes have unknown tokens; {{time}} have unknown time. Gaps are never zeroes.",
  empty: "The curve starts with real work.",
  emptyHint:
    "Complete a recipe run or resolve a request with the agent to record a measurement.",
  compare: "Same request type. Measured cost.",
  requestType: "Request type",
  meanCost: "{{tokens}} tokens · {{duration}}",
  partialCost: "{{tokens}} tokens · time unmeasured",
  partialTime: "Tokens unmeasured · {{duration}}",
  comparisonNote:
    "Means from observed requests of the same type, including intake and any prior recipe attempt. These are different requests, not a paired replay or a price estimate.",
  records: "Inspect recorded outcomes",
  completed: "Completed",
  request: "Request",
  handler: "Handler",
  method: "How these measurements are made",
  methodCohort:
    "One outcome per request: a completed execute-mode intake recipe, or a request explicitly resolved by the agent through a recorded action. Recipe outcomes cover the shop; agent outcomes are scoped to your signed-in user and workspace. Seed history and older unlinked or manually resolved requests have no measured handling record and are excluded. Dry runs, queued handoffs, interrupted runs and pending approvals are excluded. The cohort is limited to the latest 100 completions.",
  methodTokens:
    "Recipe tokens are input + output from the saved intake match and executor checkpoint, including extraction. Zero-token share is completed recipe outcomes with exactly 0 recorded tokens divided by all outcomes in the cohort; unknowns remain in the denominator. Failed or interrupted extraction has unknown usage, even if the provider consumed tokens.",
  methodAgent:
    "The framework records agent input + output tokens and run duration in agent_trace_summaries. From this dashboard release onward, successful request actions, including read-only lookups, link the exact agent run and thread to the request; set-request-status(resolved) records agent handling. For your signed-in user and workspace, we charge the full recorded turns between the first request action and resolution in each thread. A turn that reads the request and asks a question counts even when it makes no mutation. Intervening chat or order work counts too; each run is counted once. Shared turns or overlapping request windows are unmeasured because their cost cannot be allocated honestly. Older unlinked handling, missing or retained-away traces, and placeholder zero-token agent totals are unmeasured. External agents without local usage records are unmeasured. Attribution begins now; no historical cost is invented.",
  methodTime:
    "Recipe time is saved matching duration plus the sum of active step durations, including extraction and retries; it excludes approval waiting and orchestration overhead. Matching duration is recorded from this release onward; older totals remain unmeasured. Agent time adds linked framework run durations and prior intake/recipe work; it excludes time between turns. It is active processing time, not end-to-end customer wait time.",
  methodChart:
    "Points are individual completions, distinguished by color and shape. Positive tokens and active times use a logarithmic scale; exact zeroes occupy their own labelled lane below it. No value is shifted to make log(0) plot. The horizontal axis follows completion order; same-day labels show the time only. There is no smoothed or rolling-mean curve. Unknown values are omitted, never plotted as zero. Agent trace writes may finish after resolution: refresh after the turn ends.",
} as const;
