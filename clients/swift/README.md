# MereRunRelayClient (Swift)

Drop-in Swift client for the MereRun Relay HTTP API.

## Use

```swift
import Foundation

let client = MereRunRelayClient(
    config: MereRunRelayClientConfig(
        authorization: .bearer("<clerk-jwt>")
    )
)

let job = try await client.generate(
    MereRunRelaySubmitJobRequest(
        prompt: "A cinematic portrait of a fox",
        width: 1024,
        height: 1024,
        directImage: true
    ),
    onUpdate: { status in
        if let progress = status.progress {
            print("\(progress.step)/\(progress.totalSteps)")
        }
    }
)

let chat = try await client.chat(
    MereRunRelaySubmitChatRequest(
        messages: [MereRunRelayChatMessage(role: .user, content: "Summarize this image.")]
    )
)

print(chat.response ?? "")

let talk = try await client.talk(
    MereRunRelaySubmitTalkRequest(
        text: "Welcome to mere.run.",
        voiceDescription: "A calm British male voice with clear pronunciation",
        directAudio: true
    )
)

print(talk.result?.audioData ?? "")

let audioData = try Data(contentsOf: URL(fileURLWithPath: "/tmp/speech.wav"))
let uploaded = try await client.uploadAsrInputAudio(audioData, contentType: "audio/wav")
let asr = try await client.asr(
    MereRunRelaySubmitAsrRequest(
        audioUrl: uploaded.url,
        task: .transcribe,
        backend: .parakeet
    )
)

print(asr.result?.text ?? "")

let imageData = try Data(contentsOf: URL(fileURLWithPath: "/tmp/page.png"))
let uploadedImage = try await client.uploadOcrInputImage(imageData, contentType: "image/png")
let ocr = try await client.ocr(
    MereRunRelaySubmitOcrRequest(
        imageUrl: uploadedImage.url
    )
)

print(ocr.result?.text ?? "")
```

## Notes

- Route prefix is fixed to `/api`.
- Models use snake_case wire compatibility via JSON key conversion.
- Supports `Bearer` or raw auth header modes.
- Cancel helpers are available for all async targets: `cancelJob`, `cancelTalk`, `cancelAsr`, `cancelOcr`.
- Talk/ASR/OCR polling treats `.cancelled` as terminal.
- `uploadAsrInputAudio` uploads audio for ASR and returns a relay URL.
- ASR `backend` accepts `.auto`, `.parakeet`, or `.qwen`; omitted requests preserve the automatic default.
- `uploadOcrInputImage` uploads images for OCR and returns a relay URL.
- `talk` supports direct base64 return (`directAudio`) or URL-based delivery.
