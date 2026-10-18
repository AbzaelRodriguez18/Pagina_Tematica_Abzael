
// Sigil Virtual Router - plugin-managed Pi extension (overwritten on each Sigil connect).
//
// pi 1.0.0 virtual-model adoption, G9c (TDD docs/tdd/pi-1.0.0-upgrade.md):
// registers the virtual model sigil/sigil-router ALWAYS (so enabling routing in
// Sigil settings applies at the next turn WITHOUT a reconnect) and routes each
// request between a configured primary and light model via a classifier.
//
// Config: <project>/.pi/virtual-routing.json - written by Sigil's
// VirtualRoutingSettingsBridge on settings Apply (SOLE-owned whole-file write):
//   {"enabled":false,"primary":"provider/id","light":"provider/id",
//    "classifier":"typesafe/jev-latest","minConfidence":0.7}
//
// Routing decision (FAIL-OPEN: any doubt routes to the primary model; the
// router NEVER throws and NEVER routes to light on a miss):
//   1. config absent/malformed -> primary
//   2. enabled false -> primary
//   3. light unconfigured/unresolvable -> primary (short-circuit, no classify)
//   4. classifier provider/id unresolvable -> primary
//   5. classify throws/aborts/empty answers -> primary
//   6. top answer confidence < minConfidence -> primary
//   7. top choice "complex" -> primary, otherwise -> light
//
// NOTE: no template literals (Kotlin raw-string embedding) and no non-ASCII
// source characters (2.x encoding normalization).

import { readFileSync } from "node:fs";

const VIRTUAL_MODEL_PROVIDER = "sigil";
const VIRTUAL_MODEL_ID = "sigil-router";
const DEFAULT_CLASSIFIER = "typesafe/jev-latest";
const DEFAULT_MIN_CONFIDENCE = 0.7;
const ROUTE_QUESTION_ID = "route";
const CHOICE_COMPLEX = "complex";
const CHOICE_LIGHT = "light";
const CLASSIFY_TIMEOUT_MS = 60000;

let warnCache = {};
function warnOnce(key, message) {
  if (warnCache[key]) return;
  warnCache[key] = true;
  console.warn("[sigil-virtual-router] " + message);
}

// "provider/id" ref -> { provider, id } or null. Splits on the FIRST slash so
// an id that itself contains a slash still parses with a non-empty provider.
function splitModelRef(ref) {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  const provider = trimmed.substring(0, slash).trim();
  const id = trimmed.substring(slash + 1).trim();
  if (provider.length === 0 || id.length === 0) return null;
  return { provider: provider, id: id };
}

// Per-call config read (compaction-ratio pattern: the file is re-read on EVERY
// route call, so a settings-Apply write applies at the next turn without a
// reconnect). Absent/unreadable/malformed -> null (fail-open to primary).
function loadRoutingConfig() {
  let raw = null;
  try {
    raw = readFileSync(process.cwd() + "/.pi/virtual-routing.json", "utf8");
  } catch (e) {
    // Absent config -> fail-open (the default OFF state).
    raw = null;
  }
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  let minConfidence = DEFAULT_MIN_CONFIDENCE;
  if (typeof parsed.minConfidence === "number" && !isNaN(parsed.minConfidence)) {
    minConfidence = Math.min(1, Math.max(0, parsed.minConfidence));
  }
  return {
    enabled: parsed.enabled === true,
    primary: splitModelRef(parsed.primary),
    light: splitModelRef(parsed.light),
    classifier: splitModelRef(parsed.classifier) || splitModelRef(DEFAULT_CLASSIFIER),
    minConfidence: minConfidence,
  };
}

// Resolve a "provider/id" ref to a physical model object. The modelRegistry
// surface is upstream-experimental: probe findOfType(type, provider, id) and
// find(provider, id) - whichever exists - under try/catch and existence checks.
function resolveModel(ctx, type, ref) {
  if (!ref) return null;
  const registry = ctx && typeof ctx === "object" ? ctx.modelRegistry : null;
  if (!registry || typeof registry !== "object") return null;
  try {
    if (typeof registry.findOfType === "function") {
      const found = registry.findOfType(type, ref.provider, ref.id);
      if (found && typeof found === "object") return found;
    }
  } catch (e) {
    // fall through to the plain find probe
  }
  try {
    if (typeof registry.find === "function") {
      const found = registry.find(ref.provider, ref.id);
      if (found && typeof found === "object") return found;
    }
  } catch (e) {
    // keep null
  }
  return null;
}

// Last-resort fail-open primary probe - used ONLY when the configured primary
// ref cannot be resolved (or no config exists). The router never returns light
// on doubt: fall back to the REQUEST's own model (the model the turn would have
// used without the router, when pi's request carries one). There is NO
// registry-default tier: pi 1.0.0's ModelRegistry.find(provider, modelId) is
// two-argument (dist/core/model-registry.d.ts) - a zero-arg "registry default"
// probe is not a real API shape and would silently never yield (JS does not
// check arity). Never throws; null only when nothing at all resolves. A probe
// result that IS the virtual router itself is rejected - routing to itself
// would never resolve.
function isSelfVirtualModel(model) {
  return (
    model && typeof model === "object" &&
    model.provider === VIRTUAL_MODEL_PROVIDER && model.id === VIRTUAL_MODEL_ID
  );
}

function fallbackPrimaryModel(request, ctx) {
  // ctx stays a reserved seam (callers pass it); the only live tier today is
  // the request's own model.
  const requestModel = request && typeof request === "object" ? request.model : null;
  if (
    requestModel && typeof requestModel === "object" &&
    typeof requestModel.provider === "string" && typeof requestModel.id === "string" &&
    !isSelfVirtualModel(requestModel)
  ) {
    return requestModel;
  }
  return null;
}

// Text of the LAST user message in the request (the classify prompt). Tolerant
// reads - an uninterpretable request degrades to "" (caller fail-opens).
function messageText(msg) {
  if (!msg || typeof msg !== "object") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const part of content) {
      if (part && typeof part === "object") {
        if (typeof part.text === "string") text += part.text;
      } else if (typeof part === "string") {
        text += part;
      }
    }
    return text;
  }
  return "";
}

function userMessageText(request) {
  if (!request || typeof request !== "object") return "";
  const messages = Array.isArray(request.messages) ? request.messages : null;
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && msg.role === "user") {
      const text = messageText(msg).trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

// Classifier question building - ISOLATED HERE so a signature mismatch with
// the upstream-experimental ClassifierQuestion shape is fixable in one place.
// The DOCUMENTED codemode-script context shape is
//   ClassifierContext = { state: Record<string,unknown>,
//                         questions: Record<string, ClassifierQuestion> }
// and the extension-side call is assumed to mirror it: classify(model, context).
// One question: the request's user-message text with two route choices.
function buildClassifierContext(userText) {
  const questions = {};
  questions[ROUTE_QUESTION_ID] = {
    prompt: userText,
    choices: [CHOICE_COMPLEX, CHOICE_LIGHT],
  };
  return { state: {}, questions: questions };
}

// One classify call under a bounded timeout; the losing race branch never
// becomes an unhandled rejection (a shadow no-op catch swallows it). ANY
// throw/abort/odd result degrades to null (fail-open to primary).
async function classifyAnswer(ctx, classifierModel, userText) {
  const registry = ctx && typeof ctx === "object" ? ctx.modelRegistry : null;
  if (!registry || typeof registry.classify !== "function") return null;
  try {
    const call = Promise.resolve(
      registry.classify(classifierModel, buildClassifierContext(userText))
    );
    call.catch(function () {});
    const timeout = new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ __sigilTimeout: true });
      }, CLASSIFY_TIMEOUT_MS);
    });
    const settled = await Promise.race([call, timeout]);
    if (!settled || settled.__sigilTimeout) {
      warnOnce("classify-timeout", "classify did not settle within " + CLASSIFY_TIMEOUT_MS + "ms - failing OPEN to primary");
      return null;
    }
    return topAnswer(settled);
  } catch (e) {
    warnOnce("classify-threw", "classify failed (" + (e && e.message ? e.message : String(e)) + ") - failing OPEN to primary");
    return null;
  }
}

// Top classifier answer: ClassifierResult.answers is a per-question record
// keyed by the router's single question id. Returns { choice, confidence } or
// null (fail-open). confidence defaults to 0 when absent (below any positive
// floor); an errorMessage result is unusable by construction.
function topAnswer(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.errorMessage === "string" && result.errorMessage.length > 0) return null;
  const answers = result.answers;
  if (!answers || typeof answers !== "object") return null;
  const answer = answers[ROUTE_QUESTION_ID];
  if (!answer || typeof answer !== "object") return null;
  if (typeof answer.choice !== "string" || answer.choice.length === 0) return null;
  let confidence = 0;
  if (typeof answer.confidence === "number" && !isNaN(answer.confidence)) {
    confidence = answer.confidence;
  }
  return { choice: answer.choice, confidence: confidence };
}

// The routing decision itself (order pinned by SigilVirtualRouterExtensionTest):
// any doubt -> failOpen (the primary or its fallbacks); "complex" -> primary,
// falling back to failOpen when the configured primary itself is unresolvable
// (primary is null exactly then - never route {model: null} while a fail-open
// model is available); otherwise -> light, but ONLY when light was resolvable
// (else failOpen).
function routedModelForAnswer(answer, minConfidence, primary, light, failOpen) {
  if (!answer) return failOpen;
  if (!(answer.confidence >= minConfidence)) return failOpen;
  if (answer.choice === CHOICE_COMPLEX) return primary || failOpen;
  return light || failOpen;
}

async function decideRoute(request, ctx) {
  // Per-call config read - the live-apply contract (T10).
  const routing = loadRoutingConfig();
  const primary = routing && routing.primary ? resolveModel(ctx, "chat", routing.primary) : null;
  const failOpen = primary || fallbackPrimaryModel(request, ctx);
  if (!routing || !routing.enabled || !failOpen) {
    // Fail-open: config absent/malformed, routing disabled, or no primary
    // resolvable AT ALL (never light, never throw). failOpen may only be null
    // when even the last-resort probes found nothing.
    return failOpen;
  }
  if (!routing.light) {
    // No usable light config - a working router could only ever return primary;
    // short-circuit to fail-open (one classifier call saved, same result).
    return failOpen;
  }
  const light = resolveModel(ctx, "chat", routing.light);
  if (!light) return failOpen;
  const classifier = resolveModel(ctx, "classifier", routing.classifier);
  if (!classifier) return failOpen;
  const userText = userMessageText(request);
  if (!userText) return failOpen;
  const answer = await classifyAnswer(ctx, classifier, userText);
  return routedModelForAnswer(answer, routing.minConfidence, primary, light, failOpen);
}

async function routeRequest(request, ctx) {
  let model = null;
  try {
    model = await decideRoute(request, ctx);
  } catch (e) {
    // The decision pipeline itself must NEVER throw into pi's model resolution.
    warnOnce("route-threw", "route failed (" + (e && e.message ? e.message : String(e)) + ") - failing OPEN to the primary");
    model = fallbackPrimaryModel(request, ctx);
  }
  if (!model) {
    warnOnce(
      "no-model",
      "no primary/fallback model resolvable - returning null (the turn will fail; fix routing.primary in .pi/virtual-routing.json)"
    );
  }
  return { model: model };
}

export default function (pi) {
  if (typeof pi.registerVirtualModel !== "function") {
    warnOnce("no-api", "pi.registerVirtualModel unavailable - virtual routing inactive (pi pre-0.99.0?)");
    return;
  }
  pi.registerVirtualModel({
    provider: "sigil",
    id: "sigil-router",
    name: "Sigil Router (routed)",
    route: async function (request, ctx) {
      return routeRequest(request, ctx);
    },
  });
  console.log(
    "[sigil-virtual-router] virtual model " + VIRTUAL_MODEL_PROVIDER + "/" + VIRTUAL_MODEL_ID +
      " registered - routing config re-read per route call from .pi/virtual-routing.json" +
      " (default OFF: disabled/unconfigured routes fail OPEN to the primary)"
  );
}
