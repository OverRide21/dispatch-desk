# Dispatch Desk implementation plan

Build a browser voice desk for changing an existing wholesale order. The demonstration order includes both an editable item and an item that has already shipped. The caller can use Hindi or Marathi, correct a quantity, and confirm the allowed change. The order screen shows the result.

The completed prototype uses Node.js 24, native HTTP and Fetch, vanilla HTML/CSS/JavaScript, and fictional order data. The target stack is Next.js with the App Router and React, with Qwen3.5 4B running locally through Ollama as an optional conversation model. Gnani Prisma and Timbre continue to handle live speech. The server owns order state and dispatch rules. The text and sample-call path remains usable without speech credentials.

| Part | Owner | Completion check |
| --- | --- | --- |
| 1. Order data and conversation logic | Order agent | Handles lookups, edits, blocked lines, corrections, confirmations, and duplicate requests with isolated session state. |
| 2. Gnani audio and interruption | Audio agent | Real provider requests, browser recording and playback, interruption recovery, clear configuration and failure states. |
| 3. Call and order interface | Interface agent | Responsive call controls, bilingual turns, order items, pending change, and update history. |
| 4. Integration and launch | Main agent | Stable HTTP contracts, startup, environment template, fixture-backed demo, setup instructions. |
| 5. Dialogue coverage and verification | Main agent | Varied fictional Hindi and Marathi scenarios, order invariants, browser walk-through, and separate checks for provider and local behavior. |

The first complete walkthrough requests changes to rice and shipped sugar, corrects the rice quantity, and confirms. The server applies only the confirmed rice quantity. A second walkthrough uses cancellation, ambiguous input, and a repeat confirmation to verify the order stays consistent.

## Implementation record

- [x] Order logic, isolated sessions, and server-side dispatch rules.
- [x] Gnani transcription and streaming synthesis, automatic language selection, and browser playback interruption.
- [x] Responsive call workspace, bilingual sample prompts, pending edit, and order history.
- [x] Local startup, environment template, and demo walkthrough.
- [x] 200 bilingual dialogue cases and four test suite or integration checks. Chrome passed the text walkthrough at desktop and mobile widths. The integrated browser voice walkthrough used a simulated microphone and local Gnani mock to verify interruption, language switching, and save.
- [x] Live provider smoke test used two short requests. Timbre returned 1.76 seconds of Marathi audio, and Prisma transcribed it to a ten-bag rice edit. The real transcript went through the order workflow and changed the order only on confirmation.

The live provider test used synthesized audio. The browser voice test used a simulated input stream. Actual room noise, a physical microphone, and perceived conversational naturalness can be assessed during the demo rehearsal.

## Planned next phases

### 6. Migrate the web app to Next.js

- [ ] Scaffold the Next.js App Router on the Node.js runtime. Port the call desk, transcript, order record, and change log to React. Use the existing screens as a functional reference and build the redesigned interface in the new React app.
- [ ] Move the session, turn, reset, transcription, and synthesis endpoints to App Router route handlers. Preserve the request and response contracts, isolated demo sessions, and audio streaming. Keep credentials and provider calls on the server.
- [ ] Put microphone capture, playback, and interruption handling in a client component and reuse the existing browser audio modules. Keep the AudioWorklet available as a public asset.
- [ ] Run the 200 bilingual cases and repeat the desktop, mobile, reset, and mock voice interruption walkthroughs. Cut over startup and remove the vanilla entry point and custom HTTP server after these checks and the UI redesign review pass.

References: [Next.js route handlers](https://nextjs.org/docs/app/getting-started/route-handlers) and [server and client components](https://nextjs.org/docs/app/getting-started/server-and-client-components).

### 7. Evaluate and integrate local Qwen3.5 4B

- [ ] Install Ollama and download `qwen3.5:4b`. Run a representative set of the existing Hindi and Marathi transcripts locally. Measure response time and check item identification, spoken quantities, corrections, ambiguity, and language switching. Review Marathi replies for natural phrasing. This text-only evaluation can run alongside the Next.js migration and uses zero Gnani credits.
- [ ] Add an optional server-side adapter that requests structured JSON from Ollama for the proposed intent, item, quantity, and reply language. The order engine validates every proposal and retains control of confirmations, shipped-item restrictions, and writes. Build the spoken reply from the validated result, including the actual outcome of any save.
- [ ] Keep the rule-based path available when Ollama is disabled, unavailable, too slow, or returns invalid output. Compare the model's own output with the baseline before counting fallback responses as successful calls.
- [ ] Enable the local model for the demo after the tested calls handle both languages within an acceptable response time and produce zero unauthorized changes. Verify the full audio flow with mocks first, then use a small number of short Gnani requests for the final voice check. Text evaluation and local model calls use zero Gnani credits.

References: [Qwen3.5 4B for Ollama](https://ollama.com/library/qwen3.5:4b) and [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

### 8. Redesign Dispatch Desk around the voice call

- [ ] Replace the muted workspace aesthetic with a vivid visual identity. Show two directions using the actual Dispatch Desk screens and bilingual dialogue. Explore one direction with a rich dark base and bright accent, and one with a warm, saturated light palette. Review them with the user before choosing a palette or layout. Design exploration can begin alongside the Next.js migration.
- [ ] Make the call the first thing users see and can try. Give the microphone control and sample call clear prominence. Replace the sidebar-led layout with a focused call screen and an order view that comes forward when the agent proposes or saves a change.
- [ ] Design ready, listening, processing, speaking, interrupted, and microphone error states. Use color, readable labels, and a responsive audio visual to show what is happening. Keep typed input and the sample call easy to find.
- [ ] Make the order change visible during the conversation. Show the original and proposed quantities together, distinguish shipped items from editable ones, and reveal a clear saved result after confirmation. Keep the transcript and change history available throughout.
- [ ] Verify the redesign on desktop and mobile with real Hindi and Marathi copy, keyboard navigation, visible focus, sufficient contrast, reduced motion, and long transcripts. Run the complete call with mocked audio first. A first-time user should be able to find the call control, try an edit, and tell whether it has been saved without a walkthrough.
