---
name: Dispatch Desk
description: A voice-first wholesale order desk with a paper order ticket
colors:
  cream: "#fff1db"
  paper: "#fffaf0"
  ink: "#271710"
  muted: "#715247"
  line: "#dfc2ac"
  coral: "#ff765f"
  red: "#a62d21"
  coral-ink: "#34140f"
  coral-edge: "#8d3529"
  wash: "#fae6d6"
  pending-paper: "#ffe7ae"
  pending-ink: "#633805"
  saved-paper: "#e5eccd"
  saved-ink: "#304818"
  focus: "#95271e"
  control-line: "#b77863"
  language-peach: "#ffddcd"
  caller-peach: "#ffe4d5"
  error-peach: "#ffe2d7"
  error-ink: "#6b2016"
typography:
  display:
    fontFamily: '"Aptos Display", "Aptos", "Segoe UI", system-ui, sans-serif'
    fontSize: "clamp(2.45rem, 5.25vw, 4.55rem)"
    fontWeight: 760
    lineHeight: 0.99
    letterSpacing: "-0.04em"
  ticket-id:
    fontFamily: "Georgia, serif"
    fontSize: "clamp(1.9rem, 3vw, 2.62rem)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.035em"
  body:
    fontFamily: '"Aptos", "Segoe UI", "Nirmala UI", system-ui, sans-serif'
    fontSize: "1rem"
    lineHeight: 1.5
  indic:
    fontFamily: '"Nirmala UI", "Noto Sans Devanagari", Mangal, system-ui, sans-serif'
  turn:
    fontSize: "0.93rem"
    lineHeight: 1.47
  turn-label:
    fontSize: "0.72rem"
    fontWeight: 650
rounded:
  small: "4px"
  control: "8px"
  panel: "16px"
spacing:
  control-gap: "0.45rem"
  control-inset: "0.52rem 0.88rem"
  stage-inset: "clamp(0.95rem, 2.6vw, 1.35rem)"
  column-gap: "clamp(1rem, 2.5vw, 2rem)"
  page-gutter: "clamp(1.25rem, 5vw, 4.5rem)"
components:
  microphone:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0.52rem 1.03rem"
    height: "55px"
  button-primary:
    backgroundColor: "{colors.red}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "{spacing.control-inset}"
    height: "44px"
  button-send:
    backgroundColor: "{colors.red}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "{spacing.control-inset}"
  message-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.55rem 0.75rem"
    height: "47px"
  voice-stage:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.coral-ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.stage-inset}"
  order-ticket:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  workspace-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "clamp(1rem, 3vw, 1.65rem)"
  pending-change:
    backgroundColor: "{colors.pending-paper}"
    textColor: "{colors.pending-ink}"
    rounded: "{rounded.control}"
    padding: "0.69rem 0.72rem"
  saved-change:
    backgroundColor: "{colors.saved-paper}"
    textColor: "{colors.saved-ink}"
    rounded: "{rounded.control}"
    padding: "0.69rem 0.72rem"
---

# Design System: Dispatch Desk

## Overview

**Creative North Star: "Warm dispatch counter"**

The signed-in workspace starts with an order search on a paper panel. Selecting an order opens a coral call stage on cream, with the paper order ticket alongside it. Administrators can import orders and review the results before saving.

The transcript stays in the call column. An amber proposal shows the old and proposed quantities. Once the change is confirmed, the ticket shows the saved quantity in olive and adds an entry to the change log.

**Key Characteristics:**

- Cream canvas, coral voice stage, and paper order ticket.
- Paper panels for sign-in, order search, and import.
- A prominent waveform with explicit call state labels.
- A perforated divide between the current order and the change outcome.

## Colors

Coral marks the voice stage, while deep red marks primary actions, the wordmark badge, and agent marks. Brown ink carries the primary text, with muted brown for explanations and labels. Peach differentiates caller turns from the paper agent turns.

**The Dispatch State Rule.** Pair amber with the pending label and olive with the saved label. The order table keeps a text label for both editable and shipped items.

## Typography

Aptos Display leads the page heading, with red Georgia italic on its emphasized phrase. The order identifier is set in Georgia. Body copy uses Aptos with Segoe UI and Nirmala UI fallbacks. Hindi and Marathi text marked with the relevant language attribute uses Nirmala UI, Noto Sans Devanagari, then Mangal.

The page heading ranges from 2.45rem to 4.55rem on wider screens and from 2.22rem to 3rem at 480px and below. Transcript bubbles use 0.93rem type with a 1.47 line height. The ticket uses tabular figures for quantities and identifiers.

## Layout

The page is up to 1280px wide and centers itself with fluid side gutters. The masthead puts the wordmark on the left and the signed-in account and sign-out control on the right. On the call page, the call stage and transcript sit in a 1.45fr left column, with a 1fr ticket column at least 20rem wide.

At 780px and below, the ticket follows the conversation in one column and has a jump link from the call stage. The import mapping uses three columns on desktop, two at 780px and below, and one at 480px and below. At 480px and below, the side gutter is 0.9rem, the masthead hides the account name, and the microphone control is at least 49px high. The transcript fits its content before the first turn and then scrolls within a height of `clamp(11.1rem, 27vh, 16rem)`. Desktop viewports up to 850px tall use a shorter introduction and waveform so the ready-state composer fits on screen.

## Elevation & Depth

The stage, ticket, and workspace panels sit on the canvas with solid fills and fine outlines. Color and a dashed perforation distinguish ticket sections.

## Shapes

The stage, order ticket, and workspace panels use 16px corners. Buttons and form fields use 8px corners. Transcript bubbles use asymmetric 3px and 9px corners to indicate the speaker. The order ticket has semicircular cutouts at both ends of the dashed rule.

## Components

- **Sign-in and order search.** Paper panels hold labeled fields and full-width order rows. Each row shows the order reference, customer, and line count. Empty order lists and searches have separate guidance.
- **Import.** The administrator panel offers CSV, Excel, and JSON templates. After choosing a file, review the worksheet and column mapping when applicable. The preview labels new, updated, unchanged, and conflicting orders and shows validation errors before the save action.
- **Voice stage.** A coral field holds a state label, language selector, waveform, and microphone control. Listening and interruption respond to input level. Speaking animates the waveform. Opening the microphone, checking an order, connecting, and text support use explicit labels. The waveform is decorative for assistive technology.
- **Controls.** The microphone uses brown ink with paper text, then inverts when the call is active. Deep red marks Send, Sign in, Import orders, and Confirm change. Back to orders and Sign out use outlined controls. Keyboard focus uses a 2px red outline with 4px offset on light surfaces and brown ink on coral.
- **Transcript and composer.** Caller turns align right with a peach fill. Agent turns align left beside the dispatch mark. Every turn names its speaker. The typed input sits below the transcript. Confirm change appears when there is a pending proposal. Recoverable errors appear in a peach notice.
- **Order ticket.** The order identifier and customer precede the quantity and dispatch columns. The perforation separates the table from the proposal or saved result. The outcome shows Before and Proposed or Saved together, with a label and icon. The change log lists confirmed edits and their times.
- **Reduced motion.** The reduced-motion query shortens transitions and animations and disables smooth scrolling.

## Do's and Don'ts

- Do keep the microphone close to the call state and the typed composer below the transcript.
- Do show the import preview and validation errors before saving orders.
- Do show the previous and proposed or saved quantities together.
- Do retain text labels when color signals an order or call state.
- Don't remove language attributes from Hindi and Marathi transcript text.
