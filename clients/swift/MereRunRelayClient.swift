import Foundation

public let defaultMereRunRelayBaseURL = URL(string: "https://relay.mere.run")!

public enum MereRunRelayAuthorization: Sendable {
    case bearer(String)
    case header(String)

    var headerValue: String {
        switch self {
        case .bearer(let token):
            return "Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))"
        case .header(let value):
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

public struct MereRunRelayClientConfig: Sendable {
    public var baseURL: URL
    public var authorization: MereRunRelayAuthorization
    public var timeout: TimeInterval

    public init(
        baseURL: URL = defaultMereRunRelayBaseURL,
        authorization: MereRunRelayAuthorization,
        timeout: TimeInterval = 120
    ) {
        self.baseURL = baseURL
        self.authorization = authorization
        self.timeout = timeout
    }
}

public enum MereRunRelaySubmissionStatus: String, Codable, Sendable {
    case assigned
    case queued
}

public enum MereRunRelayAgentStatus: String, Codable, Sendable {
    case online
    case busy
    case offline
}

public enum MereRunRelayJobStatus: String, Codable, Sendable {
    case queued
    case assigned
    case generating
    case complete
    case failed
    case cancelled
}

public enum MereRunRelayChatStatus: String, Codable, Sendable {
    case queued
    case processing
    case complete
    case failed
}

public enum MereRunRelayTalkStatus: String, Codable, Sendable {
    case queued
    case processing
    case complete
    case failed
    case cancelled
}

public enum MereRunRelayAsrTask: String, Codable, Sendable {
    case transcribe
    case translate
}

public enum MereRunRelayAsrBackend: String, Codable, Sendable {
    case auto
    case parakeet
    case qwen
}

public enum MereRunRelayAsrStatus: String, Codable, Sendable {
    case queued
    case processing
    case complete
    case failed
    case cancelled
}

public enum MereRunRelayEmbedStatus: String, Codable, Sendable {
    case queued
    case processing
    case complete
    case failed
    case cancelled
}

public enum MereRunRelayOcrStatus: String, Codable, Sendable {
    case queued
    case processing
    case complete
    case failed
    case cancelled
}

public enum MereRunRelayRole: String, Codable, Sendable {
    case system
    case user
    case assistant
}

public struct MereRunRelayAgentCapabilities: Codable, Sendable {
    public let models: [String]
    public let maxResolution: Int
    public let controlnet: Bool
    public let lora: Bool
    public let img2img: Bool
}

public struct MereRunRelayAgentSnapshot: Codable, Sendable {
    public let agentId: String
    public let deviceName: String
    public let status: MereRunRelayAgentStatus
    public let lastSeen: String
    public let currentJobId: String?
    public let capabilities: MereRunRelayAgentCapabilities
}

public struct MereRunRelayStatusResponse: Codable, Sendable {
    public let agents: [MereRunRelayAgentSnapshot]
    public let queueDepth: Int
}

public struct MereRunRelaySubmitJobRequest: Codable, Sendable {
    public var prompt: String
    public var negativePrompt: String?
    public var width: Int?
    public var height: Int?
    public var steps: Int?
    public var seed: Int?
    public var inputImageUrl: String?
    public var inputImageData: String?
    public var inputStrength: Double?
    public var agentId: String?
    public var webhookUrl: String?
    public var directImage: Bool?

    public init(
        prompt: String,
        negativePrompt: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        steps: Int? = nil,
        seed: Int? = nil,
        inputImageUrl: String? = nil,
        inputImageData: String? = nil,
        inputStrength: Double? = nil,
        agentId: String? = nil,
        webhookUrl: String? = nil,
        directImage: Bool? = nil
    ) {
        self.prompt = prompt
        self.negativePrompt = negativePrompt
        self.width = width
        self.height = height
        self.steps = steps
        self.seed = seed
        self.inputImageUrl = inputImageUrl
        self.inputImageData = inputImageData
        self.inputStrength = inputStrength
        self.agentId = agentId
        self.webhookUrl = webhookUrl
        self.directImage = directImage
    }
}

public struct MereRunRelaySubmitJobResponse: Codable, Sendable {
    public let jobId: String
    public let status: MereRunRelaySubmissionStatus
    public let agentId: String?
    public let position: Int?
    public let estimatedTimeMs: Int
}

public struct MereRunRelayJobRequest: Codable, Sendable {
    public let prompt: String
    public let negativePrompt: String?
    public let width: Int
    public let height: Int
    public let steps: Int
    public let seed: Int?
    public let inputImageUrl: String?
    public let inputImageData: String?
    public let inputStrength: Double?
}

public struct MereRunRelayJobProgress: Codable, Sendable {
    public let step: Int
    public let totalSteps: Int
}

public struct MereRunRelayJobResult: Codable, Sendable {
    public let imageUrl: String?
    public let imageData: String?
    public let seed: Int
    public let generationTimeMs: Int
}

public struct MereRunRelayJobStatusResponse: Codable, Sendable {
    public let jobId: String
    public let userId: String
    public let clientId: String
    public let agentId: String?
    public let status: MereRunRelayJobStatus
    public let request: MereRunRelayJobRequest
    public let progress: MereRunRelayJobProgress?
    public let result: MereRunRelayJobResult?
    public let error: String?
    public let createdAt: String
    public let assignedAt: String?
    public let startedAt: String?
    public let completedAt: String?
    public let directImage: Bool
}

public struct MereRunRelayChatMessage: Codable, Sendable {
    public let role: MereRunRelayRole
    public let content: String
    public let imageUrl: String?

    public init(role: MereRunRelayRole, content: String, imageUrl: String? = nil) {
        self.role = role
        self.content = content
        self.imageUrl = imageUrl
    }
}

public struct MereRunRelaySubmitChatRequest: Codable, Sendable {
    public var messages: [MereRunRelayChatMessage]
    public var maxTokens: Int?
    public var temperature: Double?
    public var requiresJson: Bool?
    public var useLora: Bool?
    public var model: String?

    public init(
        messages: [MereRunRelayChatMessage],
        maxTokens: Int? = nil,
        temperature: Double? = nil,
        requiresJson: Bool? = nil,
        useLora: Bool? = nil,
        model: String? = nil
    ) {
        self.messages = messages
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.requiresJson = requiresJson
        self.useLora = useLora
        self.model = model
    }
}

public struct MereRunRelaySubmitChatResponse: Codable, Sendable {
    public let chatId: String
    public let status: MereRunRelaySubmissionStatus
    public let agentId: String?
    public let position: Int?
}

public struct MereRunRelayChatStatusResponse: Codable, Sendable {
    public let chatId: String
    public let userId: String
    public let clientId: String
    public let agentId: String?
    public let status: MereRunRelayChatStatus
    public let messages: [MereRunRelayChatMessage]
    public let response: String?
    public let tokensGenerated: Int?
    public let error: String?
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
}

public struct MereRunRelaySubmitTalkRequest: Codable, Sendable {
    public var text: String
    public var voiceDescription: String?
    public var speed: Double?
    public var temperature: Double?
    public var outputFormat: String?
    public var directAudio: Bool?

    public init(
        text: String,
        voiceDescription: String? = nil,
        speed: Double? = nil,
        temperature: Double? = nil,
        outputFormat: String? = "wav",
        directAudio: Bool? = nil
    ) {
        self.text = text
        self.voiceDescription = voiceDescription
        self.speed = speed
        self.temperature = temperature
        self.outputFormat = outputFormat
        self.directAudio = directAudio
    }
}

public struct MereRunRelaySubmitTalkResponse: Codable, Sendable {
    public let talkId: String
    public let status: MereRunRelaySubmissionStatus
    public let agentId: String?
    public let position: Int?
}

public struct MereRunRelayTalkRequestPayload: Codable, Sendable {
    public let text: String
    public let voiceDescription: String?
    public let speed: Double
    public let temperature: Double
    public let outputFormat: String
}

public struct MereRunRelayTalkResult: Codable, Sendable {
    public let audioUrl: String?
    public let audioData: String?
    public let durationSeconds: Double
    public let sampleRate: Int
    public let outputFormat: String
}

public struct MereRunRelayTalkStatusResponse: Codable, Sendable {
    public let talkId: String
    public let userId: String
    public let clientId: String
    public let agentId: String?
    public let status: MereRunRelayTalkStatus
    public let request: MereRunRelayTalkRequestPayload
    public let result: MereRunRelayTalkResult?
    public let error: String?
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
    public let directAudio: Bool
}

public struct MereRunRelaySubmitAsrRequest: Codable, Sendable {
    public var audioUrl: String
    public var language: String?
    public var task: MereRunRelayAsrTask?
    public var backend: MereRunRelayAsrBackend?
    public var maxTokens: Int?

    public init(
        audioUrl: String,
        language: String? = nil,
        task: MereRunRelayAsrTask? = .transcribe,
        backend: MereRunRelayAsrBackend? = nil,
        maxTokens: Int? = nil
    ) {
        self.audioUrl = audioUrl
        self.language = language
        self.task = task
        self.backend = backend
        self.maxTokens = maxTokens
    }
}

public struct MereRunRelaySubmitAsrResponse: Codable, Sendable {
    public let asrId: String
    public let status: MereRunRelaySubmissionStatus
    public let agentId: String?
    public let position: Int?
}

public struct MereRunRelayAsrRequestPayload: Codable, Sendable {
    public let audioUrl: String
    public let language: String?
    public let task: MereRunRelayAsrTask
    public let backend: MereRunRelayAsrBackend?
    public let maxTokens: Int
}

public struct MereRunRelayAsrResult: Codable, Sendable {
    public let text: String
    public let language: String?
    public let durationSeconds: Double
}

public struct MereRunRelayAsrStatusResponse: Codable, Sendable {
    public let asrId: String
    public let userId: String
    public let clientId: String
    public let agentId: String?
    public let status: MereRunRelayAsrStatus
    public let request: MereRunRelayAsrRequestPayload
    public let result: MereRunRelayAsrResult?
    public let error: String?
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
}

public struct MereRunRelaySubmitEmbedRequest: Codable, Sendable {
    public var texts: [String]
    public var model: String?
    public var maxTokens: Int?

    public init(
        texts: [String],
        model: String? = nil,
        maxTokens: Int? = nil
    ) {
        self.texts = texts
        self.model = model
        self.maxTokens = maxTokens
    }
}

public struct MereRunRelaySubmitEmbedResponse: Codable, Sendable {
    public let embedId: String
    public let status: MereRunRelaySubmissionStatus
    public let agentId: String?
    public let position: Int?
}

public struct MereRunRelayEmbedRequestPayload: Codable, Sendable {
    public let texts: [String]
    public let model: String
    public let maxTokens: Int
}

public struct MereRunRelayEmbedDataRow: Codable, Sendable {
    public let index: Int
    public let embedding: [Double]
}

public struct MereRunRelayEmbedResult: Codable, Sendable {
    public let model: String
    public let dimensions: Int
    public let data: [MereRunRelayEmbedDataRow]
}

public struct MereRunRelayEmbedStatusResponse: Codable, Sendable {
    public let embedId: String
    public let userId: String
    public let clientId: String
    public let agentId: String?
    public let status: MereRunRelayEmbedStatus
    public let request: MereRunRelayEmbedRequestPayload
    public let result: MereRunRelayEmbedResult?
    public let error: String?
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
}

public struct MereRunRelaySubmitOcrRequest: Codable, Sendable {
    public var imageUrl: String
    public var maxTokens: Int?
    public var temperature: Double?

    public init(
        imageUrl: String,
        maxTokens: Int? = nil,
        temperature: Double? = nil
    ) {
        self.imageUrl = imageUrl
        self.maxTokens = maxTokens
        self.temperature = temperature
    }
}

public struct MereRunRelaySubmitOcrResponse: Codable, Sendable {
    public let ocrId: String
    public let status: MereRunRelaySubmissionStatus
    public let agentId: String?
    public let position: Int?
}

public struct MereRunRelayOcrRequestPayload: Codable, Sendable {
    public let imageUrl: String
    public let maxTokens: Int
    public let temperature: Double
}

public struct MereRunRelayOcrResult: Codable, Sendable {
    public let text: String
    public let tokensGenerated: Int
}

public struct MereRunRelayOcrStatusResponse: Codable, Sendable {
    public let ocrId: String
    public let userId: String
    public let clientId: String
    public let agentId: String?
    public let status: MereRunRelayOcrStatus
    public let request: MereRunRelayOcrRequestPayload
    public let result: MereRunRelayOcrResult?
    public let error: String?
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
}

public struct MereRunRelayCancelResponse: Codable, Sendable {
    public let cancelled: Bool
}

public struct MereRunRelayDeleteImageResponse: Codable, Sendable {
    public let deleted: Bool
}

public struct MereRunRelayDeleteTalkAudioResponse: Codable, Sendable {
    public let deleted: Bool
}

public struct MereRunRelayInputUploadResponse: Codable, Sendable {
    public let url: String
}

public struct MereRunRelayAsrInputUploadResponse: Codable, Sendable {
    public let url: String
}

public struct MereRunRelayOcrInputUploadResponse: Codable, Sendable {
    public let url: String
}

public enum MereRunRelayClientError: LocalizedError, Sendable {
    case invalidResponse
    case pollTimeout(resource: String, id: String, timeout: TimeInterval)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from relay"
        case let .pollTimeout(resource, id, timeout):
            return "Polling timed out for \(resource) \(id) after \(Int(timeout))s"
        }
    }
}

public struct MereRunRelayAPIError: LocalizedError, Sendable {
    public let statusCode: Int
    public let message: String
    public let code: String?

    public init(statusCode: Int, message: String, code: String? = nil) {
        self.statusCode = statusCode
        self.message = message
        self.code = code
    }

    public var errorDescription: String? {
        if let code {
            return "\(message) (\(code), HTTP \(statusCode))"
        }
        return "\(message) (HTTP \(statusCode))"
    }
}

public final class MereRunRelayClient {
    private let config: MereRunRelayClientConfig
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(config: MereRunRelayClientConfig, session: URLSession? = nil) {
        self.config = config

        if let session {
            self.session = session
        } else {
            let urlConfig = URLSessionConfiguration.default
            urlConfig.timeoutIntervalForRequest = config.timeout
            urlConfig.timeoutIntervalForResource = config.timeout
            self.session = URLSession(configuration: urlConfig)
        }

        self.encoder = JSONEncoder()
        self.encoder.keyEncodingStrategy = .convertToSnakeCase

        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .convertFromSnakeCase
    }

    public func getStatus() async throws -> MereRunRelayStatusResponse {
        try await performRequest(path: "/status", method: "GET", responseType: MereRunRelayStatusResponse.self)
    }

    public func submitJob(_ request: MereRunRelaySubmitJobRequest) async throws -> MereRunRelaySubmitJobResponse {
        let body = try encoder.encode(request)
        return try await performRequest(
            path: "/generate",
            method: "POST",
            body: body,
            responseType: MereRunRelaySubmitJobResponse.self
        )
    }

    public func getJob(jobId: String) async throws -> MereRunRelayJobStatusResponse {
        let encoded = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        return try await performRequest(path: "/job/\(encoded)", method: "GET", responseType: MereRunRelayJobStatusResponse.self)
    }

    public func cancelJob(jobId: String) async throws -> MereRunRelayCancelResponse {
        let encoded = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        return try await performRequest(path: "/job/\(encoded)", method: "DELETE", responseType: MereRunRelayCancelResponse.self)
    }

    public func deleteJobImage(jobId: String) async throws -> MereRunRelayDeleteImageResponse {
        let encoded = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        return try await performRequest(
            path: "/job/\(encoded)/image",
            method: "DELETE",
            responseType: MereRunRelayDeleteImageResponse.self
        )
    }

    public func uploadInputImage(
        _ imageData: Data,
        contentType: String = "image/jpeg"
    ) async throws -> MereRunRelayInputUploadResponse {
        try await performRequest(
            path: "/input-upload",
            method: "POST",
            body: imageData,
            contentType: contentType,
            responseType: MereRunRelayInputUploadResponse.self
        )
    }

    public func uploadAsrInputAudio(
        _ audioData: Data,
        contentType: String = "audio/wav"
    ) async throws -> MereRunRelayAsrInputUploadResponse {
        try await performRequest(
            path: "/asr/input-upload",
            method: "POST",
            body: audioData,
            contentType: contentType,
            responseType: MereRunRelayAsrInputUploadResponse.self
        )
    }

    public func uploadOcrInputImage(
        _ imageData: Data,
        contentType: String = "image/jpeg"
    ) async throws -> MereRunRelayOcrInputUploadResponse {
        try await performRequest(
            path: "/ocr/input-upload",
            method: "POST",
            body: imageData,
            contentType: contentType,
            responseType: MereRunRelayOcrInputUploadResponse.self
        )
    }

    public func pollJob(
        jobId: String,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayJobStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayJobStatusResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let delay = max(interval, 0.1)

        while Date() <= deadline {
            let status = try await getJob(jobId: jobId)
            onUpdate?(status)

            if status.status == .complete || status.status == .failed || status.status == .cancelled {
                return status
            }

            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }

        throw MereRunRelayClientError.pollTimeout(resource: "job", id: jobId, timeout: timeout)
    }

    public func generate(
        _ request: MereRunRelaySubmitJobRequest,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayJobStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayJobStatusResponse {
        let submission = try await submitJob(request)
        return try await pollJob(
            jobId: submission.jobId,
            timeout: timeout,
            interval: interval,
            onUpdate: onUpdate
        )
    }

    public func submitChat(_ request: MereRunRelaySubmitChatRequest) async throws -> MereRunRelaySubmitChatResponse {
        let body = try encoder.encode(request)
        return try await performRequest(
            path: "/chat",
            method: "POST",
            body: body,
            responseType: MereRunRelaySubmitChatResponse.self
        )
    }

    public func getChat(chatId: String) async throws -> MereRunRelayChatStatusResponse {
        let encoded = chatId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? chatId
        return try await performRequest(path: "/chat/\(encoded)", method: "GET", responseType: MereRunRelayChatStatusResponse.self)
    }

    public func pollChat(
        chatId: String,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayChatStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayChatStatusResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let delay = max(interval, 0.1)

        while Date() <= deadline {
            let status = try await getChat(chatId: chatId)
            onUpdate?(status)

            if status.status == .complete || status.status == .failed {
                return status
            }

            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }

        throw MereRunRelayClientError.pollTimeout(resource: "chat", id: chatId, timeout: timeout)
    }

    public func chat(
        _ request: MereRunRelaySubmitChatRequest,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayChatStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayChatStatusResponse {
        let submission = try await submitChat(request)
        return try await pollChat(
            chatId: submission.chatId,
            timeout: timeout,
            interval: interval,
            onUpdate: onUpdate
        )
    }

    public func submitTalk(_ request: MereRunRelaySubmitTalkRequest) async throws -> MereRunRelaySubmitTalkResponse {
        let body = try encoder.encode(request)
        return try await performRequest(
            path: "/talk",
            method: "POST",
            body: body,
            responseType: MereRunRelaySubmitTalkResponse.self
        )
    }

    public func getTalk(talkId: String) async throws -> MereRunRelayTalkStatusResponse {
        let encoded = talkId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? talkId
        return try await performRequest(path: "/talk/\(encoded)", method: "GET", responseType: MereRunRelayTalkStatusResponse.self)
    }

    public func deleteTalkAudio(talkId: String) async throws -> MereRunRelayDeleteTalkAudioResponse {
        let encoded = talkId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? talkId
        return try await performRequest(
            path: "/talk/\(encoded)/audio",
            method: "DELETE",
            responseType: MereRunRelayDeleteTalkAudioResponse.self
        )
    }

    public func cancelTalk(talkId: String) async throws -> MereRunRelayCancelResponse {
        let encoded = talkId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? talkId
        return try await performRequest(path: "/talk/\(encoded)", method: "DELETE", responseType: MereRunRelayCancelResponse.self)
    }

    public func pollTalk(
        talkId: String,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayTalkStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayTalkStatusResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let delay = max(interval, 0.1)

        while Date() <= deadline {
            let status = try await getTalk(talkId: talkId)
            onUpdate?(status)

            if status.status == .complete || status.status == .failed || status.status == .cancelled {
                return status
            }

            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }

        throw MereRunRelayClientError.pollTimeout(resource: "talk", id: talkId, timeout: timeout)
    }

    public func talk(
        _ request: MereRunRelaySubmitTalkRequest,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayTalkStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayTalkStatusResponse {
        let submission = try await submitTalk(request)
        return try await pollTalk(
            talkId: submission.talkId,
            timeout: timeout,
            interval: interval,
            onUpdate: onUpdate
        )
    }

    public func submitAsr(_ request: MereRunRelaySubmitAsrRequest) async throws -> MereRunRelaySubmitAsrResponse {
        let body = try encoder.encode(request)
        return try await performRequest(
            path: "/asr",
            method: "POST",
            body: body,
            responseType: MereRunRelaySubmitAsrResponse.self
        )
    }

    public func getAsr(asrId: String) async throws -> MereRunRelayAsrStatusResponse {
        let encoded = asrId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? asrId
        return try await performRequest(path: "/asr/\(encoded)", method: "GET", responseType: MereRunRelayAsrStatusResponse.self)
    }

    public func cancelAsr(asrId: String) async throws -> MereRunRelayCancelResponse {
        let encoded = asrId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? asrId
        return try await performRequest(path: "/asr/\(encoded)", method: "DELETE", responseType: MereRunRelayCancelResponse.self)
    }

    public func pollAsr(
        asrId: String,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayAsrStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayAsrStatusResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let delay = max(interval, 0.1)

        while Date() <= deadline {
            let status = try await getAsr(asrId: asrId)
            onUpdate?(status)

            if status.status == .complete || status.status == .failed || status.status == .cancelled {
                return status
            }

            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }

        throw MereRunRelayClientError.pollTimeout(resource: "asr", id: asrId, timeout: timeout)
    }

    public func asr(
        _ request: MereRunRelaySubmitAsrRequest,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayAsrStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayAsrStatusResponse {
        let submission = try await submitAsr(request)
        return try await pollAsr(
            asrId: submission.asrId,
            timeout: timeout,
            interval: interval,
            onUpdate: onUpdate
        )
    }

    public func submitEmbed(_ request: MereRunRelaySubmitEmbedRequest) async throws -> MereRunRelaySubmitEmbedResponse {
        let body = try encoder.encode(request)
        return try await performRequest(
            path: "/embed",
            method: "POST",
            body: body,
            responseType: MereRunRelaySubmitEmbedResponse.self
        )
    }

    public func getEmbed(embedId: String) async throws -> MereRunRelayEmbedStatusResponse {
        let encoded = embedId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? embedId
        return try await performRequest(path: "/embed/\(encoded)", method: "GET", responseType: MereRunRelayEmbedStatusResponse.self)
    }

    public func cancelEmbed(embedId: String) async throws -> MereRunRelayCancelResponse {
        let encoded = embedId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? embedId
        return try await performRequest(path: "/embed/\(encoded)", method: "DELETE", responseType: MereRunRelayCancelResponse.self)
    }

    public func pollEmbed(
        embedId: String,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayEmbedStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayEmbedStatusResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let delay = max(interval, 0.1)

        while Date() <= deadline {
            let status = try await getEmbed(embedId: embedId)
            onUpdate?(status)

            if status.status == .complete || status.status == .failed || status.status == .cancelled {
                return status
            }

            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }

        throw MereRunRelayClientError.pollTimeout(resource: "embed", id: embedId, timeout: timeout)
    }

    public func embed(
        _ request: MereRunRelaySubmitEmbedRequest,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayEmbedStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayEmbedStatusResponse {
        let submission = try await submitEmbed(request)
        return try await pollEmbed(
            embedId: submission.embedId,
            timeout: timeout,
            interval: interval,
            onUpdate: onUpdate
        )
    }

    public func submitOcr(_ request: MereRunRelaySubmitOcrRequest) async throws -> MereRunRelaySubmitOcrResponse {
        let body = try encoder.encode(request)
        return try await performRequest(
            path: "/ocr",
            method: "POST",
            body: body,
            responseType: MereRunRelaySubmitOcrResponse.self
        )
    }

    public func getOcr(ocrId: String) async throws -> MereRunRelayOcrStatusResponse {
        let encoded = ocrId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ocrId
        return try await performRequest(path: "/ocr/\(encoded)", method: "GET", responseType: MereRunRelayOcrStatusResponse.self)
    }

    public func cancelOcr(ocrId: String) async throws -> MereRunRelayCancelResponse {
        let encoded = ocrId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ocrId
        return try await performRequest(path: "/ocr/\(encoded)", method: "DELETE", responseType: MereRunRelayCancelResponse.self)
    }

    public func pollOcr(
        ocrId: String,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayOcrStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayOcrStatusResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let delay = max(interval, 0.1)

        while Date() <= deadline {
            let status = try await getOcr(ocrId: ocrId)
            onUpdate?(status)

            if status.status == .complete || status.status == .failed || status.status == .cancelled {
                return status
            }

            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }

        throw MereRunRelayClientError.pollTimeout(resource: "ocr", id: ocrId, timeout: timeout)
    }

    public func ocr(
        _ request: MereRunRelaySubmitOcrRequest,
        timeout: TimeInterval = 120,
        interval: TimeInterval = 1,
        onUpdate: ((MereRunRelayOcrStatusResponse) -> Void)? = nil
    ) async throws -> MereRunRelayOcrStatusResponse {
        let submission = try await submitOcr(request)
        return try await pollOcr(
            ocrId: submission.ocrId,
            timeout: timeout,
            interval: interval,
            onUpdate: onUpdate
        )
    }

    private func makeRequest(
        path: String,
        method: String,
        body: Data?,
        contentType: String?
    ) -> URLRequest {
        let base = config.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let url = URL(string: "\(base)/api\(path)")!
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(config.authorization.headerValue, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            if let contentType {
                request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            }
        }
        return request
    }

    private func performRequest<T: Decodable>(
        path: String,
        method: String,
        body: Data? = nil,
        contentType: String? = "application/json",
        responseType: T.Type
    ) async throws -> T {
        let request = makeRequest(path: path, method: method, body: body, contentType: contentType)
        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MereRunRelayClientError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw parseAPIError(statusCode: httpResponse.statusCode, data: data)
        }

        return try decoder.decode(T.self, from: data)
    }

    private func parseAPIError(statusCode: Int, data: Data) -> MereRunRelayAPIError {
        let payload = try? decoder.decode(MereRunRelayErrorPayload.self, from: data)
        let message = payload?.error ?? "Request failed"
        return MereRunRelayAPIError(statusCode: statusCode, message: message, code: payload?.code)
    }
}

private struct MereRunRelayErrorPayload: Codable {
    let error: String?
    let code: String?
}
