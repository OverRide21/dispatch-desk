# Dispatch Desk implementation plan

Build a browser voice desk for changing an existing wholesale order. The first prototype walkthrough exercised an editable item and an item that had already shipped. The caller can use Hindi or Marathi, correct a quantity, and confirm the allowed change. The order screen shows the result.

The initial prototype used Node.js 24, native HTTP and Fetch, vanilla HTML/CSS/JavaScript, and fictional order data. The Next.js App Router and React implementation uses Qwen3.5 4B through Ollama for optional local reply styling. Gnani Prisma and Timbre continue to handle live speech. The server owns order state and dispatch rules. Text calls work without speech credentials.

| Part | Owner | Completion check |
| --- | --- | --- |
| 1. Order data and conversation logic | Order agent | Handles lookups, edits, blocked lines, corrections, confirmations, and duplicate requests with isolated session state. |
| 2. Gnani audio and interruption | Audio agent | Real provider requests, browser recording and playback, interruption recovery, clear configuration and failure states. |
| 3. Call and order interface | Interface agent | Responsive call controls, bilingual turns, order items, pending change, and update history. |
| 4. Integration and launch | Main agent | Stable HTTP contracts, startup, environment template, fixture-backed prototype, setup instructions. |
| 5. Dialogue coverage and verification | Main agent | Varied fictional Hindi and Marathi scenarios, order invariants, browser walk-through, and separate checks for provider and local behavior. |

The first complete walkthrough requests changes to rice and shipped sugar, corrects the rice quantity, and confirms. The server applies only the confirmed rice quantity. A second walkthrough uses cancellation, ambiguous input, and a repeat confirmation to verify the order stays consistent.

## Implementation record

- [x] Order logic, isolated sessions, and server-side dispatch rules.
- [x] Gnani transcription and streaming synthesis, automatic language selection, and browser playback interruption.
- [x] Responsive call workspace, bilingual practice prompts, pending edit, and order history.
- [x] Local startup, environment template, and prototype walkthrough.
- [x] 200 bilingual dialogue cases and four test suite or integration checks. Chrome passed the text walkthrough at desktop and mobile widths. The integrated browser voice walkthrough used a simulated microphone and local Gnani mock to verify interruption, language switching, and save.
- [x] Live provider smoke test used two short requests. Timbre returned 1.76 seconds of Marathi audio, and Prisma transcribed it to a ten-bag rice edit. The real transcript went through the order workflow and changed the order only on confirmation.

The live provider test used synthesized audio. The browser voice test used a simulated input stream. Actual room noise, a physical microphone, and perceived conversational naturalness can be assessed during the a physical-microphone walkthrough.

## Next.js migration, local Qwen, and redesign

Three independent workstreams own the App Router API and integration tests, the Ollama adapter and tests, and the React interface. Integration, production build, browser verification, and cutover follow after the three workstreams meet their contracts.

### 6. Migrate the web app to Next.js

- [x] Scaffold the Next.js App Router on the Node.js runtime. Port the call desk, transcript, order record, and change log to React.
- [x] Move the session, turn, reset, transcription, and synthesis endpoints to App Router route handlers. Preserve the API contracts, isolated prototype sessions, and audio streaming. Use session revisions to reject confirmations from stale tabs.
- [x] Reuse browser microphone capture, streaming playback, and interruption handling from the React client. Keep the AudioWorklet available as a public asset.
- [x] Run the 200 bilingual cases and repeat the desktop, mobile, reset, and mock voice interruption walkthroughs. The production build and design review passed. Next.js now owns startup, and the vanilla entry point and custom HTTP server were removed.

References: [Next.js route handlers](https://nextjs.org/docs/app/getting-started/route-handlers) and [server and client components](https://nextjs.org/docs/app/getting-started/server-and-client-components).

### 7. Evaluate and integrate local Qwen3.5 4B

- [x] Install Ollama and evaluate `qwen3.5:4b` on existing Hindi and Marathi transcripts. In the initial 20-case decision test, the model got the action, item, and quantity right in 8 cases with thinking off. Five selected reruns with thinking on reached the token limit before providing a final answer. These results set the scope for the local integration.
- [x] Add a server-side adapter that asks Ollama to select a vetted acknowledgment in the caller's language, or leave the reply as is. The order engine supplies the full authoritative reply and retains control of intent, quantities, confirmations, shipped-item restrictions, and writes.
- [x] Keep rule-based replies available when Ollama is disabled, warming up, unavailable, too slow, or returns invalid output. The app warms Qwen in the background and bounds each interactive request to 1.8 seconds.
- [x] Verify local styling through the running Next.js server. Warm Marathi and Hindi calls returned Ollama acknowledgments in about 0.32 seconds each and the corrected quantity saved only after explicit confirmation. Browser voice was verified with a simulated microphone and mock Gnani. No Gnani credits were used.

When Kaggle TPU access is available, evaluate Qwen3.8 27B on the same bilingual decision cases before deciding how to integrate it. The current app uses local Ollama.

References: [Qwen3.5 4B for Ollama](https://ollama.com/library/qwen3.5:4b) and [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

### 8. Redesign Dispatch Desk around the voice call

- [x] Review the electric dark and warm dispatch directions with the user. The user chose warm dispatch with cream, vivid coral, and printed order tickets.
- [x] Put call controls first on the order screen. The coral call stage prioritizes the microphone when voice is available and highlights typed input when voice is unavailable.
- [x] Add ready, listening, processing, speaking, interrupted, and microphone error states. Pair the waveform and color changes with readable labels. Keep typed input close to the transcript.
- [x] Show the before and after quantities on the order ticket, distinguish shipped items, and reveal the saved result and change history after confirmation. A mobile shortcut links to the pending or saved ticket.
- [x] Verify the design in Chrome at desktop and mobile sizes with Hindi and Marathi dialogue and a complete mocked voice call. The independent review passed after fixes to first-viewport text access, text-only action hierarchy, and input contrast. Focus styling and reduced-motion support are included.

### 9. Make Dispatch Desk ready for real orders

The production workflow starts with an empty order list. An administrator imports and reviews orders. A signed-in administrator or operator can open an order for a voice or text call. Confirmed changes update the stored order and appear in its audit history.

#### Order data and access

- [x] Store orders, line items, import jobs, and change history in a durable database. Keep conversation state separate from the order. Use transactional writes and order revisions so an import, another operator, or a dispatch update cannot silently replace a pending change.
- [x] Add sign-in and workspace-scoped permissions for order lookup, imports, and edits. Check access on the server for every operation, including choosing which order a caller or operator can open.
- [x] Replace the fixed order and product list with an order picker and a search by order reference. Use the selected order's actual item names, SKUs, units, quantities, and dispatch status. Recheck dispatch status and the order revision before saving a confirmed edit.

#### File import

- [x] Accept **UTF-8 CSV (`.csv`), Excel workbooks (`.xlsx`), and JSON (`.json`)**. Provide blank downloadable templates and document the field mappings. Normalize all three into one versioned order schema with stable order and line IDs, customer reference, item name or SKU, quantity, unit, and fulfillment status.
- [x] Let the operator choose a worksheet or map CSV/Excel columns when the source headers differ. Show a preview with counts for new, updated, unchanged, and invalid records. Report row or record errors with a clear reason before saving.
- [x] Define explicit create and update behavior. Use stable IDs to detect duplicates and make reuploads safe. Require review of conflicts, especially shipped lines and orders changed since the preview. Apply the confirmed import transactionally and keep a record of who imported it, when, and which orders changed.
- [x] Enforce file and row limits, validate the file contents on the server, and treat spreadsheet cells as data without executing formulas or macros. Keep raw files and customer details out of routine logs.

#### Remove prototype affordances and verify rollout

- [x] Remove prototype terminology from the live UI, error messages, help text, and production docs. Remove the sample-call and reset controls, retire the prototype reset endpoint, and replace the seeded order with empty, loading, and no-results states. Keep fictional fixtures in automated tests.
- [x] Document import permissions, field mappings, backups and recovery, and which call data goes to speech or model providers. Add monitoring for failed imports, failed saves, and provider errors, with limits on access to customer data.
- [x] Verify the full production workflow with an empty database. Automated checks cover all three formats, invalid rows, repeated imports, stale revisions, shipped lines, and unauthorized access. Chrome verified sign-in, empty state, CSV preview and commit, order lookup, a Marathi request and Hindi correction, and the saved result after a server restart. Checked desktop and mobile layouts. A second Chrome run imported JSON and exercised microphone capture, bilingual playback and interruption, and confirmation using simulated audio and a local speech provider mock.

The rollout targets one long-lived Node process with SQLite on a persistent volume and one configured workspace per deployment. Hosting, HTTPS, backup scheduling, and log alerts are configured on the deployment host.

### 10. Stock, fulfillment, receipts, and voice budgets

| Workstream | Completion check |
| --- | --- |
| Order decisions | Offer available stock, authorized backorders, and approved substitutes in the call language. Each option requires explicit confirmation. Packed, shipped, and cutoff locks are checked before proposing and again before saving. |
| Import and storage | Import optional stock and shipment metadata in all three formats, preserve existing orders, save substitute changes atomically, and store a receipt with each confirmed change. |
| Voice budgets | Meter submitted audio duration and playback characters, reserve daily capacity atomically, and give administrators a budget control. |
| Integration and verification | Connect stock options, milestones, receipt history, and voice usage to the existing workspace. Verify imports, confirmations, printing, and quota failures with isolated test data. |

### 11. Connect the storefront and dispatch desk

- Catalog and inventory persist product details, additive restocks, and available stock. Checkout and confirmed edits reserve or release stock in the same database transaction as the order.
- The buyer storefront shows available products, accepts a cart, and returns an order reference that opens the signed-in call workspace.
- Administrators manage products and add stock in the existing workspace. Imported orders continue to use their line-level inventory data.
- Verification covers permissions, checkout retry, concurrent stock claims, an open call reacting to a later sale, and a substitute update reflected in the storefront.
