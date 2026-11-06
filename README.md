# Dispatch Desk

A Hindi and Marathi voice desk for wholesale order changes. It keeps shipped lines locked and applies an editable change only after the caller confirms it. All customer and order records in the app are fictional.

## Run locally

Requires Node.js 24 or newer. There are no packages to install.

```powershell
npm.cmd start
```

Open http://localhost:3000. The sample buttons and text input work immediately. To enable the microphone and audio replies, copy `.env.example` to `.env`, set `GNANI_API_KEY` to your own key, and restart. Open the app in a current Chrome or Edge browser and grant microphone access. Localhost works for microphones. A remote host needs HTTPS.

The live path uses Prisma v3 for transcription and Timbre v3 with its Shivani voice for speech. The key stays on the server. If your account only supports an older speech model, set the corresponding model variable in `.env`. For Timbre v2.5, clear `GNANI_TTS_VOICE` so the app can pick a supported voice for each locale. Prisma v2.5 does not use automatic language detection, so select the call's language when using that model. See the [Gnani API quickstart](https://docs.gnani.ai/api/introduction/quick-start).

## Run a sample call

1. Start with order **DD-2048**. Ask in Marathi, “तांदळाच्या बारा पिशव्या करा आणि साखर काढा.” Rice is editable. Sugar has already shipped.
2. Correct the quantity in Hindi, “बारह नहीं, दस कर दो।” The pending change should show ten bags while the order still shows twenty. In live voice mode, try the correction while the agent is speaking.
3. Confirm with “हाँ, कर दीजिए।” The rice line now shows ten bags and the change log has one entry. Sugar stays at eight bags.
4. Use **Reset demo** to restore the fictional order.

The conversation engine uses localized responses and server-side order rules for this workflow. It understands item status, quantity changes, single-line cancellations, corrections, and confirmation. It asks for clarification when a request lacks a usable item or quantity. Each browser session has its own in-memory order and history, which last until reset, server restart, or session expiration.

## Verify

```powershell
npm.cmd test
```

The suite covers 200 original Hindi and Marathi variants, session isolation, confirmation, dispatch-state checks, and mock Gnani audio contracts. To check real speech, use a configured key and try the sample call in a quiet room with headphones. Listen for quantity pronunciation, language changes, and whether a mid-sentence correction stops the previous reply.

The scenario set uses original fictional utterances. For further coverage, [Sierra’s retail benchmark](https://github.com/sierra-research/tau2-bench/tree/main/data/tau2/domains/retail) has simulated support tasks and [Google Taskmaster-1](https://github.com/google-research-datasets/Taskmaster/blob/master/TM-1-2019/README.md) has examples of task-oriented conversation.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the work breakdown.
