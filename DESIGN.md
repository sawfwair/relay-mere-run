# DESIGN.md — mere.run node

A calm, bright operator console. Warm paper neutrals, one committed violet,
monospace for machine facts. Daylight workspace tool, not a neon inference rig.

## Theme

Light. Scene: an operator at their desk during the workday, glancing at their
machine's contribution status in a bright room, wanting a calm, trustworthy,
non-alarming readout that sits quietly among other professional tools. That
forces light, warm, low-contrast-but-legible.

## Color (OKLCH, color strategy: Restrained)

Tinted-violet neutrals + one committed violet accent. Status hues are functional,
not decorative. Never `#000` / `#fff`.

```
--bg:            oklch(97.6% 0.006 286);  /* page, warm paper */
--surface:       oklch(99.3% 0.003 286);  /* raised panels */
--surface-sunk:  oklch(96.2% 0.007 286);  /* inputs, log well */
--border:        oklch(91.5% 0.008 286);  /* hairlines */
--border-strong: oklch(86%   0.011 286);  /* emphasis, focus tracks */

--text:          oklch(26% 0.021 286);     /* primary */
--text-muted:    oklch(50% 0.016 286);     /* labels, meta */
--text-faint:    oklch(64% 0.012 286);     /* placeholders, hints */

--accent:        oklch(55% 0.195 286);     /* violet, primary action */
--accent-hover:  oklch(49% 0.205 286);
--accent-soft:   oklch(94% 0.035 286);     /* accent tint fields */
--accent-ring:   oklch(72% 0.13  286);     /* focus ring */

--ok:    oklch(60% 0.15 158);              /* online / done */
--warn:  oklch(70% 0.15 78);               /* connecting / started */
--err:   oklch(56% 0.20 27);               /* offline-error / failed */
--idle:  oklch(74% 0.01 286);              /* offline dot */
```

Tint backgrounds for status are the hue at ~95% L, low chroma.

## Typography

- **Sans:** `Inter, ui-sans-serif, -apple-system, "Segoe UI", sans-serif` —
  system fallback first (offline-safe); Inter if present.
- **Mono:** `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace` — all
  machine facts: codes, model names, agent/job ids, logs, the relay URL.
- Ramp (≥1.25 step contrast):
  `display 22 / h-section 11 (mono, tracked, uppercase) / body 14 / meta 12.5 / micro 11`.
- Section headers are uppercase mono micro-labels with letter-spacing — they read
  as instrument labels, not headings.

## Layout

- App is a single calm column, generous top breathing room, max-width ~960px.
- A **status bar** (not a header card) spans the top: live state dot + identity +
  primary action. It is the instrument cluster.
- Below: an asymmetric two-column region (not an identical card grid). Left rail
  = setup (Account, Connection). Right = live activity (Models, Jobs). Log is a
  full-width well at the bottom.
- Surfaces are flat panels separated by hairlines and spacing, minimal shadow.
  No nested cards. Vary padding for rhythm.

## Elevation

Light theme: shadows are soft and low. Panels lift ~2-4px with a faint,
violet-tinted shadow. The primary action button is the only confidently elevated
element.

## Motion

- Ease-out-expo / quart only. No bounce.
- The status dot has a slow breathing pulse when connecting, a steady soft glow
  when online, still when offline.
- New job rows and log lines enter with a short fade+rise (transform/opacity
  only, never layout properties).
- Respect `prefers-reduced-motion`.

## Components

- **Status dot:** 8-10px, hue by state, glow ring via box-shadow.
- **Buttons:** primary (filled violet, elevated), ghost (hairline), danger
  (stop = hairline red, fills on hover). 10px radius.
- **Inputs:** sunk surface, hairline, violet focus ring (no harsh outline).
- **Model summary:** capability pills + installed/relay-ready counts at a glance;
  one searchable inventory disclosure owns raw model ids and relay availability.
- **Job row:** state tag (tinted hue) + mono id + truncated prompt, hue-coded.
- **Log well:** sunk surface, mono, errors in red, info muted, auto-scroll.
- **Device code:** large tracked mono in an accent-soft field, the moment of the
  auth flow.
```
```
