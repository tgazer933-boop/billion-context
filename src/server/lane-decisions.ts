/**
 * #3417 lane-decisions: the single source of truth for per-lane gating
 * decisions ("are the tools reachable? is the compress surface on? may the
 * nudge ride this turn?").
 *
 * History: the same gating expressions were copied into all four wire
 * adapters and drifted (#3293 prompt/tool gate drift, #3401 lane-name
 * reachability misjudged 4x). This module is the extraction point:
 *
 *   ① HostProfile — per-agent DECLARED defaults (the registry is the only
 *      place a lane name is compared; identity lives here, properties flow out)
 *   ② WireObservation — per-request OBSERVED facts (which bili tools the
 *      request actually declares, per wire shape). Environment-varying
 *      properties are OBSERVED, not name-derived: the same dsh agent name has
 *      profiles where the agent sees bili's tools and profiles where it
 *      cannot (#3401) — so the observation layer may override the profile
 *      default.
 *   ③ LaneDecisions — the one resolver: consumers (the four prepares, the
 *      loop, plugin paths) read the frozen decision object and never
 *      re-derive a gate from `pluginAgent === "..."` themselves.
 *
 * Kernel purity: host-side only, imports nothing from kernel internals.
 */

import { biliToolsDeclaredOnWire } from "../session-self-heal.js";
import { extractBillingAttributionBlock } from "../preflight.js";

type LaneProtocol = "anthropic" | "openai" | "google" | "responses";

// ① HostProfile registry — the ONLY place lane names are compared (#3417).
// Properties here are per-AGENT constants. Anything that can vary per
// environment/profile/request belongs in ② WireObservation instead.
interface HostProfile {
    readonly identity: string;
    /**
     * Declared default: does this host register bili's ACP tools host-scope
     * (invisible to the model) by default? dsh does (#3177: 0/3939 preset
     * requests carried the tools); pi/omp/opencode expose them visibly. The
     * observation layer overrides this when the request itself declares the
     * tools (#3401: some dsh profiles DO surface them).
     */
    readonly toolsHostScopedByDefault: boolean;
    /**
     * Declared: this host's upstream requests need the billing block carried
     * from the client request (#2189, subscription-OAuth lanes 429 without it).
     */
    readonly wantsBillingBlock: boolean;
    /**
     * Declared: this host's identity stamp rides the request BODY
     * (`prompt_cache_key`) — omp has no session header the proxy can bind
     * (#1403/#1579); pi stamps `x-bili-plugin-conversation` in
     * before_provider_headers instead (which outranks the body field).
     * Registry property, not an adapter-side name gate (#3482 site 3).
     */
    readonly stampsBodyPromptCacheKey: boolean;
    /**
     * Declared: this host build can route anthropic-messages traffic over
     * its own direct TLS transport, bypassing globalThis.fetch (OMP Cowork,
     * #2583) — the fetch-layer interception claim does not hold for such
     * hosts, so body stamps must be withheld there. The per-request truth
     * stays environmental (ompCoworkTransportBypassesFetch reads
     * provider/api/proxy env); this flag owns the "is that even possible
     * here" question (#3482 site 2).
     */
    readonly coworkTransportPossible: boolean;
    /**
     * Declared: this client's `instructions` drift means a NEW persona, so
     * the compression-session key fingerprints it (inverted allowlist —
     * everyone else keys verbatim). Wire-CLIENT entries only: codex (#150,
     * task ids reused across tasks) and claude-on-responses (#970, subagents
     * share the main session id there). #3482 site 4.
     */
    readonly instructionsFingerprintKeyed: boolean;
    /**
     * Declared: this host compacts histories CLIENT-SIDE and resends the
     * compacted form (dsh native compaction, #2432) — the four prepares run
     * the dual-signal compact-guard rebase for such hosts. Registry property,
     * not a name comparison in each adapter (#3417).
     */
    readonly compactsClientSide: boolean;
}

const PROFILES: Record<string, HostProfile> = {
    dsh: { identity: "dsh", toolsHostScopedByDefault: true, wantsBillingBlock: true, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, compactsClientSide: true },
    pi: { identity: "pi", toolsHostScopedByDefault: false, wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, compactsClientSide: false },
    omp: { identity: "omp", toolsHostScopedByDefault: false, wantsBillingBlock: false, stampsBodyPromptCacheKey: true, coworkTransportPossible: true, instructionsFingerprintKeyed: false, compactsClientSide: false },
    opencode: { identity: "opencode", toolsHostScopedByDefault: false, wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, compactsClientSide: false },
};

const ANONYMOUS: HostProfile = { identity: "", toolsHostScopedByDefault: false, wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, compactsClientSide: false };

/** Resolve the declared profile for a plugin agent header value. Trimmed
 * exact match — the historical shape of every pluginAgent comparison. */
function resolveHostProfile(pluginAgent: string | undefined | null): HostProfile {
    const key = (pluginAgent ?? "").trim();
    return PROFILES[key] ?? { ...ANONYMOUS, identity: key };
}

/** Agent-side consumers (the host plugins) resolve their own profile through
 * the same registry — name gates never re-appear adapter-side (#3482). */
export function hostProfileFor(agentName: string | undefined | null): HostProfile {
    return resolveHostProfile(agentName);
}

// ② WireObservation — facts read off THIS request body.
interface WireObservation {
    /** The specific bili tools the request declares (named-tool precision —
     * the nudge advertises `compress`, so THAT name decides reachability,
     * #3403 review follow-up). */
    readonly declaredTools: ReadonlySet<string>;
    /** #3482: does this request's system carry a billing-attribution block
     * (#2189 shape — `x-anthropic-billing-header:` text block)? Observation,
     * not name-derivation: any lane's request that actually carries one
     * keeps it honored (the same evidence-over-defaults override as
     * toolsReachable, #3401). */
    readonly billingBlockObserved: boolean;
}

function observeDeclaredTools(parsed: unknown, protocol: LaneProtocol): ReadonlySet<string> {
    const out = new Set<string>();
    if (parsed === null || typeof parsed !== "object") return out;
    const tools = (parsed as Record<string, unknown>)["tools"];
    if (!Array.isArray(tools)) return out;
    for (const t of tools) {
        if (t === null || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec["name"] === "string" && biliToolsDeclaredOnWire({ tools: [t] }, protocol, rec["name"])) out.add(rec["name"]);
        const fn = rec["function"];
        if (fn !== null && typeof fn === "object" && typeof (fn as Record<string, unknown>)["name"] === "string") {
            const n = (fn as Record<string, unknown>)["name"] as string;
            if (biliToolsDeclaredOnWire({ tools: [t] }, protocol, n)) out.add(n);
        }
        const decls = rec["functionDeclarations"];
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>)["name"] === "string") {
                    const n = (d as Record<string, unknown>)["name"] as string;
                    if (biliToolsDeclaredOnWire({ tools: [t] }, protocol, n)) out.add(n);
                }
            }
        }
    }
    return out;
}

// ①b WireClientProfile — proxy-lane clients carry no pluginAgent header;
// their identity is OBSERVED from wire signals. Registry discipline as ①:
// the wire-client header-name literals live ONLY here (the old
// variable-mediated comparisons in session-id.ts were un-greppable by
// design — #3482 Step 2 site 4 pins them here). Shared detection
// primitives (isCodexClient, the codex UA definition) stay where they are
// — they feed many decisions and are exempt by the #3417 guard's design
// note; the DECISION table moves here.
interface WireClientSignals {
    /** Header NAMES whose value is a non-empty trimmed string. */
    readonly headerNames: ReadonlySet<string>;
    /** The conversation-header source that won precedence (name only). */
    readonly conversationSourceName: string | undefined;
    /** The shared codex UA/header detection (isCodexClient). */
    readonly codexUserAgent: boolean;
}

interface WireClientEntry {
    readonly profile: HostProfile;
    readonly matches: (s: WireClientSignals) => boolean;
}

const WIRE_CLIENTS: readonly WireClientEntry[] = [
    {
        // codex (#150): task-level session ids are REUSED across tasks —
        // different task instructions under one id must not merge. Modern
        // codex isolates subagent threads via the turn-metadata header
        // (keyed verbatim there); the fingerprint still matters for root
        // threads and older builds (same evidence as isCodexClient, #645).
        profile: { ...ANONYMOUS, identity: "codex", instructionsFingerprintKeyed: true },
        matches: (s) => s.headerNames.has("x-codex-turn-metadata") || s.codexUserAgent,
    },
    {
        // claude over Responses (#970): subagents SHARE the main agent's
        // session id (the anthropic path splits them via claudeSubagentSplit;
        // a claude client on the Responses wire only has this fingerprint).
        profile: { ...ANONYMOUS, identity: "claude-responses", instructionsFingerprintKeyed: true },
        matches: (s) => s.conversationSourceName === "x-claude-code-session-id",
    },
];

/** Resolve the wire-client profile from observed signals (first match wins;
 * unknown clients resolve ANONYMOUS — instructions key VERBATIM for them,
 * #1106). */
export function resolveWireClientProfile(signals: WireClientSignals): HostProfile {
    for (const entry of WIRE_CLIENTS) if (entry.matches(signals)) return entry.profile;
    return ANONYMOUS;
}
// ③ LaneDecisions — the frozen decision object every gate reads.
interface LaneDecisions {
    /** The resolved profile (identity + declared defaults). */
    readonly profile: HostProfile;
    /** Observed per-request facts. */
    readonly observed: WireObservation;
    /** Is the tool the nudge/standing prompt advertises (`compress`) actually
     * declared on this request's wire? Environment truth — overrides the
     * profile default when the tools ARE visible (#3401). */
    readonly toolsReachable: { readonly compress: boolean };
    /**
     * Should the model-side compress surface (standing system prompt + nudge)
     * be ON for this request? Plugin lanes whose agent cannot reach the
     * compress tool must not advertise it ("unknown tool" loops, #3177/#3401).
     * Suppression here also keeps the developer/system slot append-stable.
     *
     * Cache-sensitivity note (#3403 review): the flag is recomputed per
     * request from `parsed.tools`; it stays prefix-cache stable as long as the
     * host's tool table is per-session stable (a mid-session flip breaks the
     * cache prefix once — observed only on hosts that violate that premise).
     */
    readonly compressSurfaceOn: boolean;
    /** Legacy alias kept for the four prepares' migration: TRUE when the
     * surface must be OFF (the old `dshCompressSurfaceOff` variable). */
    readonly compressSurfaceOff: boolean;
    /** #3482 site 1: should this lane's summary side-calls carry the billing
     * attribution block extracted from the client system (#2189)? The dsh
     * profile declares it (subscription-OAuth lanes 429 without it); any
     * request observed carrying the block keeps it honored regardless of
     * profile — evidence over defaults, same shape as toolsReachable. */
    readonly billingBlockWanted: boolean;
}

interface LaneDecisionInput {
    readonly protocol: LaneProtocol;
    readonly pluginMode: boolean;
    readonly pluginAgent: string | undefined;
    readonly parsed: unknown;
    /** injectTool config (`shouldInject`) — the config-level master switch. */
    readonly shouldInject: boolean;
}
// ④ nudgeOn — the ONE nudge-injection gate (#3482 Step 2.5). The four
// prepares used to carry four hand-copied conjunctions that drifted (#3293:
// anthropic lost the injectTool conjunct entirely). The deliberate
// per-lane differences are EXPLICIT inputs, pinned by equivalence tests:
//   - `compactionTrigger` — responses only (#2155/#2432 family): a
//     compaction-trigger request never carries the nudge; the other three
//     wires have no trigger concept and pass `false`.
//   - `growthFoldingArmed` — callers arm it with the codex-intercept health
//     window (`modelContextLimit × CODEX_COMPACT_HEALTH_RATIO`) when that
//     mode is live on the responses lane; all other callers pass the
//     windowless variant.
//   - `compressSurfaceOn` — the lane-decisions surface (this is where the
//     old `shouldInject` conjunct lives for every lane; the standalone
//     copies in openai/google were redundant — compressSurfaceOn already
//     implies injectTool).
export interface NudgeGateInputs {
    /** opts.compress.injectNudge — the config-level master switch. */
    readonly injectNudge: boolean;
    /** !!turn.nudge — the kernel produced a nudge plan this turn. */
    readonly hasNudgePlan: boolean;
    /** laneDecisions.compressSurfaceOn. */
    readonly compressSurfaceOn: boolean;
    /** responses: hasCompactionTrigger(parsed.input); others: false. */
    readonly compactionTrigger: boolean;
    /** !nudgeSuppressed(session) || decideFallbackOverride — the decide
     * ladder's fallback is the ONE exception that punches through the
     * suppression latch (#3004 dead-lock guard). */
    readonly suppressionBypassed: boolean;
    /** compressBreakerArmed(session). */
    readonly breakerArmed: boolean;
    /** autoFoldEngaged(loopConfig, session). */
    readonly autoFoldEngaged: boolean;
    /** growthFoldingArmed(loopConfig, healthWindow?) — precomputed with the
     * lane's health window. */
    readonly growthFoldingArmed: boolean;
    /** turn.nudge.shouldInject || emergencyNudge(turn.nudge, …) — the model
     * actually wants compression (or is past the emergency bar). */
    readonly modelWantsIt: boolean;
}

export function nudgeOn(i: NudgeGateInputs): boolean {
    return i.injectNudge && i.hasNudgePlan && i.compressSurfaceOn && !i.compactionTrigger
        && i.suppressionBypassed && !i.breakerArmed
        && !(i.autoFoldEngaged && i.growthFoldingArmed)
        && i.modelWantsIt;
}

export function resolveLaneDecisions(input: LaneDecisionInput): LaneDecisions {
    const profile = resolveHostProfile(input.pluginAgent);
    const declaredTools = observeDeclaredTools(input.parsed, input.protocol);
    // Reachability truth: in PROXY mode bili itself injects the tool
    // definitions into the outbound body, so the surface is structurally on.
    // In PLUGIN mode the host owns the tool table: reach when this request
    // declares `compress` (observed — some dsh profiles DO surface it, #3401)
    // or the host exposes bili tools to the model by design (profile default,
    // #3177).
    const compressReachable = !input.pluginMode
        || declaredTools.has("compress")
        || !profile.toolsHostScopedByDefault;
    const compressSurfaceOn = input.shouldInject && compressReachable;
    const billingBlockObserved = extractBillingAttributionBlock(systemOf(input.parsed)) !== undefined;
    const billingBlockWanted = profile.wantsBillingBlock || billingBlockObserved;
    return Object.freeze({
        profile,
        observed: Object.freeze({ declaredTools, billingBlockObserved }),
        toolsReachable: Object.freeze({ compress: compressReachable }),
        compressSurfaceOn,
        compressSurfaceOff: !compressSurfaceOn,
        billingBlockWanted,
    });
}

function systemOf(parsed: unknown): string | Array<Record<string, unknown>> | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const system = (parsed as Record<string, unknown>)["system"];
    if (typeof system === "string" || Array.isArray(system)) return system;
    return undefined;
}
