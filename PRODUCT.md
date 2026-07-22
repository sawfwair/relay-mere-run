# PRODUCT.md — mere.run node

register: product

## Product purpose

**mere.run node** is a cross-platform desktop app (Tauri + React) that turns any
machine with `mere.run` installed into a **generation node** for the mere.run
relay. It signs in through mere.world (OAuth device-authorization grant),
connects to `wss://relay.mere.run/agent`, advertises the models the machine has,
and services generation jobs by driving local `mere.run`. Every approved machine
joins that account's agent **pool**; the relay spreads jobs across them.

It is a quiet, always-on utility. The operator sets it up once, then it lives in
the background contributing compute. The console exists to answer three
questions at a glance: *Am I connected? What is my machine doing right now? Is
anything wrong?*

## Users

Technically fluent operators running local AI: developers, ML tinkerers, and
small teams pooling GPUs across Apple Silicon / x86+CUDA / arm64+CUDA boxes.
They understand models, relays, and tokens. They do not want hand-holding; they
want a trustworthy, legible status readout and fast controls. They glance at it,
not stare at it.

## Tone & brand

- Name is always lowercase: **mere.run node**. Calm, precise, technical without
  being cold. The README's own words: "a calm dashboard."
- Confident and quiet. No marketing gloss, no celebratory confetti. The product
  earns trust by being legible and honest about state (including failures).
- Monospace is part of the identity: codes, model names, agent ids, job ids, and
  logs are machine facts and should read as such.

## Strategic principles

1. **State legibility over decoration.** Connection status, current work, and
   errors must be unmistakable in a half-second glance.
2. **Honest about failure.** Failed jobs and auth errors are first-class, never
   hidden or softened into ambiguity.
3. **Calm by default, alive when working.** Idle is still and quiet; active work
   (live jobs, streaming logs) is where subtle motion and color earn their place.
4. **Operator controls are immediate.** Start / stop / sign-in are always
   reachable and never ambiguous about their current effect.

## Anti-references

- Not a neon-on-black "AI inference" console. The category reflex is dark + cyan
  glow; we go the other way: bright, calm, daylight workspace tool.
- Not generic SaaS-cream Linear clone either. Warm paper neutrals + a committed
  violet + mono machine-facts give it its own identity.
- No hero-metric dashboards, no identical card grids, no gradient text, no
  glass.
