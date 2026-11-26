import Foundation
import Security

/// Passwords Apply Desk made for application sites (Workday, iCIMS...), one per
/// site, kept in the login Keychain as internet passwords labeled "Apply Desk:
/// <site>". They never go to the local service or into any file; the Mac app
/// reads one only to sign in on that site.
enum Accounts {
    private static let labelPrefix = "Apply Desk: "

    /// The site an account belongs to: the page's host (a Workday tenant, an iCIMS portal).
    static func site(of url: String) -> String? {
        URLComponents(string: url)?.host?.lowercased()
    }

    /// The saved password for this site and email, if Apply Desk made one.
    static func password(site: String, email: String) -> String? {
        var query = base(site: site, email: email)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// A new strong password for this site, saved before it's used so it's
    /// never lost if the account is made and the app stops right after.
    static func makePassword(site: String, email: String) -> String? {
        if let existing = password(site: site, email: email) { return existing }
        let password = generate()
        var item = base(site: site, email: email)
        item[kSecAttrLabel as String] = labelPrefix + site
        item[kSecAttrComment as String] = "Made by Apply Desk on \(ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate]))"
        item[kSecValueData as String] = Data(password.utf8)
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? password : nil
    }

    /// Sites with a saved Apply Desk password, for Profile.
    static func sites() -> [String] {
        let query: [String: Any] = [kSecClass as String: kSecClassInternetPassword, kSecMatchLimit as String: kSecMatchLimitAll,
                                    kSecReturnAttributes as String: true]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let label = item[kSecAttrLabel as String] as? String, label.hasPrefix(labelPrefix) else { return nil }
            return item[kSecAttrServer as String] as? String
        }.sorted()
    }

    private static func base(site: String, email: String) -> [String: Any] {
        [kSecClass as String: kSecClassInternetPassword, kSecAttrServer as String: site,
         kSecAttrAccount as String: email.lowercased(), kSecAttrProtocol as String: kSecAttrProtocolHTTPS]
    }

    /// 18 characters with upper and lower case letters, digits, and a symbol
    /// most sites accept, so it meets Workday's and other sites' rules.
    private static func generate() -> String {
        let upper = Array("ABCDEFGHJKLMNPQRSTUVWXYZ"), lower = Array("abcdefghijkmnopqrstuvwxyz"), digits = Array("23456789"), symbols = Array("!@#$%*")
        let all = upper + lower + digits + symbols
        func pick(_ set: [Character]) -> Character {
            var byte: UInt32 = 0
            _ = SecRandomCopyBytes(kSecRandomDefault, MemoryLayout<UInt32>.size, &byte)
            return set[Int(byte % UInt32(set.count))]
        }
        var characters = [pick(upper), pick(lower), pick(digits), pick(symbols)] + (0..<14).map { _ in pick(all) }
        for index in characters.indices.reversed() {
            var byte: UInt32 = 0
            _ = SecRandomCopyBytes(kSecRandomDefault, MemoryLayout<UInt32>.size, &byte)
            characters.swapAt(index, Int(byte % UInt32(index + 1)))
        }
        return String(characters)
    }
}
