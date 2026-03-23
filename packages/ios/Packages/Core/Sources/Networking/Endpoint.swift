import Foundation

public struct Endpoint: @unchecked Sendable {
    public let path: String
    public let method: HTTPMethod
    public let body: (any Encodable & Sendable)?
    public let queryItems: [URLQueryItem]?

    public init(
        path: String,
        method: HTTPMethod = .get,
        body: (any Encodable & Sendable)? = nil,
        queryItems: [URLQueryItem]? = nil
    ) {
        self.path = path
        self.method = method
        self.body = body
        self.queryItems = queryItems
    }

    public enum HTTPMethod: String, Sendable {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }
}
