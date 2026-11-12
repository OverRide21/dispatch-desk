# Dispatch Desk

Dispatch Desk is a browser voice and text workspace for changing wholesale orders in Hindi and Marathi. The desk uses the order’s current line items and fulfillment status. A confirmed quantity change is saved with the operator and timestamp. Shipped lines are locked.

## Start locally

Use Node.js 24 or newer. Copy `.env.example` to `.env.local` for a fresh installation, then configure `DISPATCH_ADMIN_USERNAME` and `DISPATCH_ADMIN_PASSWORD`. Use a unique password of at least 12 characters. Add a distinct `DISPATCH_OPERATOR_USERNAME` and `DISPATCH_OPERATOR_PASSWORD` pair if an operator needs call access without import permission.

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [Dispatch Desk](http://127.0.0.1:3000) and sign in. For a production-mode run, use `npm.cmd run build` followed by `npm.cmd start`. Set `GNANI_API_KEY` to enable microphone calls with Prisma transcription and Timbre playback. Allow microphone access in your browser. Remote browser microphone access requires HTTPS. [Gnani API quickstart](https://docs.gnani.ai/api/introduction/quick-start)

For a local walkthrough, set `DISPATCH_LOCAL_ACCESS=1` in `.env.local` and restart. On the loopback address, Dispatch Desk opens as **Local operator** and records confirmed edits under that name. Hosted workspaces use administrator and operator sign-in.

Choose Marathi, Hindi, or English using the language selector on the order screen. The desk uses that language to listen and reply until you select another one. You can change the language during a call from the same selector.

Use **Add item** on the order ticket to enter a name, quantity, and unit, or use **Remove** on an editable line. Review and confirm each change to save it. You can also say or type a request such as “Add two boxes of green tea” or “Remove green tea.” Adding a new item by conversation requires an explicit quantity and unit. Shipped items stay locked, and the change log keeps a record of confirmed additions and removals.

## Run the grocery storefront

1. Set `DISPATCH_STOREFRONT_ENABLED=1` in `.env.local` and restart the app. Enable this setting on a deployed workspace only when it is ready to accept guest orders.
2. Open **Catalog and stock** as an administrator or local operator. Add a product with a SKU, category, selling unit, and INR price, then choose **Add stock**. For a starter catalog, run `node scripts/seed-shop.mjs` with the app running on port 3000 and `DISPATCH_LOCAL_ACCESS=1`. This adds eight sample products and their initial stock once. To offer a substitute during a call, create the alternate product first and select it when editing the original product.
3. Choose **Open storefront** to browse Kirana Market, filter by category, and add products to the cart. Place an order with your name. Checkout reserves stock and gives you an order reference and a link back to Dispatch Desk.
4. Open the new order in Dispatch Desk. Confirmed changes reserve or release stock from the same catalog, and the storefront reflects the new availability. CSV, Excel, and JSON imports can still create orders with their own line-level stock data.

New storefront items are scheduled to ship individually after a random delay of two to five minutes. Typing a request, editing an item, or starting a voice call pauses shipping for the whole order. An inactive hold expires after one minute. The running local server processes scheduled shipments. For a serverless deployment, run `node scripts/run-shipping.mjs` as a persistent worker with the same Turso credentials as the app.

For a quick walkthrough, add 12 bags of rice and eight bags of millet, mark millet as an approved substitute for rice, then buy eight bags of rice in the storefront. Ask the desk to make it 15 bags. It can offer the 12 available bags of rice and three bags of millet. Both quantities are reviewed before confirmation.

## Import orders

1. Sign in as an administrator and open **Import orders**. Download a blank CSV, Excel, or JSON template, or upload an export from your order system.
2. For Excel, choose a worksheet. For CSV and Excel, map source columns to the required fields if the headers differ. Select **Preview import** and review new, updated, and unchanged orders, conflicts, and any row errors.
3. Select **Confirm import**, then search by order reference or customer to open a call. A preview expires after 30 minutes. Upload again if it expires or the order changes before you confirm.

| Field | Required | Notes |
| --- | --- | --- |
| Order ID, Customer, Line ID | Yes | Use stable IDs from your order system. Line IDs are unique within an order. Format IDs as text in Excel to preserve leading zeros. |
| Item name, SKU | At least one | Add both if available. The desk recognizes names and SKUs during calls. |
| Quantity, Unit | Yes | Quantity is a whole number from 0 to 1,000,000. Use the unit you want callers to hear. |
| Fulfillment status | Yes | Use `pending` or `shipped`. |
| Aliases, Item name (Hindi), Item name (Marathi) | No | Add local product names or spoken variants for recognition. Separate aliases with `\|` in a spreadsheet or use an array in JSON. |
| Available quantity, Backorder allowed, Substitute SKU, Backorder quantity | No | Available quantity is the total that can be fulfilled for this order line. Use `0` for out of stock. Set Backorder allowed to yes for eligible lines. An approved substitute must be a different SKU on the same order with the same unit and its own available quantity. It can start with a quantity of zero. |
| Fulfillment stage, Picked at, Packed at, Shipped at, Delivery ETA, Edit cutoff at | No | Stages are `pending`, `picked`, `packed`, and `shipped`. Use ISO timestamps with a time zone or Excel date cells. For example, `2027-01-18T16:30:00+05:30`. The line locks when it is packed, shipped, or reaches its edit cutoff. |

CSV files use UTF-8. Excel uploads use `.xlsx` with plain values, one line item per row, and a header row. Save formula results as values before uploading. JSON accepts a versioned object shaped like `{ "version": 1, "orders": [] }`. Each order has `id`, `customer`, and `items`. Each item has `id`, `name` or `sku`, `quantity`, `unit`, and `status`, with optional `aliases`, `nameHi`, and `nameMr`. A flat JSON array may instead use `orderId`, `customer`, `lineId`, and the same item fields. Each import accepts up to 2,000 orders and 5,000 line items. The file limit is 4 MiB on Vercel and 5 MiB locally. Tabular files can have up to 40 columns.

Matching order and line IDs update existing records. New IDs add records and omitted lines are retained. Identical reuploads are unchanged. Shipped-line edits, conflicting duplicates, and stale previews require review before a new import can commit. A commit writes the whole batch in one transaction.

Blank stock and shipment fields preserve saved metadata on reimport. To clear an available quantity, substitute SKU, edit cutoff, or delivery estimate, enter `(clear)` in a spreadsheet or use `null` for the JSON field. Set Backorder allowed to no to stop accepting new backorders.

## Work with stock, shipments, and receipts

- When a request exceeds imported stock, the desk offers the available quantity, a backorder if allowed, or the approved substitute if it has enough stock. Pick or say one of the available options, review the proposal, and confirm it. Substituting the shortfall updates both lines in one transaction.
- Expand **Shipment timeline** on the order ticket to see recorded milestones, edit cutoffs, and delivery estimates. The desk can answer delivery questions from the imported estimate.
- Open **Change receipts** after confirming an edit. A receipt records the before-and-after quantities, backorders, blocked requests, operator, and time. Open the receipt in English plus Hindi or Marathi and use the browser’s print command to print or save a PDF.
- Expand **Voice usage** on the order list to see workspace totals. Administrators can set separate daily limits for transcription seconds and playback characters. An open call also shows its own usage. Limits reset at midnight UTC. These are submitted usage units and may differ from the provider’s billed credits.

## Deploy and operate

- On Vercel, connect a Turso database that supplies `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Configure the hosted admin credentials and exact production origin in the project environment. Local Ollama is available when running Dispatch Desk on the same computer as Ollama. Hosted replies can use Groq and the built-in wording.
- For self-hosting, run one Node process per workspace. Use a stable `DISPATCH_WORKSPACE_ID` and point `DISPATCH_DB_PATH` at a persistent, access-controlled volume. The local default is `.dispatch/dispatch.sqlite`.
- Serve the app behind an HTTPS reverse proxy and set `DISPATCH_PUBLIC_ORIGIN` to its exact public origin. This enables secure session cookies. Inject credentials from the host’s secrets store and restrict database, backup, and log access to operators who need it. Changing the account configuration invalidates existing sign-ins.
- Use the database provider’s backup and recovery controls on Vercel. For self-hosting, schedule encrypted, access-controlled SQLite backups using SQLite’s online backup API, or stop the app cleanly before taking a database snapshot. To recover a self-hosted database, stop the app, move the existing database and any `-wal` and `-shm` files to a recovery directory, restore a consistent snapshot to the configured path, and verify the order list and change history after restart.
- Collect server logs and alert on repeated `dispatch_operation_failed` events. They include operation names and statuses. Raw uploads and call content are excluded from these events. Committed import records retain the actor, time, and affected order references. Quantity changes are visible in the order’s history.
- Call state and transcripts are stored in the configured database. A call expires after two hours without a completed turn. Signing out removes that browser session’s calls, and expired calls are removed when a new call opens. Orders and committed changes are retained.
- Gnani receives audio for transcription and reply text for synthesis when voice is used. These can contain customer or order details. With optional Ollama styling enabled, caller text and reply text are sent to the locally configured Ollama endpoint. Choose an endpoint you control and apply your organization’s data handling requirements before using real orders.

## Choose a reply provider

Use **Reply provider** above the conversation. **Fast · Local order engine** is the default and processes replies without a model call. The conversation shows the elapsed time for the last typed reply. Fast voice sends audio and receives the resulting order reply in one request. Gnani transcription and audio synthesis still add provider latency.

Use **Interpretation → LLM · selected model** with Groq, local Qwen, or Hari to let the model identify what the caller is asking. The model proposes a structured action and the desk checks units, stock, shipping, and confirmation before saving anything. The desk asks for clarification when the request is ambiguous. Groq interpretation sends the request text and relevant order line details to Groq. Select **Built-in parser** for the quickest response or for long orders that exceed the interpretation context limit.

Set `SARVAM_API_KEY` or `GROQ_API_KEY` in `.env.local` and restart to enable **Automatic routing**, the default for sessions without a saved provider preference. Clear shipment, stock, and delivery questions use the order data directly. Sarvam 105B interprets other requests when configured. Groq handles interpretation when Sarvam is unavailable and a Groq key is configured. Both hosted models receive the transcript and relevant order line details. Confirmations, stock options, and order writes run in Dispatch Desk. The same routing applies to typed and microphone turns.

Set `GROQ_API_KEY` in `.env.local` and restart to enable Groq Qwen 3.8 27B. Groq selects from approved lines using generic wording and the selected language. The desk uses its own wording if Groq takes more than 160 ms. For local styling, start Ollama, run `ollama pull qwen3.5:4b`, set `OLLAMA_ENABLED=1`, and restart the app. Selecting a local model starts warm-up and shows a ready message when it can reply. While the order page is open, the desk renews the selected model’s Ollama keep-alive every minute. When you leave or switch providers, the previous model can expire normally. [Ollama for Windows](https://ollama.com/download/windows)

To try **Local · Hari 4B (8-bit)**, import the Q8 GGUF into Ollama as `hari:q8` and set `OLLAMA_HARI_ENABLED=1` alongside `OLLAMA_ENABLED=1` in `.env.local`. Select it from **Reply provider** on an open order. Hari chooses from vetted proposals, clarifications, and polite redirects in the call’s language. The desk checks quantities, units, and shipment status before it offers a change. A Hari turn waits up to 45 seconds for Ollama, including time to load the model. If Hari fails, resubmit the turn. The desk saves the turn and any confirmed edit after Hari responds successfully.

## Verify

```powershell
npm.cmd test
```

Tests cover Hindi and Marathi dialogue, sign-in and permissions, CSV/Excel/JSON imports, order revision conflicts, shipped-line locks, persistence, and mocked Gnani speech requests. See [the implementation plan](IMPLEMENTATION.md) for the work breakdown.
