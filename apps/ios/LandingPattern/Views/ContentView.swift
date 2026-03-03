import Foundation
import LandingPatternCore
import MapKit
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject private var store: LandingStore

    @State private var showImporter = false
    @State private var showExporter = false
    @State private var exportDocument = SnapshotDocument()
    private var t: AppStrings { store.language.strings }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 0) {
                    mapPanel
                        .frame(height: geometry.size.height * 0.52)
                        .clipped()
                    Divider()
                    ScrollView {
                        controls
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(Color(uiColor: .secondarySystemBackground))
                }

                WindLegendView(title: t.windLegendTitle, windLayers: store.windLayers)
                    .padding(.top, 12)
                    .padding(.trailing, 12)
            }
            .ignoresSafeArea(edges: .top)
        }
        .onAppear(perform: chooseDefaultMapStack)
        .fileExporter(
            isPresented: $showExporter,
            document: exportDocument,
            contentType: .json,
            defaultFilename: "landing-pattern-snapshot"
        ) { result in
            switch result {
            case .success:
                store.statusMessage = t.snapshotExported
            case .failure(let error):
                store.statusMessage = t.snapshotExportFailed(error.localizedDescription)
            }
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: [.json]
        ) { result in
            do {
                let url = try result.get()
                let data = try Data(contentsOf: url)
                try store.importSnapshot(from: data)
            } catch {
                store.statusMessage = t.snapshotImportFailed(error.localizedDescription)
            }
        }
    }

    private var mapPanel: some View {
        let output = store.patternOutput
        let basemapStyle: LandingBasemapStyle = store.mapStackChoice == .mapKit ? .appleDefault : .tokenlessSatellite
        return ZStack(alignment: .topLeading) {
            Group {
                switch store.mapStackChoice {
                case .mapKit:
                    MapKitLandingMapView(
                        touchdown: store.touchdown,
                        waypoints: output.waypoints,
                        blocked: output.blocked,
                        hasWarnings: !output.warnings.isEmpty,
                        landingHeadingDeg: store.landingHeadingDeg,
                        basemapStyle: basemapStyle,
                        windLayers: store.windLayers,
                        onTouchdownChange: { coordinate in
                            store.setTouchdown(coordinate)
                        },
                        onHeadingChange: { coordinate in
                            store.setHeadingFromHandle(coordinate)
                        }
                    )
                case .mapbox:
                    MapboxLandingMapView(
                        touchdown: store.touchdown,
                        waypoints: output.waypoints,
                        blocked: output.blocked,
                        hasWarnings: !output.warnings.isEmpty,
                        landingHeadingDeg: store.landingHeadingDeg,
                        basemapStyle: basemapStyle,
                        windLayers: store.windLayers,
                        onTouchdownChange: { coordinate in
                            store.setTouchdown(coordinate)
                        },
                        onHeadingChange: { coordinate in
                            store.setHeadingFromHandle(coordinate)
                        }
                    )
                }
            }

            statusBadge
                .padding(12)
        }
    }

    private var statusBadge: some View {
        let output = store.patternOutput
        let caution = !output.blocked && !output.warnings.isEmpty
        let text = output.blocked ? t.statusBlocked : caution ? t.statusCaution : t.statusValid
        let color = output.blocked ? Color.red.opacity(0.8) : caution ? Color.orange.opacity(0.85) : Color.green.opacity(0.8)
        return Text(text)
            .font(.caption.weight(.semibold))
            .foregroundColor(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color)
            .clipShape(Capsule())
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(t.title)
                .font(.title3.weight(.bold))

            languageSection
            locationSection
            patternSection
            canopySection
            windSection
            outputSection
            ioSection
            mapStackSection
        }
    }

    private var languageSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: t.languageSection)
            Picker(t.languageSection, selection: $store.language) {
                Text(t.languageEnglish).tag(AppLanguage.en)
                Text(t.languageChinese).tag(AppLanguage.zh)
            }
            .pickerStyle(.segmented)
        }
    }

    private var locationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: t.locationSection)
            HStack(spacing: 8) {
                TextField(t.searchPlaceholder, text: $store.locationQuery)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .submitLabel(.search)
                    .onSubmit {
                        Task { await store.searchLocation() }
                    }
                Button(t.searchButton) {
                    Task { await store.searchLocation() }
                }
                .buttonStyle(.borderedProminent)
            }

            if !store.searchResults.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(store.searchResults.prefix(6).enumerated()), id: \.offset) { _, item in
                            Button(item.name ?? "Result") {
                                store.applySearchResult(item)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }

            HStack(spacing: 8) {
                Button(t.fetchWindButton) {
                    Task { await store.fetchAutoWind() }
                }
                .buttonStyle(.borderedProminent)

                Button(t.headwindFinalButton) {
                    store.suggestHeadwindFinal()
                }
                .buttonStyle(.bordered)
            }

            Text("\(t.touchdownLabel): \(formatCoordinate(store.touchdown))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var patternSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: t.patternSection)
            HStack(spacing: 12) {
                Picker(t.sideLabel, selection: $store.side) {
                    Text(t.sideLeft).tag(PatternSide.left)
                    Text(t.sideRight).tag(PatternSide.right)
                }
                .pickerStyle(.segmented)

                Toggle(t.driftBaseToggle, isOn: $store.baseLegDrift)
                    .toggleStyle(.switch)
            }

            NumericInput(title: t.landingHeadingLabel, value: $store.landingHeadingDeg, precision: 1)

            HStack(spacing: 10) {
                NumericInput(title: t.downwindGateLabel, value: gateBinding(0), precision: 0)
                NumericInput(title: t.baseGateLabel, value: gateBinding(1), precision: 0)
            }
            HStack(spacing: 10) {
                NumericInput(title: t.finalGateLabel, value: gateBinding(2), precision: 0)
                NumericInput(title: t.touchdownGateLabel, value: gateBinding(3), precision: 0)
            }
            NumericInput(title: t.shearExponentLabel, value: $store.shearAlpha, precision: 2)
        }
    }

    private var canopySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: t.canopySection)

            Picker(t.presetLabel, selection: Binding(
                get: { store.canopy.model },
                set: { store.applyPreset(model: $0) }
            )) {
                ForEach(canopyPresets, id: \.model) { preset in
                    Text(preset.model).tag(preset.model)
                }
            }
            .pickerStyle(.menu)

            HStack(spacing: 10) {
                NumericInput(title: t.canopySizeLabel, value: canopyBinding(\.sizeSqft), precision: 0)
                NumericInput(title: t.exitWeightLabel, value: $store.exitWeightLb, precision: 0)
            }
            HStack(spacing: 10) {
                NumericInput(title: t.airspeedRefLabel, value: canopyBinding(\.airspeedRefKt), precision: 1)
                NumericInput(title: t.wlRefLabel, value: canopyBinding(\.wlRef), precision: 2)
            }
            HStack(spacing: 10) {
                NumericInput(title: t.glideRatioLabel, value: canopyBinding(\.glideRatio), precision: 2)
                NumericInput(title: t.wlExponentLabel, value: canopyBindingOptional(\.airspeedWlExponent, defaultValue: 0.5), precision: 2)
            }
            HStack(spacing: 10) {
                NumericInput(title: t.airspeedMinLabel, value: canopyBindingOptional(\.airspeedMinKt, defaultValue: 8), precision: 1)
                NumericInput(title: t.airspeedMaxLabel, value: canopyBindingOptional(\.airspeedMaxKt, defaultValue: 35), precision: 1)
            }

            let wl = store.patternOutput.metrics.wingLoading
            let speed = store.patternOutput.metrics.estAirspeedKt
            Text(t.currentWlSummary(wl, speed))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var windSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: t.windLayersSection)
            ForEach(Array(store.windLayers.enumerated()), id: \.offset) { index, layer in
                HStack(spacing: 8) {
                    NumericInput(
                        title: t.windAltLabel,
                        value: Binding(
                            get: { store.windLayers[index].altitudeFt },
                            set: { newValue in
                                store.updateWindLayer(index: index) { $0.altitudeFt = newValue }
                            }
                        ),
                        precision: 0
                    )
                    NumericInput(
                        title: t.windSpeedLabel,
                        value: Binding(
                            get: { store.windLayers[index].speedKt },
                            set: { newValue in
                                store.updateWindLayer(index: index) { $0.speedKt = max(0, newValue) }
                            }
                        ),
                        precision: 1
                    )
                    NumericInput(
                        title: t.windFromLabel,
                        value: Binding(
                            get: { store.windLayers[index].dirFromDeg },
                            set: { newValue in
                                store.updateWindLayer(index: index) { $0.dirFromDeg = normalizeHeading(newValue) }
                            }
                        ),
                        precision: 0
                    )
                }
                .padding(10)
                .background(Color(uiColor: .tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))

                if index == 0 || index == 1 || index == 2 {
                    Divider()
                }
            }
        }
    }

    private var outputSection: some View {
        let output = store.patternOutput
        return VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: t.outputsSection)
            Text(String(format: "\(t.wingLoadingLabel): %.2f", output.metrics.wingLoading))
            Text(String(format: "\(t.estAirspeedLabel): %.1f kt", output.metrics.estAirspeedKt))
            Text(String(format: "\(t.estSinkLabel): %.2f ft/s", output.metrics.estSinkFps))

            if output.warnings.isEmpty {
                Text(t.noWarnings)
                    .foregroundStyle(.green)
            } else {
                ForEach(output.warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.footnote)
                }
            }

            if !output.segments.isEmpty {
                ForEach(output.segments, id: \.name) { segment in
                    HStack {
                        Text(localizedSegmentName(segment.name))
                            .fontWeight(.semibold)
                        Spacer()
                        Text(String(format: "%.0f deg, %.1f kt, %.0f ft", segment.trackHeadingDeg, segment.groundSpeedKt, segment.distanceFt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Text(store.statusMessage)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
    }

    private var ioSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: t.importExportSection)
            HStack(spacing: 10) {
                Button(t.exportSnapshotButton) {
                    do {
                        exportDocument = SnapshotDocument(data: try store.exportSnapshot())
                        showExporter = true
                    } catch {
                        store.statusMessage = t.snapshotExportFailed(error.localizedDescription)
                    }
                }
                .buttonStyle(.borderedProminent)

                Button(t.importSnapshotButton) {
                    showImporter = true
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var mapStackSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: t.mapStackSection)
            Picker(t.mapStackSection, selection: $store.mapStackChoice) {
                ForEach(MapStackChoice.allCases) { choice in
                    Text(choice.title).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            Text(t.mapStackTokenless)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func chooseDefaultMapStack() {
        // Preserve persisted map choice; store default remains MapKit.
    }

    private func gateBinding(_ index: Int) -> Binding<Double> {
        Binding(
            get: { store.gatesFt.indices.contains(index) ? store.gatesFt[index] : 0 },
            set: { newValue in
                guard store.gatesFt.indices.contains(index) else { return }
                store.gatesFt[index] = newValue
            }
        )
    }

    private func canopyBinding(_ keyPath: WritableKeyPath<CanopyProfile, Double>) -> Binding<Double> {
        Binding(
            get: { store.canopy[keyPath: keyPath] },
            set: { newValue in
                store.canopy[keyPath: keyPath] = newValue
            }
        )
    }

    private func canopyBindingOptional(_ keyPath: WritableKeyPath<CanopyProfile, Double?>, defaultValue: Double) -> Binding<Double> {
        Binding(
            get: { store.canopy[keyPath: keyPath] ?? defaultValue },
            set: { newValue in
                store.canopy[keyPath: keyPath] = newValue
            }
        )
    }

    private func formatCoordinate(_ coordinate: CLLocationCoordinate2D) -> String {
        String(format: "%.5f, %.5f", coordinate.latitude, coordinate.longitude)
    }

    private func localizedSegmentName(_ name: SegmentName) -> String {
        switch (store.language, name) {
        case (.zh, .downwind):
            return "第一边"
        case (.zh, .base):
            return "第二边"
        case (.zh, .final):
            return "第三边"
        case (_, .downwind):
            return "Downwind"
        case (_, .base):
            return "Base"
        case (_, .final):
            return "Final"
        }
    }
}

private struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.headline)
    }
}

private struct WindLegendView: View {
    let title: String
    let windLayers: [WindLayer]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "wind")
                    .font(.caption.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.semibold))
            }
            ForEach(Array(windLayers.sorted(by: { $0.altitudeFt > $1.altitudeFt }).enumerated()), id: \.offset) { _, layer in
                HStack(spacing: 8) {
                    Text(String(format: "%.0fft", layer.altitudeFt))
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.18))
                        .clipShape(Capsule())
                    Text(String(format: "%.1fkt from %.0fdeg", layer.speedKt, layer.dirFromDeg))
                        .font(.caption2.monospacedDigit())
                }
            }
        }
        .padding(11)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.3), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 3)
    }
}

private struct NumericInput: View {
    let title: String
    @Binding var value: Double
    let precision: Int

    @State private var text: String
    @FocusState private var isFocused: Bool

    init(title: String, value: Binding<Double>, precision: Int) {
        self.title = title
        _value = value
        self.precision = precision
        _text = State(initialValue: Self.format(value.wrappedValue, precision: precision))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("", text: $text)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.decimalPad)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .focused($isFocused)
                .onChange(of: text) { _, newValue in
                    parse(newValue)
                }
                .onChange(of: value) { _, newValue in
                    guard !isFocused else { return }
                    text = Self.format(newValue, precision: precision)
                }
                .onChange(of: isFocused) { _, nowFocused in
                    if !nowFocused {
                        commitOrRevert()
                    }
                }
                .submitLabel(.done)
                .onSubmit {
                    commitOrRevert()
                }
        }
    }

    private func parse(_ text: String) {
        let normalized = text.replacingOccurrences(of: ",", with: ".")
        if normalized.isEmpty || normalized == "." || normalized == "-" || normalized == "-." {
            return
        }
        if let parsed = Double(normalized), parsed.isFinite {
            value = parsed
        }
    }

    private func commitOrRevert() {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        if let parsed = Double(normalized), parsed.isFinite {
            value = parsed
            text = Self.format(parsed, precision: precision)
        } else {
            text = Self.format(value, precision: precision)
        }
    }

    private static func format(_ value: Double, precision: Int) -> String {
        String(format: "%.\(max(0, precision))f", value)
    }
}
