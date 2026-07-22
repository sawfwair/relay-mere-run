# MereRun Relay Client Packs

Drop-in clients for the public MereRun Relay HTTP API (`/api/*`), aligned to the current `src/types.ts` contract.

## Packs

- TypeScript: [`typescript/MereRunRelayClient.ts`](./typescript/MereRunRelayClient.ts)
- Swift: [`swift/MereRunRelayClient.swift`](./swift/MereRunRelayClient.swift)

Both clients are type-checked by the root verification gate. The TypeScript
client also validates HTTP and SSE response payloads at runtime; adding a public
response requires adding its guard in `typescript/runtime-contracts.ts`.

## Standardized API Surface

- `GET /status`
- `POST /generate`
- `GET /job/:job_id`
- `GET /job/:job_id/stream` (SSE)
- `DELETE /job/:job_id`
- `DELETE /job/:job_id/image`
- `POST /input-upload`
- `POST /chat`
- `GET /chat/:chat_id`
- `POST /talk`
- `GET /talk/:talk_id`
- `DELETE /talk/:talk_id`
- `DELETE /talk/:talk_id/audio`
- `POST /asr/input-upload`
- `POST /asr`
- `GET /asr/:asr_id`
- `DELETE /asr/:asr_id`
- `POST /embed`
- `GET /embed/:embed_id`
- `DELETE /embed/:embed_id`
- `POST /ocr/input-upload`
- `POST /ocr`
- `GET /ocr/:ocr_id`
- `DELETE /ocr/:ocr_id`

## Auth Header Modes

- `Bearer <jwt>`

## Status Enums

- Job: `queued | assigned | generating | complete | failed | cancelled`
- Chat: `queued | processing | complete | failed`
- Talk: `queued | processing | complete | failed | cancelled`
- ASR: `queued | processing | complete | failed | cancelled`
- Embed: `queued | processing | complete | failed | cancelled`
- OCR: `queued | processing | complete | failed | cancelled`
- Submission: `assigned | queued`
