# mere.run Node changelog

## Unreleased

## 0.2.17 - 2026-08-06

- Discover exact operator-approved application companions from the private
  Node plugin registry while continuing to ignore unlisted, relative, missing,
  and invalid entries.

## 0.2.16 - 2026-08-03

- Discover every trusted `mere.run` installation, select the newest binary
  that satisfies the current runtime contract, and show conflicting or legacy
  binaries in the Node UI. Explicit `MERERUN_BIN` pins remain authoritative and
  are never silently overridden.

## 0.2.15 - 2026-07-29

- Route opt-in batch ASR diarization only to Nodes with the native
  `speech-diarization-sortformer` checkpoint installed.
- Run `mere.run speech diarize` after transcription and return validated
  speaker intervals through Relay webhooks and public clients.

## 0.2.14 - 2026-07-28

- Execute Relay OCR requests through installed LightOnOCR or native
  Infinity-Parser2 models with bounded image downloads, typed responses, and
  cooperative cancellation.
- Advertise OCR only when both a supported checkpoint and the public
  `mere.run vision ocr` command are available.
- Normalize batch transcription into one clean transcript with structured
  sentence timestamps, and terminate the child process when Relay cancels ASR.

## 0.2.13 - 2026-07-28

- Advertise Relay Talk whenever a compatible speech synthesis model is
  installed, including on Nodes whose saved preferred-model list predates TTS.

## 0.2.12 - 2026-07-28

- Handle Relay `talk_request` jobs through the installed
  `mere.run speech synthesize` runtime so clients such as AgentsMarkdown can
  read documents aloud.
- Advertise `talk-nano` only when the Qwen3-TTS checkpoint is installed and the
  local `mere.run` binary exposes speech synthesis.
- Return uploaded or inline WAV audio with measured duration and sample rate.
- Cooperatively cancel the TTS child process when Relay cancels a talk or the
  Node supervisor stops.

## 0.2.11 - 2026-07-28

- Advertise installed Parakeet and Qwen live-ASR backends from the local
  `mere.run` runtime.
- Preserve explicit ASR backend selection through Relay, Node, and the
  `mere.run speech transcribe` child process.
- Resolve automatic live streams only to a ready backend and report the
  selected backend in the stream ticket response.
- Keep Node 0.2.10 compatible with Parakeet when `mere.run` 0.24 or newer and
  the Parakeet model are installed.
- Reject Parakeet translation requests before they enter the queue.
