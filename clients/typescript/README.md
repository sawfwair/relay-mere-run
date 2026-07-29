# MereRunRelayClient (TypeScript)

Drop-in TypeScript client for the MereRun Relay HTTP API.

## Use

```ts
import {
  MereRunRelayClient,
  type SubmitJobRequest,
  type SubmitVideoRequest,
  type SubmitChatRequest,
  type SubmitAsrRequest,
  type SubmitOcrRequest,
} from './MereRunRelayClient';

const client = new MereRunRelayClient({
  authorization: { scheme: 'bearer', token: '<clerk-jwt>' },
  // baseUrl: 'https://relay.mere.run',
});

const jobRequest: SubmitJobRequest = {
  prompt: 'A cinematic portrait of a fox',
  width: 1024,
  height: 1024,
  direct_image: true,
};

const finalJob = await client.generate(jobRequest, {
  onUpdate: (status) => {
    if (status.progress) {
      console.log(`${status.progress.step}/${status.progress.total_steps}`);
    }
  },
});

const videoRequest: SubmitVideoRequest = {
  prompt: 'A moody cinematic shot of trains in the rain',
  width: 768,
  height: 512,
  direct_image: true,
  model: 'ltxvideo',
};

const finalVideo = await client.video(videoRequest, {
  onUpdate: (status) => {
    if (status.progress) {
      console.log(`${status.progress.step}/${status.progress.total_steps}`);
    }
  },
});

const submitted = await client.submitJob(jobRequest);
const streamedJob = await client.subscribeJobStream(submitted.job_id, {
  onConnected: ({ job_id }) => {
    console.log(`SSE connected for ${job_id}`);
  },
  onUpdate: (status) => {
    if (status.progress) {
      console.log(`stream ${status.progress.step}/${status.progress.total_steps}`);
    }
  },
  onDone: ({ status }) => {
    console.log(`stream done with status ${status}`);
  },
});
console.log(streamedJob.status);

const chatRequest: SubmitChatRequest = {
  messages: [{ role: 'user', content: 'Summarize this image.' }],
};
const finalChat = await client.chat(chatRequest);
console.log(finalChat.response);

const finalTalk = await client.talk({
  text: 'Welcome to mere.run.',
  voice_description: 'A calm British male voice with clear pronunciation',
  direct_audio: true,
});
console.log(finalTalk.result?.audio_data); // base64 WAV when direct_audio=true
await client.cancelTalk(finalTalk.talk_id);

const audio = await fetch('/tmp/speech.wav').then((r) => r.arrayBuffer());
const uploaded = await client.uploadAsrInputAudio(audio, 'audio/wav');
const asrRequest: SubmitAsrRequest = {
  audio_url: uploaded.url,
  task: 'transcribe',
  backend: 'parakeet',
  diarize: true,
};
const finalAsr = await client.asr(asrRequest);
console.log(finalAsr.result?.text);
console.log(finalAsr.result?.speaker_segments);
await client.cancelAsr(finalAsr.asr_id);

const ocrImage = await fetch('/tmp/page.png').then((r) => r.arrayBuffer());
const uploadedImage = await client.uploadOcrInputImage(ocrImage, 'image/png');
const ocrRequest: SubmitOcrRequest = { image_url: uploadedImage.url };
const finalOcr = await client.ocr(ocrRequest);
console.log(finalOcr.result?.text);
await client.cancelOcr(finalOcr.ocr_id);
```

## Notes

- Route prefix is fixed to `/api`.
- Polling stops when terminal status is reached.
- Talk/ASR/OCR polling treats `cancelled` as terminal.
- `subscribeJobStream` consumes SSE from `/job/:job_id/stream` and resolves to final job status.
- Cancel helpers are available for all async targets: `cancelJob`, `cancelTalk`, `cancelAsr`, `cancelOcr`.
- `uploadInputImage` accepts `Uint8Array | ArrayBuffer` for img2img prep.
- `uploadAsrInputAudio` uploads audio for ASR and returns a relay URL.
- ASR `backend` accepts `auto`, `parakeet`, or `qwen`; omitted requests preserve the `auto` default.
- ASR `diarize: true` adds Sortformer speaker intervals when the selected Node has `speech-diarization-sortformer` installed.
- `uploadOcrInputImage` uploads images for OCR and returns a relay URL.
- `talk` supports direct base64 return (`direct_audio`) or URL-based delivery.
- HTTP responses and SSE events are validated in `runtime-contracts.ts`; a
  malformed relay response throws before it reaches polling or callbacks.
