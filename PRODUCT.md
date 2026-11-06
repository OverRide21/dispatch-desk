# Dispatch Desk

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Next.js App Router and React on Node.js 24 serve a responsive browser app with SQLite storage. Native browser audio APIs handle capture and playback. Ollama with Qwen3.5 4B can style local replies.

## Users
Wholesale dispatch administrators import order records. Signed-in operators open an order and handle quantity changes with Hindi- or Marathi-speaking callers, including kirana shop owners.

## Product purpose
Complete an allowed order change during a short Hindi or Marathi conversation. Explain dispatch restrictions, keep track of corrected quantities, and update the order after explicit confirmation.

## Operating context
Administrators start with an empty workspace and upload orders from their order system. The workspace shows live order details, fulfillment state, the active conversation, and the committed change history. Gnani provides voice when configured. The typed path uses the same order logic.

## Product principles
- Read the order state before proposing an action.
- Speak in short turns and acknowledge corrections.
- Make pending and saved changes easy to distinguish.
- Restrict access to order data and track committed changes.
