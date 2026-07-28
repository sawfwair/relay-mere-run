# mere.run Node changelog

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
