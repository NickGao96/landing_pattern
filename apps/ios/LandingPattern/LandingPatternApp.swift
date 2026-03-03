import SwiftUI

@main
struct LandingPatternApp: App {
    @StateObject private var store = LandingStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}
