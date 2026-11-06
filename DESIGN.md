---
name: Dispatch Desk
description: Bilingual call and order workspace for wholesale order changes
colors:
  primary: "#2857bf"
  primary-hover: "#19459f"
  rail-strong: "#22344e"
  blue-bg: "#eef3ff"
  active: "#106451"
  active-bg: "#e7f5ee"
  pending-bg: "#fff6e4"
  pending-ink: "#795018"
  danger: "#8c2626"
  canvas: "#f4f6f9"
  surface: "#fff"
  ink: "#142336"
  muted: "#4e6075"
  faint: "#dce4ed"
  rail: "#17253a"
  rail-text: "#b8c7dc"
  voice-stage: "#192a44"
  button-stroke: "#cfd9e6"
  field-stroke: "#cbd7e7"
  on-rail: "#ffffff"
typography:
  headline:
    fontFamily: '"Segoe UI", "Nirmala UI", "Noto Sans Devanagari", system-ui, sans-serif'
    fontSize: "2rem"
    fontWeight: 740
    lineHeight: 1.18
    letterSpacing: "-0.036em"
  title:
    fontSize: "1rem"
    fontWeight: 700
    letterSpacing: "-0.015em"
  body:
    fontSize: "0.88rem"
    lineHeight: 1.55
  label:
    fontSize: "0.73rem"
    fontWeight: 650
rounded:
  field: "6px"
  control: "8px"
  call-stage: "10px"
  panel: "14px"
  pill: "20px"
spacing:
  inline: "8px"
  panel-inset: "20px"
  panel-gap: "22px"
  workspace-gutter: "34px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "#30465f"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  message-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 11px"
  rail-nav-selected:
    backgroundColor: "{colors.rail-strong}"
    textColor: "{colors.on-rail}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
  status-editable:
    backgroundColor: "{colors.active-bg}"
    textColor: "#15614f"
    rounded: "{rounded.pill}"
    padding: "4px 8px"
  order-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  pending-confirmation:
    backgroundColor: "{colors.pending-bg}"
    textColor: "{colors.pending-ink}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  call-stage:
    backgroundColor: "{colors.voice-stage}"
    textColor: "{colors.on-rail}"
    rounded: "{rounded.call-stage}"
    padding: "13px 15px"
---

# Design System: Dispatch Desk

## Overview

**Creative North Star: "Dispatch counter"**

A dark navigation rail frames a cool paper workspace. The call panel carries the conversation and controls, and the order record shows the evidence for the agent’s decision. The call stage uses the same navy family as navigation and gives listening and playback a distinct place on the screen.

A confirmed change is visible in the order quantity and the change log. Proposed quantities sit in an amber panel and keep their own visual status.

**Key Characteristics:**

- Navy navigation and call stage with a cool paper workspace.
- Compact type, fine borders, and line icons.
- Distinct order states with text, color, and icons.

## Colors

Dispatch blue marks the primary send action and darkens on hover. Selected navy identifies the current navigation item. Blue paper distinguishes the caller’s turns and the order-level status pill.

White panels sit on cool paper with fine rules between sections. Deep ink carries the main text, and muted slate marks secondary information. Error red appears on the recoverable error notice.

**The Dispatch State Rule.** Use amber for a change awaiting confirmation and green for an editable line or a recorded update. Keep each state legible in text.

## Typography

Segoe UI sets the interface. Nirmala UI and Noto Sans Devanagari are the next families in the font stack for characters that need them. System sans-serif is the final fallback.

- Workspace headings are compact and bold. The desktop heading is 2rem and becomes 1.65rem in the stacked layout.
- Panel headings use 1rem type with a firm weight. Turn author labels use 0.73rem type. Transcript copy uses a 1.55 line height so longer Hindi and Marathi turns can wrap.

**The Order Figure Rule.** Use tabular numerals for order identifiers and quantity columns.

## Layout

The desktop shell pairs a 208px rail with a workspace up to 1470px wide. The workspace uses a 1.38-to-1 call and order grid with a 22px gap. The call pane contains the call stage, scrollable transcript, and composer. The order column stacks the order record and change log.

At 1160px and below, the rail becomes 174px and workspace gutters narrow to 25px. At 930px, the rail moves into a horizontal masthead. At 680px, the work grid stacks, horizontal gutters become 13px, and the transcript viewport becomes 226px high. At 360px, some navigation and composer details condense.

## Elevation & Depth

The rail and call stage use tonal separation. Workspace panels have a fine stroke and a low shadow (`0 2px 6px #172c4710`). The active rail item uses an inset rule for definition.

## Shapes

Panels use a 14px radius. The call stage uses 10px, buttons and the message field use 8px, and the language selector uses 6px. Status chips use fully rounded ends. Line icons use round caps and joins.

## Components

- **Buttons and fields.** The send action uses dispatch blue. Reset uses a white fill and a fine stroke. The message field pairs with the language selector above it. Keyboard focus uses a 3px outline with a 3px offset. Dispatch blue marks focus on light surfaces, and a lighter blue marks focus on the rail and call stage.
- **Navigation.** Links pair a line icon with a text label. The current item uses the selected navy surface and inset rule. At smaller widths, links wrap within the masthead.
- **Call stage.** The stage pairs a small waveform with voice status and the call control. Speaking animates the waveform, listening changes its color, and reduced-motion preferences shorten animations and transitions.
- **Transcript.** Caller turns align right in blue paper, and agent turns align left in a light neutral surface. Each turn names its speaker and wraps within the transcript width.
- **Order record.** A compact table keeps quantity and dispatch columns distinct. Shipped rows carry a lock icon and a Shipped label. The pending area uses a dashed outline when empty and a solid amber treatment when a proposal awaits confirmation.

## Do's and Don'ts

- Do group the draft quantity and the confirmation instruction inside the pending panel.
- Do keep turn labels and the language selector visible in the call workspace.
- Do preserve the same status words in narrow layouts.
