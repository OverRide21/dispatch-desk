# Dispatch Desk

Dispatch Desk is a browser voice and text workspace for changing wholesale orders in Hindi and Marathi. The desk uses the order’s current line items and fulfillment status. A confirmed quantity change is saved with the operator and timestamp. Shipped lines are locked.

## Start locally

Use Node.js 24 or newer. Copy `.env.example` to `.env.local` for a fresh installation, then configure `DISPATCH_ADMIN_USERNAME` and `DISPATCH_ADMIN_PASSWORD`. Use a unique password of at least 12 characters. Add a distinct `DISPATCH_OPERATOR_USERNAME` and `DISPATCH_OPERATOR_PASSWORD` pair if an operator needs call access without import permission.

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [Dispatch Desk](http://127.0.0.1:3000) and sign in. For a production-mode run, use `npm.cmd run build` followed by `npm.cmd start`. Set `GNANI_API_KEY` to enable microphone calls with Prisma transcription and Timbre playback. Allow microphone access in your browser. Remote browser microphone access requires HTTPS. [Gnani API quickstart](https://docs.gnani.ai/api/introduction/quick-start)

Choose Marathi, Hindi, or English using the language selector on the order screen. The desk uses that language to listen and reply until you select another one. You can change the language during a call from the same selector.

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

CSV files use UTF-8. Excel uploads use `.xlsx` with plain values, one line item per row, and a header row. Save formula results as values before uploading. JSON accepts a versioned object shaped like `{ "version": 1, "orders": [] }`. Each order has `id`, `customer`, and `items`. Each item has `id`, `name` or `sku`, `quantity`, `unit`, and `status`, with optional `aliases`, `nameHi`, and `nameMr`. A flat JSON array may instead use `orderId`, `customer`, `lineId`, and the same item fields. Each import accepts up to 5 MiB, 2,000 orders, and 5,000 line items. Tabular files can have up to 40 columns.

Matching order and line IDs update existing records. New IDs add records and omitted lines are retained. Identical reuploads are unchanged. Shipped-line edits, conflicting duplicates, and stale previews require review before a new import can commit. A commit writes the whole batch in one transaction.

## Deploy and operate

- Run one long-lived Node process per workspace. Use a stable `DISPATCH_WORKSPACE_ID` and point `DISPATCH_DB_PATH` at a persistent, access-controlled volume. The local default is `.dispatch/dispatch.sqlite`.
- Serve the app behind an HTTPS reverse proxy and set `DISPATCH_PUBLIC_ORIGIN` to its exact public origin. This enables secure session cookies. Inject credentials from the host’s secrets store and restrict database, backup, and log access to operators who need it. Changing the account configuration invalidates existing sign-ins.
- Schedule encrypted, access-controlled SQLite backups using SQLite’s online backup API, or stop the app cleanly before taking a database snapshot. For recovery, stop the app, move the existing database and any `-wal` and `-shm` files to a recovery directory, restore a consistent snapshot to the configured path, and verify the order list and change history after restart.
- Collect server logs and alert on repeated `dispatch_operation_failed` events. They include operation names and statuses. Raw uploads and call content are excluded from these events. Committed import records retain the actor, time, and affected order references. Quantity changes are visible in the order’s history.
- Call state and transcripts live in server memory for the active session. A restart requires reopening the order. The order and its committed changes persist.
- Gnani receives audio for transcription and reply text for synthesis when voice is used. These can contain customer or order details. With optional Ollama styling enabled, caller text and reply text are sent to the locally configured Ollama endpoint. Choose an endpoint you control and apply your organization’s data handling requirements before using real orders.

## Optional local reply styling

With [Ollama](https://ollama.com/download/windows) running, run `ollama pull qwen3.5:4b`, set `OLLAMA_ENABLED=1`, and restart the app. Qwen chooses from vetted acknowledgments in the caller’s language. The order engine validates edits and generates the order details and confirmation. If Ollama is unavailable or slow, the desk uses its standard wording.

## Verify

```powershell
npm.cmd test
```

Tests cover Hindi and Marathi dialogue, sign-in and permissions, CSV/Excel/JSON imports, order revision conflicts, shipped-line locks, persistence, and mocked Gnani speech requests. See [the implementation plan](IMPLEMENTATION.md) for the work breakdown.
